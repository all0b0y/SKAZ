"""Permission requests, grants and agents' questions in ``knowledge.sqlite3`` (schema ``chats`` v2)."""
from __future__ import annotations

import json
import sqlite3
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal, cast

from ..agents.engine import EngineId
from ..store.database import KnowledgeDatabase

PermissionKind = Literal["create", "edit", "rename", "delete"]
PermissionStatus = Literal["pending", "allowed", "denied", "cancelled", "undone"]
QuestionStatus = Literal["pending", "answered", "superseded", "cancelled"]
PERMISSION_KINDS: tuple[PermissionKind, ...] = ("create", "edit", "rename", "delete")
#: Kinds "Allow in this chat" can cover; deleting a page always asks.
GRANTABLE: frozenset[str] = frozenset({"create", "edit", "rename"})


@dataclass(frozen=True)
class RunRef:
    """The chat answer an agent call belongs to (``message_id`` is the answer, = the run id)."""

    run_id: str
    chat_id: str
    message_id: str
    engine: EngineId


@dataclass(frozen=True)
class PermissionRecord:
    id: str
    chat_id: str
    message_id: str
    run_id: str
    engine: EngineId
    kind: PermissionKind
    page_id: str | None
    title: str
    preview: Mapping[str, Any]
    status: PermissionStatus
    reason: str | None
    auto: bool
    applied: bool
    created_at: str
    decided_at: str | None
    undo: Mapping[str, Any] | None = field(default=None, repr=False)


@dataclass(frozen=True)
class QuestionOption:
    label: str
    description: str = ""
    recommended: bool = False


@dataclass(frozen=True)
class QuestionRecord:
    id: str
    chat_id: str
    message_id: str
    run_id: str
    engine: EngineId
    question: str
    options: tuple[QuestionOption, ...]
    status: QuestionStatus
    answer: str | None
    created_at: str
    answered_at: str | None


def _dump(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _permission(row: sqlite3.Row) -> PermissionRecord:
    return PermissionRecord(
        id=row["id"], chat_id=row["chat_id"], message_id=row["message_id"], run_id=row["run_id"],
        engine=cast(EngineId, row["engine"]), kind=cast(PermissionKind, row["kind"]), page_id=row["page_id"],
        title=row["title"], preview=json.loads(row["preview"] or "{}"),
        status=cast(PermissionStatus, row["status"]), reason=row["reason"], auto=bool(row["auto"]),
        applied=bool(row["applied"]), created_at=row["created_at"], decided_at=row["decided_at"],
        undo=json.loads(row["undo"]) if row["undo"] else None,
    )


def _question(row: sqlite3.Row) -> QuestionRecord:
    options = tuple(QuestionOption(str(item.get("label", "")), str(item.get("description", "")),
                                   bool(item.get("recommended")))
                    for item in json.loads(row["options"] or "[]") if isinstance(item, dict))
    return QuestionRecord(
        id=row["id"], chat_id=row["chat_id"], message_id=row["message_id"], run_id=row["run_id"],
        engine=cast(EngineId, row["engine"]), question=row["question"], options=options,
        status=cast(QuestionStatus, row["status"]), answer=row["answer"], created_at=row["created_at"],
        answered_at=row["answered_at"],
    )


class ControlStore:
    """Plain repository; callers run it off the event loop (``disk_call``)."""

    def __init__(self, db: KnowledgeDatabase) -> None:
        self.db = db

    # -- permissions ------------------------------------------------------------

    def add_permission(self, record: PermissionRecord) -> None:
        with self.db.write() as connection:
            connection.execute(
                "INSERT INTO permission_requests(id, chat_id, message_id, run_id, engine, kind, page_id, "
                "title, preview, status, reason, auto, applied, undo, created_at, decided_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (record.id, record.chat_id, record.message_id, record.run_id, record.engine, record.kind,
                 record.page_id, record.title, _dump(dict(record.preview)), record.status, record.reason,
                 int(record.auto), int(record.applied), _dump(dict(record.undo)) if record.undo else None,
                 record.created_at, record.decided_at),
            )

    def permission(self, permission_id: str) -> PermissionRecord | None:
        with self.db.read() as connection:
            row = connection.execute("SELECT * FROM permission_requests WHERE id = ?",
                                     (permission_id,)).fetchone()
        return _permission(row) if row else None

    def permissions(self, ids: Sequence[str]) -> dict[str, PermissionRecord]:
        if not ids:
            return {}
        marks = ",".join("?" for _ in ids)
        with self.db.read() as connection:
            rows = connection.execute(f"SELECT * FROM permission_requests WHERE id IN ({marks})",
                                      tuple(ids)).fetchall()
        return {row["id"]: _permission(row) for row in rows}

    def update_permission(self, permission_id: str, *, expect: Sequence[str] | None = None,
                          **fields: Any) -> PermissionRecord | None:
        """Change a request; with ``expect``, only while its status is one of them (else ``None``)."""
        allowed = {"status", "reason", "auto", "applied", "undo", "decided_at", "preview", "title", "page_id"}
        if not set(fields) <= allowed:
            raise ValueError("Unknown permission fields")
        values: dict[str, Any] = {}
        for name, value in fields.items():
            if name in ("auto", "applied"):
                values[name] = int(bool(value))
            elif name in ("undo", "preview"):
                values[name] = _dump(dict(value)) if value is not None else None
            else:
                values[name] = value
        assignments = ", ".join(f"{name} = ?" for name in values)
        query = f"UPDATE permission_requests SET {assignments} WHERE id = ?"
        params: list[Any] = [*values.values(), permission_id]
        if expect:
            query += f" AND status IN ({','.join('?' for _ in expect)})"
            params += list(expect)
        with self.db.write() as connection:
            changed = connection.execute(query, params).rowcount
        return self.permission(permission_id) if changed else None

    def pending_permissions(self, *, run_id: str | None = None) -> list[PermissionRecord]:
        query = "SELECT * FROM permission_requests WHERE status = 'pending'"
        params: tuple[str, ...] = ()
        if run_id is not None:
            query += " AND run_id = ?"
            params = (run_id,)
        with self.db.read() as connection:
            return [_permission(row) for row in connection.execute(query, params).fetchall()]

    def grant(self, chat_id: str, kind: str, now: str) -> None:
        if kind not in GRANTABLE:
            raise ValueError("Deleting always asks")
        with self.db.write() as connection:
            connection.execute("INSERT OR IGNORE INTO permission_grants(chat_id, kind, granted_at) "
                               "VALUES (?, ?, ?)", (chat_id, kind, now))

    def granted(self, chat_id: str, kind: str) -> bool:
        if kind not in GRANTABLE:
            return False
        with self.db.read() as connection:
            row = connection.execute("SELECT 1 FROM permission_grants WHERE chat_id = ? AND kind = ?",
                                     (chat_id, kind)).fetchone()
        return row is not None

    # -- questions --------------------------------------------------------------

    def add_question(self, record: QuestionRecord) -> None:
        with self.db.write() as connection:
            connection.execute(
                "INSERT INTO agent_questions(id, chat_id, message_id, run_id, engine, question, options, "
                "status, answer, created_at, answered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (record.id, record.chat_id, record.message_id, record.run_id, record.engine, record.question,
                 _dump([{"label": option.label, "description": option.description,
                         "recommended": option.recommended} for option in record.options]),
                 record.status, record.answer, record.created_at, record.answered_at),
            )

    def question(self, question_id: str) -> QuestionRecord | None:
        with self.db.read() as connection:
            row = connection.execute("SELECT * FROM agent_questions WHERE id = ?", (question_id,)).fetchone()
        return _question(row) if row else None

    def questions(self, ids: Sequence[str]) -> dict[str, QuestionRecord]:
        if not ids:
            return {}
        marks = ",".join("?" for _ in ids)
        with self.db.read() as connection:
            rows = connection.execute(f"SELECT * FROM agent_questions WHERE id IN ({marks})",
                                      tuple(ids)).fetchall()
        return {row["id"]: _question(row) for row in rows}

    def update_question(self, question_id: str, *, expect: Sequence[str] | None = None,
                        **fields: Any) -> QuestionRecord | None:
        if not set(fields) <= {"status", "answer", "answered_at"}:
            raise ValueError("Unknown question fields")
        assignments = ", ".join(f"{name} = ?" for name in fields)
        query = f"UPDATE agent_questions SET {assignments} WHERE id = ?"
        params: list[Any] = [*fields.values(), question_id]
        if expect:
            query += f" AND status IN ({','.join('?' for _ in expect)})"
            params += list(expect)
        with self.db.write() as connection:
            changed = connection.execute(query, params).rowcount
        return self.question(question_id) if changed else None

    def pending_questions(self, *, run_id: str | None = None,
                          chat_id: str | None = None) -> list[QuestionRecord]:
        query = "SELECT * FROM agent_questions WHERE status = 'pending'"
        params: list[str] = []
        if run_id is not None:
            query += " AND run_id = ?"
            params.append(run_id)
        if chat_id is not None:
            query += " AND chat_id = ?"
            params.append(chat_id)
        with self.db.read() as connection:
            return [_question(row) for row in connection.execute(query + " ORDER BY created_at", params)]

    # -- restart -------------------------------------------------------------------

    def cancel_all_pending(self, now: str, reason: str) -> tuple[int, int]:
        """After a restart nothing waits any more: pending requests and questions become ``cancelled``."""
        with self.db.write() as connection:
            permissions = connection.execute(
                "UPDATE permission_requests SET status = 'cancelled', reason = ?, decided_at = ? "
                "WHERE status = 'pending'", (reason, now)).rowcount
            questions = connection.execute(
                "UPDATE agent_questions SET status = 'cancelled', answered_at = ? WHERE status = 'pending'",
                (now,)).rowcount
        return permissions, questions

    def waiting_chats(self) -> set[str]:
        with self.db.read() as connection:
            rows = connection.execute(
                "SELECT chat_id FROM permission_requests WHERE status = 'pending' "
                "UNION SELECT chat_id FROM agent_questions WHERE status = 'pending'").fetchall()
        return {row[0] for row in rows}
