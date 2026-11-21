"""The isolated Me Graph vault and its single-writer transactions.

The first store reuses the encrypted snapshot format. The on-disk index and
incremental cold reads are a separate storage qualification before release.
"""
from __future__ import annotations

import hashlib
import json
import os
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Literal, TypeVar
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from ..ids import utc_now
from . import ID_PATTERN, MAX_VERSIONS, PROFILE, SKILL_CAP, MeConflict, MeError, MeNotFound
from .experience import Attempt, Outcome, ReplyExperience, updated, withdraw
from .observations import (
    SHARED_CHAT,
    Family,
    Hypothesis,
    Ledger,
    Receipt,
    Surface,
    TrustedEvent,
    forget,
    reduce_event,
    retract,
    revocation_key,
    revoked,
)
from .vault import MeVault, MeVaultUnreadable

_T = TypeVar("_T")

Area = Literal["chat", "practice", "personal"]
EntryKind = Literal["instruction", "fact", "procedure", "legacy_import"]
Origin = Literal["user", "agent", "restore"]
Phase = Literal["preparing", "verified", "graph"]
GRAPH_ACTIVE = "me-graph.active"


class GraphUnavailable(MeError):
    code = "recovery_required"
    status_code = 503

    def __init__(self) -> None:
        super().__init__("Your Me entries could not be opened. Chat still works without personalization.")


class _Record(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class GraphControls(_Record):
    enabled: bool = True
    personal: bool = True
    study: bool = False
    chat: bool = False
    epoch: str = Field(default_factory=lambda: uuid4().hex)
    study_epoch: str = Field(default_factory=lambda: uuid4().hex)
    chat_epoch: str = Field(default_factory=lambda: uuid4().hex)

    def learning_epoch(self, surface: Surface) -> str | None:
        if not self.enabled:
            return None
        if surface == "study":
            return self.study_epoch if self.study else None
        return self.chat_epoch if self.chat else None


class GraphEntry(_Record):
    id: str
    revision: int
    text: str
    area: Area
    kind: EntryKind
    origin: Origin = "user"
    enabled: bool = True
    deleted: bool = False
    created_at: str | None = None
    scope: str | None = None
    source_ref: str | None = None
    title: str | None = None
    description: str | None = None
    summary: str | None = None


class GraphEdit(_Record):
    entry_id: str
    before: int
    after: int
    action: Literal["create", "append", "replace", "delete"]
    chat_id: str
    message_id: str
    undone: bool = False


class SourceChange(_Record):
    receipt: str = Field(default_factory=lambda: uuid4().hex)
    sources: frozenset[str]
    scope: str | None = None
    keep_experience: bool = False


class PendingRevocations(_Record):
    sources: frozenset[str] = frozenset()
    scopes: frozenset[str] = frozenset()
    discard_sources: frozenset[str] = frozenset()
    preserve: frozenset[str] = frozenset()
    staged: SourceChange | None = None

    def add(self, sources: frozenset[str], scope: str | None, keep_experience: bool) -> PendingRevocations:
        scopes = self.scopes | {scope} if scope is not None else self.scopes
        preserve = self.preserve
        if scope is not None:
            if not keep_experience:
                preserve = preserve - {scope}
            elif scope not in self.scopes:
                preserve = preserve | {scope}
        discard = self.discard_sources if keep_experience and scope else self.discard_sources | sources
        return PendingRevocations(sources=self.sources | sources, scopes=scopes,
                                  preserve=preserve, discard_sources=discard)


class GraphState(_Record):
    schema_version: Literal[2] = 2
    phase: Phase = "graph"
    revision: int = 0
    entries_revision: int | None = None
    migration_revision: int = 0
    legacy_digest: str | None = None
    controls: GraphControls = Field(default_factory=GraphControls)
    entries: dict[str, list[GraphEntry]] = Field(default_factory=dict)
    edits: dict[str, GraphEdit] = Field(default_factory=dict)
    removed_sources: frozenset[str] = frozenset()
    removed_scopes: frozenset[str] = frozenset()
    ledger: Ledger = Field(default_factory=Ledger)
    replies: ReplyExperience = Field(default_factory=ReplyExperience)


class _LegacyVersion(BaseModel):
    version: int = Field(ge=1)
    text: str
    created_at: str
    source: Origin
    chat_id: str | None = None
    summary: str | None = None


class _LegacySkill(BaseModel):
    id: str = Field(pattern=ID_PATTERN)
    kind: Literal["profile", "how_to_work", "search", "skill"]
    title: str
    description: str
    enabled: bool
    deleted: bool
    created_at: str | None
    version: int = Field(ge=0)
    versions: list[_LegacyVersion]


class _LegacyEdit(BaseModel):
    id: str
    skill_id: str
    before: int = Field(ge=0)
    after: int = Field(ge=0)
    action: Literal["create", "append", "replace", "delete"]
    chat_id: str
    message_id: str
    undone: bool = False


class _Legacy(BaseModel):
    v: Literal[1]
    enabled: bool
    skills: list[_LegacySkill]
    edits: list[_LegacyEdit]


def _kind(area: Area) -> EntryKind:
    return "fact" if area == "personal" else "instruction"


def _import_entry(skill: _LegacySkill) -> list[GraphEntry]:
    revisions = [v.version for v in skill.versions]
    if revisions != sorted(set(revisions)) or skill.version != max(revisions, default=0):
        raise GraphUnavailable()
    area: Area = "personal" if skill.kind == "profile" else "chat"
    versions = skill.versions or [
        _LegacyVersion.model_construct(version=0, text="", created_at=skill.created_at, source="user")
    ]
    result: list[GraphEntry] = []
    for version in versions:
        kind: EntryKind = "legacy_import"
        if version.source == "user":
            if skill.kind == "skill":
                kind = "procedure"
            elif skill.kind != "search" and "\n" not in version.text.strip():
                kind = _kind(area)
        result.append(GraphEntry(
            id=skill.id, revision=version.version, text=version.text, area=area, kind=kind,
            origin=version.source, enabled=skill.enabled, created_at=version.created_at,
            deleted=skill.deleted and version.version == skill.version,
            scope=version.chat_id, title=skill.title, description=skill.description,
            summary=version.summary,
        ))
    return result


def _candidate(data: dict[str, Any]) -> GraphState:
    legacy = _Legacy.model_validate(data)
    entries = {skill.id: _import_entry(skill) for skill in legacy.skills}
    edits = {
        edit.id: GraphEdit(
            entry_id=edit.skill_id, before=edit.before, after=edit.after, action=edit.action,
            chat_id=edit.chat_id, message_id=edit.message_id, undone=edit.undone,
        )
        for edit in legacy.edits
    }
    if len(entries) != len(legacy.skills) or len(edits) != len(legacy.edits):
        raise GraphUnavailable()
    profile = entries.get(PROFILE)
    revision = max((rows[-1].revision for rows in entries.values()), default=0)
    digest = hashlib.sha256(json.dumps(data, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    return GraphState(
        phase="preparing", revision=revision, migration_revision=revision, legacy_digest=digest,
        controls=GraphControls(enabled=legacy.enabled, personal=profile is None or profile[-1].enabled),
        entries=entries, edits=edits,
    )


def _advance(state: GraphState, *, revoke: bool = False, **change: Any) -> GraphState:
    if revoke:
        change["controls"] = change.get("controls", state.controls).model_copy(update={"epoch": uuid4().hex})
    entries_revision = state.entries_revision if state.entries_revision is not None else state.revision
    if "entries" in change:
        entries_revision = state.revision + 1
    return state.model_copy(update={
        "revision": state.revision + 1, "entries_revision": entries_revision, **change,
    })


class MeGraphStore:
    def __init__(self, directory: Path, *, clock: Callable[[], str] = utc_now,
                 admitted: frozenset[Family] = frozenset(), new_profile: bool = False,
                 source_committed: Callable[[str], bool] | None = None) -> None:
        self.directory = directory
        self._new_profile = new_profile
        self._source_committed = source_committed
        self.admitted = admitted
        self.vault = MeVault(directory, name="me-graph.enc", key="me-graph.key")
        self._legacy = MeVault(directory)
        self._revocations = MeVault(directory, name="me-revocations.enc", key="me-revocations.key")
        self._ready = directory / GRAPH_ACTIVE
        self._erasing = directory / "me-graph.erasing"
        self._clock = clock
        self._snapshot: tuple[tuple[int, ...], GraphState] | None = None

    @contextmanager
    def _locked(self) -> Iterator[None]:
        import fcntl

        try:
            self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
            descriptor = os.open(self.directory / "me-graph.lock", os.O_CREAT | os.O_RDWR, 0o600)
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX)
                yield
            finally:
                os.close(descriptor)
        except (OSError, MeVaultUnreadable, ValidationError) as error:
            raise GraphUnavailable() from error

    def _sync_dir(self) -> None:
        descriptor = os.open(self.directory, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    def _mark(self, path: Path) -> None:
        if not path.exists():
            descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            os.close(descriptor)
            self._sync_dir()

    def _signature(self) -> tuple[int, ...]:
        info = self.vault.path.stat()
        key = self.vault.key_path.stat()
        return info.st_ino, info.st_mtime_ns, info.st_size, key.st_ino, key.st_mtime_ns, key.st_size

    def _write(self, next_state: GraphState) -> GraphState:
        self.vault.write(next_state.model_dump(mode="json"))
        self._sync_dir()
        self._snapshot = self._signature(), next_state
        return next_state

    def _legacy_source(self) -> dict[str, Any] | None:
        raw = self._legacy.read(strict=True)
        if raw is None and self._legacy.unreadable_path.exists():
            raise GraphUnavailable()
        return raw

    def _cutover(self, pending: GraphState | None) -> GraphState:
        legacy = self._legacy_source()
        if legacy is None:
            if pending is not None or self._ready.exists():
                raise GraphUnavailable()
            controls = GraphControls(study=self._new_profile, chat=self._new_profile)
            return self._write(GraphState(controls=controls))
        candidate = _candidate(legacy)
        if pending is None:
            pending = self._write(candidate)
        if (pending.legacy_digest, pending.entries, pending.edits) != (
            candidate.legacy_digest, candidate.entries, candidate.edits
        ):
            raise GraphUnavailable()
        if (
            (pending.controls.enabled, pending.controls.personal)
            != (candidate.controls.enabled, candidate.controls.personal)
            or pending.controls.study or pending.controls.chat
        ):
            raise GraphUnavailable()
        # Validate the actual encrypted copy before publishing it.
        if GraphState.model_validate(self.vault.read(strict=True)) != pending:
            raise GraphUnavailable()
        if pending.phase == "preparing":
            pending = self._write(pending.model_copy(update={"phase": "verified"}))
        if self._legacy_source() != legacy:
            raise GraphUnavailable()
        return self._write(pending.model_copy(update={"phase": "graph"}))

    def _open_locked(self) -> GraphState:
        if self._erasing.exists():
            return self._finish_erase(GraphControls(enabled=False, personal=False))
        if self.vault.path.exists():
            signature = self._signature()
            state = (
                self._snapshot[1] if self._snapshot is not None and self._snapshot[0] == signature
                else GraphState.model_validate(self.vault.read(strict=True))
            )
            self._snapshot = signature, state
        else:
            if self._ready.exists():
                raise GraphUnavailable()
            state = self._cutover(None)
        if state.phase != "graph":
            state = self._cutover(state)
        self._mark(self._ready)
        # The v1 copy is available for recovery up to the first graph write.
        if state.legacy_digest and state.revision > state.migration_revision:
            self._purge_legacy()
        return self._apply_revocations(state) if self._revocations.path.exists() else state

    def open(self) -> GraphState:
        with self._locked():
            return self._open_locked()

    def needs_migration(self) -> bool:
        return not self._ready.exists() and self._legacy.path.exists()

    def retry(self) -> GraphState:
        with self._locked():
            if self.needs_migration() and self.vault.path.exists():
                pending = GraphState.model_validate(self.vault.read(strict=True))
                if pending.phase != "graph":
                    self._cutover(None)
            return self._open_locked()

    def current_epoch(self) -> str:
        return self.open().controls.epoch

    def source_epoch(self, source: Surface) -> str | None:
        return self.open().controls.learning_epoch(source)

    def observe(self, event: TrustedEvent) -> Receipt:
        with self._locked():
            state = self._open_locked()
            if (state.controls.learning_epoch(event.producer) != event.epoch
                    or revoked(event.source_ref, state.removed_sources)
                    or revoked(event.scope, state.removed_scopes)
                    or (event.scope == SHARED_CHAT and revoked(event.session_id, state.removed_scopes))):
                return "ignored"
            result, ledger = reduce_event(state.ledger, event, datetime.fromisoformat(self._clock()),
                                          state.revision + 1)
            if result == "accepted":
                self._commit(state, ledger=ledger)
            return result

    def record_reply(self, item: Attempt) -> None:
        with self._locked():
            state = self._open_locked()
            if (item.epoch != state.controls.learning_epoch("chat")
                    or revoked(item.chat, state.removed_scopes)
                    or any(revoked(key, state.removed_sources) for key in (item.answer, item.question))
                    or item.answer in state.replies.attempts):
                return
            attempts = {**state.replies.attempts, item.answer: item}
            replies = state.replies.model_copy(update={"attempts": attempts})
            self._commit(state, replies=replies)

    def react(self, answer: str, epoch: str, source: str, seq: int, reactions: dict[str, Outcome]) -> None:
        with self._locked():
            state = self._open_locked()
            item = state.replies.attempts.get(answer)
            if (item is None or epoch != item.epoch or epoch != state.controls.learning_epoch("chat")
                    or revoked(source, state.removed_sources)):
                return
            revised = updated(item, reactions, source, seq)
            if revised is not item:
                attempts = {**state.replies.attempts, answer: revised}
                replies = state.replies.model_copy(update={"attempts": attempts})
                self._commit(state, replies=replies)

    def manage_reply(self, name: str, revision: int, *, enabled: bool | None = None,
                     correction: str | None = None) -> GraphState:
        with self._locked():
            state = self._open_locked()
            self._expect(state.revision, revision)
            memory = state.replies
            if name not in memory.counts():
                raise MeNotFound("This observed response no longer exists.")
            if enabled is not None or correction is not None:
                disabled = memory.disabled - {name} if enabled else memory.disabled | {name}
                change: dict[str, Any] = {}
                if correction is not None:
                    new = GraphEntry(id=uuid4().hex, revision=state.revision + 1, text=self._text(correction),
                                     area="chat", kind="instruction", created_at=self._clock())
                    self._unique(state, new)
                    change["entries"] = {**state.entries, new.id: [new]}
                return self._commit(state, replies=memory.model_copy(update={"disabled": disabled}),
                                    revoke=True, **change)
            removed = {key for key, item in memory.attempts.items()
                       if name in item.outcomes() or name in item.shapes or name == item.shape}
            replies = memory.model_copy(update={
                "attempts": {k: v for k, v in memory.attempts.items() if k not in removed},
                "retained": {k: v for k, v in memory.retained.items() if k != name},
                "disabled": memory.disabled - {name},
            })
            return self._commit(state, replies=replies, revoke=True,
                                removed_sources=state.removed_sources.union(map(revocation_key, removed)))

    def _purge_legacy(self) -> None:
        if any(path.exists() for path in (self._legacy.path, self._legacy.key_path,
                                         self._legacy.unreadable_path)):
            self._legacy.erase()
            self._sync_dir()

    def _commit(self, state: GraphState, **change: Any) -> GraphState:
        next_state = self._write(_advance(state, **change))
        if state.legacy_digest:
            self._purge_legacy()
        return next_state

    @staticmethod
    def current(state: GraphState, entry_id: str, *, hidden: bool = False) -> GraphEntry:
        rows = state.entries.get(entry_id)
        if not rows or (rows[-1].deleted and not hidden):
            raise MeNotFound("This Me entry no longer exists.")
        return rows[-1]

    @staticmethod
    def _expect(actual: int, expected: int) -> None:
        if actual != expected:
            raise MeConflict("Me changed. Refresh and try again.")

    @staticmethod
    def _text(text: str) -> str:
        clean = text.strip()
        if not clean or len(clean) > SKILL_CAP or "\x00" in clean:
            raise MeError("Enter a fact or instruction within the supported length.")
        return clean

    @staticmethod
    def _unique(state: GraphState, entry: GraphEntry) -> None:
        if entry.deleted or not entry.text:
            return
        identity = " ".join(entry.text.casefold().split()), entry.area, entry.scope
        for rows in state.entries.values():
            other = rows[-1]
            if (other.id != entry.id and not other.deleted
                    and (" ".join(other.text.casefold().split()), other.area, other.scope) == identity):
                raise MeConflict("This instruction or fact is already in Me.")

    def set_controls(self, expected_revision: int, **change: bool) -> GraphState:
        with self._locked():
            state = self._open_locked()
            self._expect(state.revision, expected_revision)
            controls = state.controls.model_copy(update=change)
            if controls == state.controls:
                return state
            epochs = {}
            if controls.enabled != state.controls.enabled or controls.study != state.controls.study:
                epochs["study_epoch"] = uuid4().hex
            if controls.enabled != state.controls.enabled or controls.chat != state.controls.chat:
                epochs["chat_epoch"] = uuid4().hex
            controls = controls.model_copy(update=epochs)
            return self._commit(state, revoke=True, controls=controls)

    def create(self, *, text: str, area: Area, expected_revision: int | None = None) -> GraphEntry:
        with self._locked():
            state = self._open_locked()
            if expected_revision is not None:
                self._expect(state.revision, expected_revision)
            entry = GraphEntry(
                id=uuid4().hex, revision=state.revision + 1, text=self._text(text), area=area,
                kind=_kind(area), created_at=self._clock(),
            )
            self._unique(state, entry)
            self._commit(state, entries={**state.entries, entry.id: [entry]})
            return entry

    def remember(self, *, text: str, area: Area, chat_id: str, source_id: str, answer_id: str,
                 epoch: str) -> str:
        with self._locked():
            state = self._open_locked()
            if not state.controls.enabled or state.controls.epoch != epoch:
                raise MeConflict("Me access changed during this answer.")
            if revoked(source_id, state.removed_sources) or revoked(chat_id, state.removed_scopes):
                raise MeNotFound("This source is no longer available to Me.")
            if any(item.source_ref == source_id for rows in state.entries.values() for item in rows):
                raise MeConflict("This message already has a Me edit.")
            entry = GraphEntry(
                id=uuid4().hex, revision=state.revision + 1, text=self._text(text), area=area,
                kind=_kind(area), created_at=self._clock(), scope=chat_id, source_ref=source_id,
            )
            self._unique(state, entry)
            edit_id = uuid4().hex
            edit = GraphEdit(entry_id=entry.id, before=0, after=entry.revision, action="create",
                             chat_id=chat_id, message_id=answer_id)
            self._commit(state, entries={**state.entries, entry.id: [entry]},
                         edits={**state.edits, edit_id: edit})
            return edit_id

    def _pending(self) -> PendingRevocations:
        pending = PendingRevocations.model_validate(self._revocations.read(strict=True) or {})
        change = pending.staged
        if change is None:
            return pending
        if self._source_committed is None:
            raise GraphUnavailable()
        if self._source_committed(change.receipt):
            return pending.add(change.sources, change.scope, change.keep_experience)
        return pending.model_copy(update={"staged": None})

    def _save_pending(self, pending: PendingRevocations) -> None:
        self._revocations.write(pending.model_dump(mode="json"))
        self._sync_dir()

    def change_source(self, change: SourceChange, operation: Callable[[str], _T]) -> _T:
        """Fence the SQLite mutation under the vault lock; recovery checks its actual commit."""
        with self._locked():
            pending = self._pending()
            if self._source_committed is None:
                raise GraphUnavailable()
            self._save_pending(pending.model_copy(update={"staged": change}))
            return operation(change.receipt)

    def revoke_sources(self, source_ids: set[str], *, scope: str | None = None,
                       keep_experience: bool = False) -> bool:
        """Fence a removal that the authoritative source has already accepted."""
        if not source_ids and scope is None:
            return False
        with self._locked():
            self._save_pending(self._pending().add(frozenset(source_ids), scope, keep_experience))
            return True

    def _apply_revocations(self, state: GraphState) -> GraphState:
        pending = self._pending()
        affected = {
            key for key, rows in state.entries.items()
            if any(row.source_ref in pending.sources or row.scope in pending.scopes for row in rows)
        }
        affected.update(edit.entry_id for edit in state.edits.values()
                        if edit.chat_id in pending.scopes or edit.message_id in pending.sources)
        ledger = retract(state.ledger, pending.sources, pending.scopes, state.revision + 1,
                         preserve=pending.preserve, discard_sources=pending.discard_sources)
        sources = frozenset(map(revocation_key, pending.sources))
        scopes = frozenset(map(revocation_key, pending.scopes))
        replies = withdraw(state.replies, pending.sources, pending.scopes,
                          pending.preserve, pending.discard_sources)
        changed = bool(affected) or ledger is not state.ledger or replies != state.replies
        if changed or not sources <= state.removed_sources or not scopes <= state.removed_scopes:
            changes: dict[str, Any] = {}
            if affected:
                changes["entries"] = {k: v for k, v in state.entries.items() if k not in affected}
                changes["edits"] = {k: v for k, v in state.edits.items() if v.entry_id not in affected}
            state = self._commit(
                state, removed_sources=state.removed_sources | sources,
                removed_scopes=state.removed_scopes | scopes,
                ledger=ledger, replies=replies, revoke=changed, **changes,
            )
        self._revocations.path.unlink()
        self._sync_dir()
        return state

    def update(self, entry_id: str, expected_revision: int, *, text: str | None = None,
               area: Area | None = None, enabled: bool | None = None) -> GraphEntry:
        with self._locked():
            state = self._open_locked()
            item = self.current(state, entry_id)
            self._expect(item.revision, expected_revision)
            change: dict[str, Any] = {}
            if text is not None:
                target_area = area or item.area
                kind = _kind(target_area)
                if item.kind == "procedure" and target_area != "personal":
                    kind = item.kind
                change.update(text=self._text(text), area=target_area, origin="user", kind=kind)
            elif area is not None and area != item.area:
                raise MeError("Review the entry text before changing where it applies.")
            if enabled is not None:
                change["enabled"] = enabled
            if item == item.model_copy(update=change):
                return item
            return self._revise(state, item, **change)

    def _revise(self, state: GraphState, item: GraphEntry, *, edits: dict[str, GraphEdit] | None = None,
                **change: Any) -> GraphEntry:
        new = item.model_copy(update={"revision": state.revision + 1, "created_at": self._clock(), **change})
        self._unique(state, new)
        entries = {**state.entries, item.id: [*state.entries[item.id], new]}
        self._commit(state, entries=entries, edits=state.edits if edits is None else edits, revoke=True)
        return new

    def restore(self, entry_id: str, expected_revision: int, revision: int) -> GraphEntry:
        with self._locked():
            state = self._open_locked()
            item = self.current(state, entry_id)
            self._expect(item.revision, expected_revision)
            old = next((v for v in state.entries[entry_id] if v.revision == revision and not v.deleted), None)
            if old is None:
                raise MeNotFound("This Me revision no longer exists.")
            return self._revise(state, old, enabled=item.enabled, area=item.area, scope=item.scope,
                                kind=old.kind if old.area == item.area else "legacy_import")

    def forget(self, entry_id: str, expected_revision: int) -> GraphState:
        with self._locked():
            state = self._open_locked()
            item = self.current(state, entry_id)
            self._expect(item.revision, expected_revision)
            sources = {v.source_ref for v in state.entries[entry_id] if v.source_ref is not None}
            return self._commit(
                state, entries={k: v for k, v in state.entries.items() if k != entry_id},
                edits={k: v for k, v in state.edits.items() if v.entry_id != entry_id},
                removed_sources=state.removed_sources.union(map(revocation_key, sources)), revoke=True,
            )

    @staticmethod
    def pattern(state: GraphState, pattern_id: str) -> Hypothesis:
        item = state.ledger.patterns.get(pattern_id)
        if item is None:
            raise MeNotFound("This Me pattern no longer exists.")
        return item

    @staticmethod
    def _revise_pattern(
        state: GraphState, item: Hypothesis, suppressed: frozenset[str],
    ) -> tuple[Ledger, Hypothesis]:
        new = item.model_copy(update={"revision": state.revision + 1})
        history = (*state.ledger.history.get(item.id, ()), new)[-MAX_VERSIONS:]
        ledger = state.ledger.model_copy(update={
            "patterns": {**state.ledger.patterns, item.id: new},
            "history": {**state.ledger.history, item.id: history},
            "suppressed": suppressed,
        })
        return ledger, new

    def set_pattern_enabled(self, pattern_id: str, expected_revision: int, enabled: bool) -> Hypothesis:
        with self._locked():
            state = self._open_locked()
            item = self.pattern(state, pattern_id)
            self._expect(item.revision, expected_revision)
            suppressed = state.ledger.suppressed
            suppressed = suppressed - {item.id} if enabled else suppressed | {item.id}
            ledger, new = self._revise_pattern(state, item, suppressed)
            self._commit(state, ledger=ledger, revoke=True)
            return new

    def correct_pattern(self, pattern_id: str, expected_revision: int, *,
                        text: str, area: Area) -> GraphEntry:
        with self._locked():
            state = self._open_locked()
            item = self.pattern(state, pattern_id)
            self._expect(item.revision, expected_revision)
            expected_area = "practice" if item.family == "study_revision" else "chat"
            if area != expected_area:
                raise MeError("A correction applies in the same area as the pattern.")
            ledger, _ = self._revise_pattern(state, item, state.ledger.suppressed | {item.id})
            entry = GraphEntry(
                id=uuid4().hex, revision=state.revision + 1, text=self._text(text), area=area,
                kind=_kind(area), created_at=self._clock(),
                scope=None if item.scope == SHARED_CHAT else item.scope,
            )
            self._unique(state, entry)
            self._commit(state, entries={**state.entries, entry.id: [entry]}, ledger=ledger, revoke=True)
            return entry

    def forget_pattern(self, pattern_id: str, expected_revision: int) -> GraphState:
        with self._locked():
            state = self._open_locked()
            item = self.pattern(state, pattern_id)
            self._expect(item.revision, expected_revision)
            ledger = forget(state.ledger, item, state.revision + 1)
            return self._commit(state, ledger=ledger, revoke=True)

    def undo(self, edit_id: str) -> GraphEntry:
        with self._locked():
            state = self._open_locked()
            edit = state.edits.get(edit_id)
            if edit is None:
                raise MeNotFound("This change can no longer be undone.")
            if edit.undone:
                raise MeConflict("This change was already undone.", "already_undone")
            item = self.current(state, edit.entry_id, hidden=True)
            self._expect(item.revision, edit.after)
            edits = {**state.edits, edit_id: edit.model_copy(update={"undone": True})}
            if edit.action == "create" and edit.before == 0:
                return self._revise(state, item, edits=edits, deleted=True)
            old = next((v for v in state.entries[item.id] if v.revision == edit.before), None)
            if old is None and edit.before != 0:
                raise MeNotFound("This change can no longer be undone.")
            if old is None:
                return self._revise(state, item, edits=edits, text="", origin="restore", kind="legacy_import")
            return self._revise(state, old, edits=edits, deleted=False)

    def _finish_erase(self, controls: GraphControls, revision: int | None = None) -> GraphState:
        self._snapshot = None
        self._legacy.erase()
        self._revocations.erase()
        self.vault.erase()
        for path in self.directory.glob(".me-*.tmp"):
            path.unlink(missing_ok=True)
        state = self._write(GraphState(
            controls=controls, revision=revision if revision is not None else int(uuid4().hex[:11], 16),
        ))
        self._mark(self._ready)
        self._erasing.unlink()
        self._sync_dir()
        return state

    def erase(self, expected_revision: int) -> GraphState:
        with self._locked():
            state = self._open_locked()
            self._expect(state.revision, expected_revision)
            self._mark(self._erasing)
            return self._finish_erase(
                GraphControls(enabled=state.controls.enabled, personal=state.controls.personal),
                state.revision + 1,
            )
