"""«Я» (Me): SKAZ's learnable profile of the user (N6 decisions 1–8, 15, 16).

One folder of skills, each switched on and off on its own:

* ``profile`` ("Profile", ≤ 1 400 chars) and ``how-to-work`` ("How to work with me", ≤ 2 200 chars) —
  always in a chat agent's instructions when on (hard limits; the agent consolidates when full);
* ``search`` ("Search", soft search preferences, decision 16) and the user's / agent's own skills — only
  an index line (title + one-line description) in the instructions; the text is read on demand with
  ``skaz_me_skill`` (never the profile: no tool returns it, decision 5).

Storage (``me.vault``): one Fernet-encrypted file beside the provider keys (0600 file, 0700 folder) —
never the database, logs, ``usage_log`` or exports. Every text change is a version (history, restore);
an agent's change in a chat (``skaz_me_edit``, chats only) is an *edit* the chat shows with Undo.
Where «Я» is read: chats only (``chats.service`` instructions, ``chats.live`` notes); wiki processing,
ingest, judge, W-3b and chat summaries never see it (decision 15).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from ..errors import KnowledgeError

MeKind = Literal["profile", "how_to_work", "search", "skill"]
MeSource = Literal["agent", "user", "restore"]
EditAction = Literal["create", "append", "replace", "delete"]

PROFILE = "profile"
HOW_TO_WORK = "how-to-work"
SEARCH = "search"
PROFILE_LIMIT = 1_400
HOW_TO_WORK_LIMIT = 2_200
#: Hidden cap of the other skills (the API shows ``limit: null``): a skill is a note, not a library.
SKILL_CAP = 20_000
MAX_SKILLS = 100
TITLE_MAX = 80
DESCRIPTION_MAX = 200
#: Kept per skill; older versions are dropped (oldest first).
MAX_VERSIONS = 50
#: Agent edits kept for Undo; older ones can no longer be undone (404).
MAX_EDITS = 500
#: Skills an agent deleted, kept (encrypted) only so its Undo can bring them back.
MAX_TOMBSTONES = 10
ID_PATTERN = r"^[a-z0-9-]{1,48}$"


@dataclass(frozen=True)
class Builtin:
    id: str
    kind: MeKind
    title: str
    description: str
    always_on: bool
    limit: int | None


BUILTINS: tuple[Builtin, ...] = (
    Builtin(PROFILE, "profile", "Profile",
            "Personal facts the user told you: name, studies or work, goals and deadlines.", True,
            PROFILE_LIMIT),
    Builtin(HOW_TO_WORK, "how_to_work", "How to work with me",
            "How the user wants you to explain, answer, quiz and work with SKAZ.", True, HOW_TO_WORK_LIMIT),
    Builtin(SEARCH, "search", "Search",
            "Where and how the user likes to look for sources: services, sites, kinds of sources.", False,
            None),
)
BUILTIN_IDS: tuple[str, ...] = tuple(item.id for item in BUILTINS)


def builtin(skill_id: str) -> Builtin | None:
    return next((item for item in BUILTINS if item.id == skill_id), None)


# -- errors (plain English; the API adds the machine ``code``) ------------------------------


class MeError(KnowledgeError):
    code = "invalid"
    status_code = 422


class MeNotFound(MeError):
    code = "not_found"
    status_code = 404


class MeLimitExceeded(MeError):
    code = "limit_exceeded"
    status_code = 422


class MeConflict(MeError):
    code = "conflict"
    status_code = 409

    def __init__(self, message: str, code: str = "conflict") -> None:
        super().__init__(message)
        self.code = code


# -- views ------------------------------------------------------------------------------------


@dataclass(frozen=True)
class MeSkill:
    id: str
    kind: MeKind
    builtin: bool
    title: str
    description: str
    enabled: bool
    always_on: bool
    limit: int | None
    version: int
    updated_at: str | None
    text: str

    @property
    def chars(self) -> int:
        return len(self.text)


@dataclass(frozen=True)
class MeVersion:
    version: int
    created_at: str
    source: MeSource
    chat_id: str | None
    summary: str
    chars: int


@dataclass(frozen=True)
class MeEdit:
    """An agent's change in a chat answer: what the chat chip shows, and where it is."""

    id: str
    skill_id: str
    skill_title: str
    action: EditAction
    summary: str
    chat_id: str
    message_id: str
    undone: bool = False
