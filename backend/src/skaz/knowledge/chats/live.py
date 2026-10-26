"""N6: a chat's live agent session — what it holds, how the next answer uses it, deleting old ones.

The rule (prefix sync, ``.dev/docs/backlog-2026-10-26/N6-CONTRACT.md``): SKAZ records which chat
messages the agent session already holds (:class:`SessionItem`: message id, a hash of the message as
the history renders it, the agent turn that carried it). Before each answer it compares them with the
messages it would send as history now (:func:`live_entries`) and decides (:func:`plan_session`):

* the session holds exactly that history and no unrecorded turn → ``continue`` (only the new message);
* the session holds more (an edited / regenerated / resumed answer, a failed turn) and dropping whole
  turns from the first differing one leaves exactly that history → ``revert`` before that turn, if the
  engine can revert;
* anything else (no session, another engine, no revert, the history has messages the session never saw,
  the divergence is in the seed turn) → ``start`` a new session seeded with the history; the old session
  is queued for deletion.

Nothing is recorded for an answer that did not finish ``done``; its turn stays the session's "tail" and
is reverted (or the session replaced) by the next answer.
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime

from ..agents.engine import SessionPlan, SessionSupport, TurnMessage
from ..me.prompt import ME_RULES, MeMarks, MeSnapshot, me_notes, needs_reseed
from ..skills import SkazSkill
from ..skills.prompting import skills_block
from ..store.database import KnowledgeDatabase
from .context import INSTRUCTIONS, user_turn_text
from .model import CitePart, ConnectionPart, Message
from .text import agent_text

#: The thin line a chat shows where the agent compacted its conversation (a ``system`` message).
COMPACTED_NOTE = "History compressed"
#: A session the agent refuses to delete this many times is given up (logged by id only).
MAX_DELETE_ATTEMPTS = 5
#: Prefix of every line SKAZ adds to a live turn about what changed on its side.
CONTEXT_MARK = "[context]"
#: Hash of the fixed instruction texts that change only between SKAZ versions (the chat rules, the «Я»
#: rules): a session started with other ones is reseeded once (``SessionContext.base``).
BASE_INSTRUCTIONS = hashlib.sha256(f"{INSTRUCTIONS}\0{ME_RULES}".encode()).hexdigest()[:16]


# -- what the session holds ------------------------------------------------------


@dataclass(frozen=True)
class SessionItem:
    message_id: str
    digest: str
    turn_id: str


@dataclass(frozen=True)
class SessionContext:
    """What SKAZ told the session about its own side (instructions at the start, notes since)."""

    language: str | None = None
    #: Ids of the SKAZ skills that are on.
    skills: tuple[str, ...] = ()
    #: The web-search instruction text the chat's turns get.
    web: str = ""
    #: Materials this chat cited that are deleted from the library.
    gone: tuple[str, ...] = ()
    #: «Я» as the session has it — hashes only, never its text (``None``: a session from before «Я»).
    me: MeMarks | None = None
    #: The «Я» of the turn being built (for the notes); never stored.
    me_view: MeSnapshot | None = field(default=None, compare=False)
    #: Sorted names of the SKAZ tools the session was started with (fixed for its life: Codex
    #: ``thread/resume`` takes no ``dynamicTools``); ``None`` = unknown (a session from before the record).
    tools: tuple[str, ...] | None = None
    #: :data:`BASE_INSTRUCTIONS` the session was started with; ``None`` = unknown.
    base: str | None = None

    def to_json(self) -> str:
        return json.dumps({"language": self.language, "skills": list(self.skills), "web": self.web,
                           "gone": list(self.gone), "me": self.me.to_json() if self.me is not None else None,
                           "tools": list(self.tools) if self.tools is not None else None, "base": self.base},
                          ensure_ascii=False)

    @classmethod
    def from_json(cls, raw: str | None) -> SessionContext | None:
        try:
            data = json.loads(raw or "")
        except ValueError:
            return None
        if not isinstance(data, dict) or "web" not in data:
            return None
        language, tools, base = data.get("language"), data.get("tools"), data.get("base")
        return cls(language if isinstance(language, str) else None,
                   tuple(str(item) for item in data.get("skills") or ()), str(data.get("web") or ""),
                   tuple(str(item) for item in data.get("gone") or ()), MeMarks.from_json(data.get("me")),
                   tools=tuple(str(item) for item in tools) if isinstance(tools, list) else None,
                   base=base if isinstance(base, str) else None)


@dataclass(frozen=True)
class LiveSession:
    chat_id: str
    engine: str
    session_id: str
    model: str | None
    tail_turn_id: str | None
    context: SessionContext | None
    items: tuple[SessionItem, ...] = field(default=())


def digest(turn: TurnMessage) -> str:
    return hashlib.sha256(f"{turn.role}\0{turn.content}".encode()).hexdigest()[:32]


def live_entries(messages: Sequence[Message]) -> list[tuple[str, TurnMessage]]:
    """The history a live session must hold, with message ids: earlier questions and finished answers
    (as ``chats.context.history`` renders them), except an answer that a later regenerated answer to
    the same question replaced — the agent keeps one branch (decision 11)."""
    latest: dict[str, str] = {}
    for message in messages:
        if message.role == "assistant" and message.state == "done" and message.reply_to:
            latest[message.reply_to] = message.id
    entries: list[tuple[str, TurnMessage]] = []
    for message in messages:
        if message.role == "user" and message.input is not None:
            entries.append((message.id, TurnMessage("user", user_turn_text(message.input))))
        elif message.role == "assistant" and message.state == "done":
            if message.reply_to and latest.get(message.reply_to) != message.id:
                continue
            text = agent_text(message.parts)
            if text:
                entries.append((message.id, TurnMessage("assistant", text, message.engine)))
    return entries


def keys(entries: Iterable[tuple[str, TurnMessage]]) -> list[tuple[str, str]]:
    return [(message_id, digest(turn)) for message_id, turn in entries]


# -- the plan of the next answer ----------------------------------------------------


@dataclass(frozen=True)
class SessionDecision:
    plan: SessionPlan
    #: The chat's current session is dropped (and queued for deletion) before the turn.
    replace: bool = False


START = SessionPlan("start")


def plan_session(session: LiveSession | None, engine: str, support: SessionSupport,
                 history: Sequence[tuple[str, str]],
                 now: SessionContext | None = None) -> SessionDecision | None:
    """The plan for the next answer; ``None`` when the engine has no live sessions.

    ``now`` (the context this turn is built with) replaces the session by a new seeded one (once) when
    the session can't have what the turn needs: its tool set or fixed instructions differ (a SKAZ update
    added a tool — a session's tools are fixed at its start; a session without that record counts as
    different), or it holds the profile after the profile (or «Я») was switched off or cleared
    (decision 6)."""
    if not support.live:
        return None
    if session is None:
        return SessionDecision(START)
    if session.engine != engine:
        return SessionDecision(START, replace=True)
    if now is not None and stale(session.context, now):
        return SessionDecision(START, replace=True)
    held = [(item.message_id, item.digest) for item in session.items]
    same = 0
    while same < min(len(held), len(history)) and held[same] == history[same]:
        same += 1
    if same == len(held):
        if same < len(history):  # the history has messages the session never saw
            return SessionDecision(START, replace=True)
        if session.tail_turn_id is None:
            return SessionDecision(SessionPlan("continue", session.session_id))
        if support.revert and held:  # drop the unrecorded turn (a failed or stopped answer)
            return SessionDecision(SessionPlan("revert", session.session_id, session.tail_turn_id))
        return SessionDecision(START, replace=True)
    # The session holds something the history no longer has: drop whole turns from the first change.
    turn = session.items[same].turn_id
    first = next(index for index, item in enumerate(session.items) if item.turn_id == turn)
    if support.revert and first > 0 and first == len(history):
        return SessionDecision(SessionPlan("revert", session.session_id, turn))
    return SessionDecision(START, replace=True)


def stale(held: SessionContext | None, now: SessionContext) -> bool:
    """The session was started with other tools / fixed instructions, or still holds a removed profile."""
    if now.tools is not None and (held is None or held.tools != now.tools):
        return True
    if now.base is not None and (held is None or held.base != now.base):
        return True
    return held is not None and now.me is not None and needs_reseed(held.me, now.me)


# -- context notes (decisions 10, 12) ---------------------------------------------------


def context_note(before: SessionContext | None, now: SessionContext,
                 skills: Sequence[SkazSkill]) -> str:
    """Short factual lines about what changed on SKAZ's side since the session last heard; empty when
    nothing did (or the session predates the record: nothing to compare with)."""
    if before is None:
        return ""
    lines: list[str] = []
    if before.language != now.language:
        lines.append(f"{CONTEXT_MARK} The user's wiki language is now {now.language}: use it when the "
                     "language of a question is unclear." if now.language else
                     f"{CONTEXT_MARK} No wiki language is set now: answer in the language of the question.")
    named = {item.id: item for item in skills}
    added = [named[skill_id] for skill_id in now.skills
             if skill_id not in before.skills and skill_id in named]
    for skill_id in before.skills:
        if skill_id not in now.skills:
            lines.append(f"{CONTEXT_MARK} The user switched off the SKAZ skill “{skill_id}”: "
                         "stop applying it.")
    if added:
        lines.append(f"{CONTEXT_MARK} The user switched on SKAZ skills; apply them from now on.\n"
                     + skills_block(added))
    if before.web != now.web:
        lines.append(f"{CONTEXT_MARK} Web search in this chat changed. From now on: {now.web}")
    for material_id in now.gone:
        if material_id not in before.gone:
            lines.append(f"{CONTEXT_MARK} Material {material_id} was deleted from the library: don't cite it "
                         "and don't search for it.")
    if now.me_view is not None:  # «Я» changed since the session started (decision 6)
        lines += me_notes(before.me, now.me_view)
    return "\n".join(lines)


def cited_materials(messages: Iterable[Message]) -> set[str]:
    found: set[str] = set()
    for message in messages:
        for part in message.parts:
            if isinstance(part, CitePart):
                found.add(part.material_id)
            elif isinstance(part, ConnectionPart):
                found.update(side.material_id for side in part.sides)
    return found


# -- storage -------------------------------------------------------------------------


@dataclass(frozen=True)
class PendingDeletion:
    engine: str
    session_id: str
    attempts: int


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


class SessionStore:
    """``agent_sessions`` / ``agent_session_items`` / ``agent_session_deletions`` (schema module)."""

    def __init__(self, db: KnowledgeDatabase) -> None:
        self._db = db

    def get(self, chat_id: str) -> LiveSession | None:
        with self._db.read() as connection:
            row = connection.execute("SELECT * FROM agent_sessions WHERE chat_id = ?", (chat_id,)).fetchone()
            if row is None:
                return None
            items = connection.execute(
                "SELECT message_id, digest, turn_id FROM agent_session_items WHERE chat_id = ? ORDER BY ord",
                (chat_id,)).fetchall()
        return LiveSession(row["chat_id"], row["engine"], row["session_id"], row["model"],
                           row["tail_turn_id"], SessionContext.from_json(row["context"]),
                           tuple(SessionItem(item[0], item[1], item[2]) for item in items))

    def drop(self, chat_id: str) -> bool:
        """Forget the chat's session; the trigger queues it for deletion in the same transaction."""
        with self._db.write() as connection:
            return connection.execute("DELETE FROM agent_sessions WHERE chat_id = ?", (chat_id,)).rowcount > 0

    def drop_engine(self, engine: str) -> int:
        with self._db.write() as connection:
            return connection.execute("DELETE FROM agent_sessions WHERE engine = ?", (engine,)).rowcount

    def bind(self, chat_id: str, engine: str, session_id: str, model: str | None, turn_id: str,
             plan: SessionPlan, context: SessionContext) -> None:
        """``SessionBound``: the agent took this turn. Until the answer is recorded the turn is the
        session's tail; a new session replaces the chat's old one (which is queued for deletion)."""
        with self._db.write() as connection:
            if connection.execute("SELECT 1 FROM chat_threads WHERE id = ?", (chat_id,)).fetchone() is None:
                self._queue(connection, engine, session_id)  # the chat went meanwhile
                return
            row = connection.execute("SELECT session_id, engine FROM agent_sessions WHERE chat_id = ?",
                                     (chat_id,)).fetchone()
            if plan.mode == "start" or row is None or (row[0], row[1]) != (session_id, engine):
                connection.execute("DELETE FROM agent_sessions WHERE chat_id = ?", (chat_id,))
                connection.execute(
                    "INSERT INTO agent_sessions (chat_id, engine, session_id, model, created_at, "
                    "tail_turn_id, context) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (chat_id, engine, session_id, model, _now(), turn_id, context.to_json()))
                return
            if plan.mode == "revert" and plan.before_turn_id is not None:
                first = connection.execute(
                    "SELECT MIN(ord) FROM agent_session_items WHERE chat_id = ? AND turn_id = ?",
                    (chat_id, plan.before_turn_id)).fetchone()[0]
                if first is not None:
                    connection.execute("DELETE FROM agent_session_items WHERE chat_id = ? AND ord >= ?",
                                       (chat_id, first))
            connection.execute("UPDATE agent_sessions SET tail_turn_id = ? WHERE chat_id = ?",
                               (turn_id, chat_id))

    def record(self, chat_id: str, session_id: str, turn_id: str, items: Sequence[tuple[str, str]],
               context: SessionContext) -> bool:
        """The answer of ``turn_id`` finished ``done``: the session now holds ``items`` as well."""
        with self._db.write() as connection:
            row = connection.execute("SELECT session_id, tail_turn_id FROM agent_sessions WHERE chat_id = ?",
                                     (chat_id,)).fetchone()
            if row is None or row[0] != session_id:
                return False
            last = connection.execute(
                "SELECT COALESCE(MAX(ord), 0) FROM agent_session_items WHERE chat_id = ?",
                (chat_id,)).fetchone()[0]
            connection.executemany(
                "INSERT INTO agent_session_items (chat_id, ord, message_id, digest, turn_id) "
                "VALUES (?, ?, ?, ?, ?)",
                [(chat_id, last + offset, message_id, key, turn_id)
                 for offset, (message_id, key) in enumerate(items, start=1)])
            tail = None if row[1] == turn_id else row[1]
            connection.execute("UPDATE agent_sessions SET tail_turn_id = ?, context = ? WHERE chat_id = ?",
                               (tail, context.to_json(), chat_id))
            return True

    # -- the deletion list --------------------------------------------------------------

    @staticmethod
    def _queue(connection: sqlite3.Connection, engine: str, session_id: str) -> None:
        connection.execute("INSERT OR IGNORE INTO agent_session_deletions "
                           "(engine, session_id, attempts, queued_at) VALUES (?, ?, 0, ?)",
                           (engine, session_id, _now()))

    def queue(self, engine: str, session_id: str) -> None:
        with self._db.write() as connection:
            self._queue(connection, engine, session_id)

    def pending(self) -> list[PendingDeletion]:
        with self._db.read() as connection:
            rows = connection.execute("SELECT engine, session_id, attempts FROM agent_session_deletions "
                                      "ORDER BY queued_at, rowid").fetchall()
        return [PendingDeletion(row[0], row[1], int(row[2])) for row in rows]

    def deleted(self, engine: str, session_id: str) -> None:
        with self._db.write() as connection:
            connection.execute("DELETE FROM agent_session_deletions WHERE engine = ? AND session_id = ?",
                               (engine, session_id))

    def failed(self, engine: str, session_id: str) -> int:
        """One more failed attempt; the entry goes after ``MAX_DELETE_ATTEMPTS``. Returns the count."""
        with self._db.write() as connection:
            row = connection.execute(
                "UPDATE agent_session_deletions SET attempts = attempts + 1 "
                "WHERE engine = ? AND session_id = ? RETURNING attempts", (engine, session_id)).fetchone()
            attempts = int(row[0]) if row is not None else MAX_DELETE_ATTEMPTS
            if attempts >= MAX_DELETE_ATTEMPTS:
                connection.execute("DELETE FROM agent_session_deletions WHERE engine = ? AND session_id = ?",
                                   (engine, session_id))
            return attempts
