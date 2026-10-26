"""The «Я» store: skills, their versions and the agents' edits, kept in :class:`~.vault.MeVault`.

All reads come from one decrypted copy in memory; every change is written through at once (one small
encrypted file). Thread-safe: callers run it off the event loop (``disk_call``).
"""
from __future__ import annotations

import re
import threading
import unicodedata
from collections.abc import Callable
from typing import Any, cast

from ..ids import new_id, utc_now
from . import (
    BUILTIN_IDS,
    BUILTINS,
    DESCRIPTION_MAX,
    MAX_EDITS,
    MAX_SKILLS,
    MAX_TOMBSTONES,
    MAX_VERSIONS,
    SKILL_CAP,
    TITLE_MAX,
    EditAction,
    MeConflict,
    MeEdit,
    MeError,
    MeKind,
    MeLimitExceeded,
    MeNotFound,
    MeSkill,
    MeSource,
    MeVersion,
    builtin,
)
from .vault import MeVault

NOT_FOUND = "This skill doesn't exist."
EDIT_NOT_FOUND = "This change can no longer be undone."
ALREADY_UNDONE = "This change was already undone."
BUILTIN_RENAME = "Built-in skills keep their names."
BUILTIN_DELETE = "Built-in skills can't be deleted; clear their text instead."
TOO_MANY = f"Me already has {MAX_SKILLS} skills. Delete or merge some first."
SUMMARY_CHARS = 90
_CITATION = re.compile(r"⟦[mp]:")
_TRANSLIT = dict(zip("абвгдеёжзийклмнопрстуфхцчшщъыьэюя",
                     ("a b v g d e e zh z i y k l m n o p r s t u f h ts ch sh sch _ y _ e yu ya"
                      .replace("_", "").split(" ")), strict=True))


def _one_line(text: str, limit: int = SUMMARY_CHARS) -> str:
    line = " ".join(text.split())
    return line if len(line) <= limit else line[: limit - 1].rstrip() + "…"


def _slug(title: str, taken: set[str]) -> str:
    lowered = "".join(_TRANSLIT.get(char, char) for char in title.lower())
    ascii_text = unicodedata.normalize("NFKD", lowered).encode("ascii", "ignore").decode()
    base = re.sub(r"[^a-z0-9]+", "-", ascii_text).strip("-")[:40].strip("-") or "skill"
    candidate, number = base, 1
    while candidate in taken or candidate in BUILTIN_IDS:
        number += 1
        candidate = f"{base}-{number}"
    return candidate


def limit_message(title: str, used: int, limit: int, would: int) -> str:
    return (f"“{title}” is full: {used} of {limit} characters used, this change would make {would}. "
            "Consolidate first: rewrite it shorter with action \"replace\" (merge duplicates, drop outdated "
            "lines), then add.")


class MeStore:
    def __init__(self, vault: MeVault, *, clock: Callable[[], str] = utc_now) -> None:
        self.vault = vault
        self._clock = clock
        self._lock = threading.RLock()
        self._data: dict[str, Any] | None = None

    # -- state -----------------------------------------------------------------------------

    def _state(self) -> dict[str, Any]:
        if self._data is None:
            loaded = self.vault.read() or {}
            skills = [skill for skill in loaded.get("skills") or () if isinstance(skill, dict)]
            present = {skill.get("id") for skill in skills}
            for item in reversed(BUILTINS):
                if item.id not in present:
                    skills.insert(0, {"id": item.id, "kind": item.kind, "title": item.title,
                                      "description": item.description, "enabled": True, "deleted": False,
                                      "created_at": None, "version": 0, "versions": []})
            self._data = {"v": 1, "enabled": loaded.get("enabled", True) is not False, "skills": skills,
                          "edits": [edit for edit in loaded.get("edits") or () if isinstance(edit, dict)]}
        return self._data

    def _save(self) -> None:
        assert self._data is not None
        self.vault.write(self._data)

    def _raw(self, skill_id: str, *, deleted: bool = False) -> dict[str, Any]:
        for skill in self._state()["skills"]:
            if skill.get("id") == skill_id and (deleted or not skill.get("deleted")):
                return cast(dict[str, Any], skill)
        raise MeNotFound(NOT_FOUND)

    def _view(self, raw: dict[str, Any]) -> MeSkill:
        item = builtin(str(raw["id"]))
        versions = raw.get("versions") or []
        text = str(versions[-1]["text"]) if versions else ""
        return MeSkill(
            id=str(raw["id"]), kind=item.kind if item else cast(MeKind, raw.get("kind", "skill")),
            builtin=item is not None,
            title=item.title if item else str(raw.get("title", "")),
            description=str(raw.get("description", "")), enabled=raw.get("enabled", True) is not False,
            always_on=item.always_on if item else False, limit=item.limit if item else None,
            version=int(raw.get("version", 0)),
            updated_at=str(versions[-1]["created_at"]) if versions else raw.get("created_at"), text=text)

    def _write_text(self, raw: dict[str, Any], text: str, source: MeSource, summary: str,
                    chat_id: str | None = None) -> int:
        version = int(raw.get("version", 0)) + 1
        raw["version"] = version
        versions = raw.setdefault("versions", [])
        versions.append({"version": version, "created_at": self._clock(), "source": source,
                         "chat_id": chat_id, "summary": _one_line(summary), "text": text})
        del versions[:-MAX_VERSIONS]
        return version

    def _check_size(self, raw: dict[str, Any], text: str, *, current: str | None = None) -> None:
        view = self._view(raw)
        limit = view.limit if view.limit is not None else SKILL_CAP
        if len(text) > limit:
            used = len(current if current is not None else view.text)
            raise MeLimitExceeded(limit_message(view.title, used, limit, len(text)))

    # -- reading ----------------------------------------------------------------------------

    def enabled(self) -> bool:
        with self._lock:
            return bool(self._state()["enabled"])

    def skills(self) -> list[MeSkill]:
        """Built-ins first (profile, how-to-work, search), then the others by title."""
        with self._lock:
            views = [self._view(skill) for skill in self._state()["skills"] if not skill.get("deleted")]
        order = {skill_id: index for index, skill_id in enumerate(BUILTIN_IDS)}
        return sorted(views,
                      key=lambda view: (order.get(view.id, len(order)), view.title.casefold(), view.id))

    def skill(self, skill_id: str) -> MeSkill:
        with self._lock:
            return self._view(self._raw(skill_id))

    def versions(self, skill_id: str) -> list[MeVersion]:
        with self._lock:
            raw = self._raw(skill_id)
            return [MeVersion(int(item["version"]), str(item["created_at"]), cast(MeSource, item["source"]),
                              item.get("chat_id"), str(item.get("summary", "")), len(str(item["text"])))
                    for item in reversed(raw.get("versions") or [])]

    # -- the user's changes (Settings → Me) ------------------------------------------------------

    def set_enabled(self, enabled: bool) -> None:
        with self._lock:
            self._state()["enabled"] = bool(enabled)
            self._save()

    def update(self, skill_id: str, *, enabled: bool | None = None, title: str | None = None,
               description: str | None = None, text: str | None = None) -> MeSkill:
        with self._lock:
            raw = self._raw(skill_id)
            view = self._view(raw)
            if title is not None:
                title = _clean_title(title)
                if view.builtin and title != view.title:
                    raise MeConflict(BUILTIN_RENAME, "builtin")
            if description is not None:
                description = _clean_description(description)
            if text is not None:
                text = text.strip()
                self._check_size(raw, text)
            if enabled is not None:
                raw["enabled"] = bool(enabled)
            if title is not None and not view.builtin:
                raw["title"] = title
            if description is not None:
                raw["description"] = description
            if text is not None and text != view.text:
                self._write_text(raw, text, "user", "Edited by you" if text else "Cleared by you")
            self._save()
            return self._view(raw)

    def create(self, title: str, description: str, text: str, *, source: MeSource = "user",
               chat_id: str | None = None) -> MeSkill:
        with self._lock:
            title, description, text = _clean_title(title), _clean_description(description), text.strip()
            state = self._state()
            if sum(1 for skill in state["skills"] if not skill.get("deleted")) >= MAX_SKILLS:
                raise MeError(TOO_MANY)
            if len(text) > SKILL_CAP:
                raise MeLimitExceeded(limit_message(title, 0, SKILL_CAP, len(text)))
            skill_id = _slug(title, {str(skill.get("id")) for skill in state["skills"]})
            raw: dict[str, Any] = {"id": skill_id, "kind": "skill", "title": title,
                                   "description": description, "enabled": True, "deleted": False,
                                   "created_at": self._clock(),
                                   "version": 0, "versions": []}
            if text:
                self._write_text(raw, text, source,
                                 "Created by you" if source == "user" else f"Created “{title}”", chat_id)
            state["skills"].append(raw)
            self._save()
            return self._view(raw)

    def delete(self, skill_id: str) -> None:
        """The user deletes a skill: gone with all its versions (no copy is kept)."""
        with self._lock:
            raw = self._raw(skill_id)
            if builtin(skill_id) is not None:
                raise MeConflict(BUILTIN_DELETE, "builtin")
            state = self._state()
            state["skills"] = [skill for skill in state["skills"] if skill is not raw]
            state["edits"] = [edit for edit in state["edits"] if edit.get("skill_id") != skill_id]
            self._save()

    def restore(self, skill_id: str, version: int) -> MeSkill:
        with self._lock:
            raw = self._raw(skill_id)
            found = next((item for item in raw.get("versions") or () if int(item["version"]) == version),
                         None)
            if found is None:
                raise MeNotFound("This version doesn't exist.")
            text = str(found["text"])
            self._check_size(raw, text)
            self._write_text(raw, text, "restore", f"Restored version {version}")
            self._save()
            return self._view(raw)

    # -- an agent's change in a chat (``skaz_me_edit``) --------------------------------------------

    def agent_edit(self, action: EditAction, *, chat_id: str, message_id: str, skill_id: str | None = None,
                   title: str | None = None, description: str | None = None,
                   text: str | None = None) -> MeEdit:
        """Create / append / replace / delete inside «Я» only. Over a limit → refused (consolidate first)."""
        with self._lock:
            state = self._state()
            if not state["enabled"]:
                raise MeError("The user switched Me off: don't write to it.")
            body = (text or "").strip()
            if _CITATION.search(body):
                raise MeError("Me is about the user, not about their materials: no citations in it.")
            if action == "create":
                if not title:
                    raise MeError("Give the new skill a title.")
                if not body:
                    raise MeError("Give the new skill its text.")
                skill = self.create(title, description or "", body, source="agent", chat_id=chat_id)
                raw = self._raw(skill.id)
                return self._record(raw, "create", 0, int(raw["version"]), f"New skill “{skill.title}”",
                                    chat_id, message_id)
            if not skill_id:
                raise MeError("Name the skill (skill_id) to change.")
            raw = self._raw(skill_id)
            view = self._view(raw)
            if not view.enabled:
                raise MeError(f"The user switched “{view.title}” off: don't change it.")
            before = int(raw.get("version", 0))
            if action == "delete":
                if view.builtin:  # built-ins stay: their text is cleared
                    if not view.text:
                        raise MeError(f"“{view.title}” is already empty.")
                    self._write_text(raw, "", "agent", f"Cleared “{view.title}”", chat_id)
                    return self._record(raw, "delete", before, int(raw["version"]), f"Cleared “{view.title}”",
                                        chat_id, message_id)
                raw["deleted"], raw["deleted_at"] = True, self._clock()
                self._trim_tombstones()
                return self._record(raw, "delete", before, before, f"Deleted skill “{view.title}”", chat_id,
                                    message_id)
            if not body:
                raise MeError("Give the text to write.")
            if action == "append":
                new = f"{view.text}\n{body}" if view.text else body
                self._check_size(raw, new)
                summary = (f"+ {_one_line(body)}" if view.id != "profile" else "a detail for your profile")
            else:
                new = body
                self._check_size(raw, new)
                summary = f"Rewrote “{view.title}”"
            if description is not None and not view.builtin:
                raw["description"] = _clean_description(description)
            self._write_text(raw, new, "agent", summary, chat_id)
            return self._record(raw, action, before, int(raw["version"]), summary, chat_id, message_id)

    def _record(self, raw: dict[str, Any], action: EditAction, before: int, after: int, summary: str,
                chat_id: str, message_id: str) -> MeEdit:
        state = self._state()
        edit = {"id": new_id("me"), "skill_id": raw["id"], "skill_title": self._view(raw).title,
                "action": action, "before": before, "after": after, "summary": _one_line(summary),
                "chat_id": chat_id,
                "message_id": message_id, "undone": False, "created_at": self._clock()}
        state["edits"].append(edit)
        del state["edits"][:-MAX_EDITS]
        self._save()
        return _edit_view(edit)

    def _trim_tombstones(self) -> None:
        state = self._state()
        dead = [skill for skill in state["skills"] if skill.get("deleted")]
        for skill in dead[:-MAX_TOMBSTONES]:
            state["skills"].remove(skill)

    def edit(self, edit_id: str) -> MeEdit:
        with self._lock:
            return _edit_view(self._edit(edit_id))

    def _edit(self, edit_id: str) -> dict[str, Any]:
        found = next((edit for edit in self._state()["edits"] if edit.get("id") == edit_id), None)
        if found is None:
            raise MeNotFound(EDIT_NOT_FOUND)
        return cast(dict[str, Any], found)

    def undo(self, edit_id: str) -> tuple[MeSkill, MeEdit]:
        """Bring the skill back to the version before that edit (a new ``restore`` version)."""
        with self._lock:
            edit = self._edit(edit_id)
            if edit.get("undone"):
                raise MeConflict(ALREADY_UNDONE, "already_undone")
            skill_id, action = str(edit["skill_id"]), edit["action"]
            if action == "create":
                raw = self._raw(skill_id)
                raw["deleted"], raw["deleted_at"] = True, self._clock()
                self._trim_tombstones()
            elif action == "delete" and builtin(skill_id) is None:
                raw = self._raw(skill_id, deleted=True)
                raw["deleted"] = False
                raw.pop("deleted_at", None)
            else:
                raw = self._raw(skill_id)
                before = int(edit["before"])
                if before == 0:
                    text = ""
                else:
                    found = next((item for item in raw.get("versions") or ()
                                  if int(item["version"]) == before), None)
                    if found is None:
                        raise MeNotFound(EDIT_NOT_FOUND)
                    text = str(found["text"])
                self._write_text(raw, text, "restore", f"Undid: {edit['summary']}")
            edit["undone"] = True
            self._save()
            return self._view(raw), _edit_view(edit)

    def erase(self) -> None:
        """"Delete everything": «Я» is gone from disk and from memory."""
        with self._lock:
            self.vault.erase()
            self._data = None


def _edit_view(edit: dict[str, Any]) -> MeEdit:
    return MeEdit(str(edit["id"]), str(edit["skill_id"]), str(edit.get("skill_title", "")),
                  cast(EditAction, edit["action"]), str(edit.get("summary", "")), str(edit["chat_id"]),
                  str(edit["message_id"]), bool(edit.get("undone")))


def _clean_title(title: str) -> str:
    cleaned = " ".join(title.split())
    if not cleaned:
        raise MeError("A skill needs a title.")
    if len(cleaned) > TITLE_MAX:
        raise MeError(f"A title is at most {TITLE_MAX} characters.")
    return cleaned


def _clean_description(description: str) -> str:
    cleaned = " ".join(description.split())
    if len(cleaned) > DESCRIPTION_MAX:
        raise MeError(f"A description is one line of at most {DESCRIPTION_MAX} characters.")
    return cleaned
