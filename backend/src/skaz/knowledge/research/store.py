"""Research tasks, their permission cards and the per-chat grants (``store/schema/research.py``).

A plain repository: every method blocks, callers run it through ``disk_call``. Rows hold ids, states and
the user's own description; nothing here is sent anywhere.
"""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal, cast

from ..store.database import KnowledgeDatabase

PermissionStatus = Literal["pending", "allowed", "denied", "cancelled"]
_PERMISSION_FIELDS = frozenset({"status", "reason", "decided_at", "task_id", "auto"})


@dataclass(frozen=True)
class TaskRow:
    id: str
    title: str
    description: str
    chat_id: str
    origin_chat_id: str | None
    area_id: str | None
    job_id: str
    request: Mapping[str, Any]
    reported: str | None
    created_at: str
    updated_at: str

    @property
    def topics(self) -> list[str]:
        return [str(topic) for topic in self.request.get("topics") or ()]


@dataclass(frozen=True)
class PermissionRow:
    id: str
    chat_id: str
    message_id: str
    run_id: str
    engine: str
    arguments: Mapping[str, Any]
    topics: tuple[str, ...]
    #: The task's title, given by the agent with the topics.
    title: str | None
    status: PermissionStatus
    auto: bool
    reason: str | None
    task_id: str | None
    created_at: str
    decided_at: str | None


def _task(row: sqlite3.Row) -> TaskRow:
    return TaskRow(
        id=row["id"],
        title=row["title"],
        description=row["description"],
        chat_id=row["chat_id"],
        origin_chat_id=row["origin_chat_id"],
        area_id=row["area_id"],
        job_id=row["job_id"],
        request=json.loads(row["request_json"]),
        reported=row["reported"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def _permission(row: sqlite3.Row) -> PermissionRow:
    return PermissionRow(
        id=row["id"],
        chat_id=row["chat_id"],
        message_id=row["message_id"],
        run_id=row["run_id"],
        engine=row["engine"],
        arguments=json.loads(row["arguments_json"]),
        topics=tuple(str(topic) for topic in json.loads(row["topics_json"] or "[]")),
        title=row["title"],
        status=cast(PermissionStatus, row["status"]),
        auto=bool(row["auto"]),
        reason=row["reason"],
        task_id=row["task_id"],
        created_at=row["created_at"],
        decided_at=row["decided_at"],
    )


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


#: Columns B3 added to schema v1 before 0.4.0 shipped (allowed by the contract); a database made by an
#: earlier 0.4.0 build gets them here, idempotently.
_ADDED_COLUMNS = (
    ("research_tasks", "reported", "TEXT"),
    ("research_permissions", "topics_json", "TEXT NOT NULL DEFAULT '[]'"),
    ("research_permissions", "title", "TEXT"),
)


class ResearchStore:
    def __init__(self, db: KnowledgeDatabase) -> None:
        self.db = db

    def ensure_columns(self) -> None:
        """Once at start (``build_research``): columns added to v1 after an earlier 0.4.0 build made it."""
        with self.db.write() as connection:
            for table, column, kind in _ADDED_COLUMNS:
                names = {row[1] for row in connection.execute(f"PRAGMA table_info({table})").fetchall()}
                if names and column not in names:
                    connection.execute(f"ALTER TABLE {table} ADD COLUMN {column} {kind}")

    # -- tasks ------------------------------------------------------------------------------------------

    def add_task(self, task: TaskRow) -> TaskRow:
        with self.db.write() as connection:
            connection.execute(
                "INSERT INTO research_tasks(id, title, description, chat_id, origin_chat_id, area_id, job_id,"
                " request_json, reported, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    task.id,
                    task.title,
                    task.description,
                    task.chat_id,
                    task.origin_chat_id,
                    task.area_id,
                    task.job_id,
                    _json(dict(task.request)),
                    task.reported,
                    task.created_at,
                    task.updated_at,
                ),
            )
        return task

    def task(self, task_id: str) -> TaskRow | None:
        with self.db.read() as connection:
            row = connection.execute("SELECT * FROM research_tasks WHERE id = ?", (task_id,)).fetchone()
        return _task(row) if row else None

    def task_of_chat(self, chat_id: str) -> TaskRow | None:
        with self.db.read() as connection:
            row = connection.execute("SELECT * FROM research_tasks WHERE chat_id = ?", (chat_id,)).fetchone()
        return _task(row) if row else None

    def tasks(self, offset: int, limit: int) -> tuple[list[TaskRow], bool]:
        with self.db.read() as connection:
            rows = connection.execute(
                "SELECT * FROM research_tasks ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?",
                (limit + 1, offset),
            ).fetchall()
        return [_task(row) for row in rows[:limit]], len(rows) > limit

    def all_tasks(self) -> list[TaskRow]:
        with self.db.read() as connection:
            rows = connection.execute("SELECT * FROM research_tasks ORDER BY created_at").fetchall()
        return [_task(row) for row in rows]

    def chats_of(self, task_ids: Sequence[str]) -> dict[str, str]:
        """task id → its chat (``KbJobSummary.chat_id``)."""
        wanted = list(dict.fromkeys(task_ids))
        if not wanted:
            return {}
        marks = ",".join("?" for _ in wanted)
        with self.db.read() as connection:
            rows = connection.execute(
                f"SELECT id, chat_id FROM research_tasks WHERE id IN ({marks})", wanted
            ).fetchall()
        return {str(row[0]): str(row[1]) for row in rows}

    def touch(self, task_id: str, now: str) -> None:
        with self.db.write() as connection:
            connection.execute("UPDATE research_tasks SET updated_at = ? WHERE id = ?", (now, task_id))

    def set_reported(self, task_id: str, key: str, now: str) -> bool:
        """Records what the chat was told; ``False`` when it was told already (or the task is gone)."""
        with self.db.write() as connection:
            changed = connection.execute(
                "UPDATE research_tasks SET reported = ?, updated_at = ? WHERE id = ?"
                " AND (reported IS NULL OR reported != ?)",
                (key, now, task_id, key),
            ).rowcount
        return changed > 0

    # -- permission cards -----------------------------------------------------------------------------

    def add_permission(self, record: PermissionRow) -> None:
        with self.db.write() as connection:
            connection.execute(
                "INSERT INTO research_permissions(id, chat_id, message_id, run_id, engine, arguments_json,"
                " topics_json, title, status, auto, reason, task_id, created_at, decided_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    record.id,
                    record.chat_id,
                    record.message_id,
                    record.run_id,
                    record.engine,
                    _json(dict(record.arguments)),
                    _json(list(record.topics)),
                    record.title,
                    record.status,
                    int(record.auto),
                    record.reason,
                    record.task_id,
                    record.created_at,
                    record.decided_at,
                ),
            )

    def permission(self, permission_id: str) -> PermissionRow | None:
        with self.db.read() as connection:
            row = connection.execute(
                "SELECT * FROM research_permissions WHERE id = ?", (permission_id,)
            ).fetchone()
        return _permission(row) if row else None

    def update_permission(
        self, permission_id: str, *, expect: Sequence[str] | None = None, **fields: Any
    ) -> PermissionRow | None:
        if not set(fields) <= _PERMISSION_FIELDS:
            raise ValueError("Unknown research permission fields")
        values = {name: int(value) if name == "auto" else value for name, value in fields.items()}
        query = (
            f"UPDATE research_permissions SET {', '.join(f'{name} = ?' for name in values)} WHERE id = ?"
        )
        params: list[Any] = [*values.values(), permission_id]
        if expect:
            query += f" AND status IN ({','.join('?' for _ in expect)})"
            params += list(expect)
        with self.db.write() as connection:
            changed = connection.execute(query, params).rowcount
        return self.permission(permission_id) if changed else None

    def pending(self, *, run_id: str | None = None) -> list[PermissionRow]:
        query = "SELECT * FROM research_permissions WHERE status = 'pending'"
        params: tuple[str, ...] = ()
        if run_id is not None:
            query, params = query + " AND run_id = ?", (run_id,)
        with self.db.read() as connection:
            return [_permission(row) for row in connection.execute(query, params).fetchall()]

    def waiting_chats(self) -> set[str]:
        with self.db.read() as connection:
            rows = connection.execute(
                "SELECT DISTINCT chat_id FROM research_permissions WHERE status = 'pending'"
            ).fetchall()
        return {str(row[0]) for row in rows}

    def cancel_all_pending(self, now: str, reason: str) -> list[str]:
        with self.db.write() as connection:
            ids = [
                str(row[0])
                for row in connection.execute(
                    "SELECT id FROM research_permissions WHERE status = 'pending'"
                ).fetchall()
            ]
            connection.execute(
                "UPDATE research_permissions SET status = 'cancelled', reason = ?, decided_at = ?"
                " WHERE status = 'pending'",
                (reason, now),
            )
        return ids

    # -- grants ----------------------------------------------------------------------------------------

    def grant(self, chat_id: str, now: str) -> None:
        with self.db.write() as connection:
            connection.execute(
                "INSERT OR IGNORE INTO research_grants(chat_id, granted_at) VALUES (?, ?)", (chat_id, now)
            )

    def granted_at(self, chat_id: str) -> str | None:
        with self.db.read() as connection:
            row = connection.execute(
                "SELECT granted_at FROM research_grants WHERE chat_id = ?", (chat_id,)
            ).fetchone()
        return str(row[0]) if row else None

    def revoke(self, chat_id: str) -> bool:
        with self.db.write() as connection:
            deleted = connection.execute("DELETE FROM research_grants WHERE chat_id = ?", (chat_id,))
            return deleted.rowcount > 0
