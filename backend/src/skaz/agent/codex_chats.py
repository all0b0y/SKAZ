"""Versioned local chats. Opening history never launches or contacts Codex.

The context of a revoked chat is never eligible for model submission again.
Group membership is authoritative backend state, never renderer-supplied IDs.
"""

from __future__ import annotations

import builtins
import json
import sqlite3
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from ..db import Database


class ChatAccessRevoked(ValueError):
    pass


def now() -> str:
    return datetime.now(UTC).isoformat(timespec="microseconds")


# Why a new Group chat is refused; the renderer shows the same reasons up front.
GROUP_UNAVAILABLE = {
    "storage_off": "Group chats need file mode (Settings → Files) and this session in a group.",
    "not_in_group": (
        "This session isn’t in a group. Add it to one in the sidebar to start a Group chat."
    ),
}


class ChatStore:
    def __init__(self, db: Database) -> None:
        self.db = db
        with db.write() as c:
            c.execute("CREATE TABLE IF NOT EXISTS codex_schema(version INTEGER NOT NULL)")
            row = c.execute("SELECT version FROM codex_schema").fetchone()
            if row is not None and row[0] != 1:
                raise ValueError("Unsupported Codex storage version")
            for sql in (
                "CREATE TABLE IF NOT EXISTS codex_chats("
                "id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, "
                "title TEXT NOT NULL, scope TEXT NOT NULL, group_id TEXT, seen TEXT NOT NULL DEFAULT '[]', "
                "revoked INTEGER NOT NULL DEFAULT 0, manual_title INTEGER NOT NULL DEFAULT 0, "
                "updated_at TEXT NOT NULL, unread INTEGER NOT NULL DEFAULT 0)",
                "CREATE TABLE IF NOT EXISTS codex_messages("
                "seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, "
                "chat_id TEXT NOT NULL REFERENCES codex_chats(id) ON DELETE CASCADE, "
                "role TEXT NOT NULL, content TEXT NOT NULL, citations TEXT NOT NULL, "
                "created_at TEXT NOT NULL)",
                "CREATE INDEX IF NOT EXISTS codex_messages_chat ON codex_messages(chat_id,seq)",
                "CREATE TABLE IF NOT EXISTS codex_selected("
                "session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, "
                "chat_id TEXT REFERENCES codex_chats(id) ON DELETE SET NULL)",
                "CREATE TABLE IF NOT EXISTS codex_legacy_migrated("
                "session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE)",
                # Revocation commits with source deletion, including out-of-band repository writes.
                "CREATE TRIGGER IF NOT EXISTS codex_source_deleted BEFORE DELETE ON sessions BEGIN "
                "UPDATE codex_chats SET revoked=1 WHERE EXISTS "
                "(SELECT 1 FROM json_each(seen) WHERE value=OLD.id); END",
                # Catch remove-and-readd between requests, not merely the latest membership view.
                "CREATE TRIGGER IF NOT EXISTS codex_group_changed AFTER UPDATE OF doc ON physical_storage "
                "BEGIN UPDATE codex_chats SET revoked=1 WHERE scope='group' AND "
                "(COALESCE(json_extract(NEW.doc,'$.membership.'||session_id),'') != group_id OR EXISTS "
                "(SELECT 1 FROM json_each(seen) WHERE "
                "COALESCE(json_extract(NEW.doc,'$.membership.'||value),'') != group_id)); END",
            ):
                c.execute(sql)
            if row is None:
                c.execute("INSERT INTO codex_schema VALUES (1)")
            self._migrate(c)

    @staticmethod
    def _migrate(c: sqlite3.Connection) -> None:
        sessions = c.execute(
            "SELECT DISTINCT session_id FROM messages WHERE session_id NOT IN "
            "(SELECT session_id FROM codex_legacy_migrated)",
        ).fetchall()
        for row in sessions:
            sid, cid = row[0], uuid4().hex
            sources = {sid}
            for message in c.execute("SELECT citations FROM messages WHERE session_id=?", (sid,)):
                for citation in json.loads(message[0]):
                    sources.add(citation.get("session_id") or sid)
            # Legacy multi-session history cannot silently acquire a wider session scope.
            revoked = int(sources != {sid})
            c.execute(
                "INSERT INTO codex_chats(id,session_id,title,scope,seen,revoked,manual_title,updated_at) "
                "VALUES (?,?,'Previous conversation','session',?,?,1,?)",
                (cid, sid, json.dumps(sorted(sources)), revoked, now()),
            )
            c.execute(
                "INSERT INTO codex_messages(id,chat_id,role,content,citations,created_at) "
                "SELECT id,?,role,content,citations,created_at FROM messages WHERE session_id=? "
                "ORDER BY created_at,rowid",
                (cid, sid),
            )
            c.execute("INSERT OR IGNORE INTO codex_selected VALUES (?,?)", (sid, cid))
            c.execute("INSERT INTO codex_legacy_migrated VALUES (?)", (sid,))

    @staticmethod
    def _view(row: sqlite3.Row) -> dict[str, Any]:
        result = dict(row)
        result["seen"] = json.loads(result["seen"])
        result["revoked"] = bool(result["revoked"])
        result["unread"] = bool(result["unread"])
        return result

    def get(self, chat_id: str) -> dict[str, Any]:
        with self.db.read() as c:
            row = c.execute("SELECT * FROM codex_chats WHERE id=?", (chat_id,)).fetchone()
            if row is None:
                raise ValueError("Unknown chat")
            return self._view(row)

    def list(self, session_id: str) -> builtins.list[dict[str, Any]]:
        with self.db.read() as c:
            return [
                self._view(row)
                for row in c.execute(
                    "SELECT * FROM codex_chats WHERE session_id=? ORDER BY updated_at DESC,id",
                    (session_id,),
                )
            ]

    def group_scope(self, session_id: str) -> str:
        """Whether a new chat of this session can use the Group scope, and if not, why."""
        with self.db.read() as c:
            return self._group_scope(c, session_id)

    @staticmethod
    def _group_scope(c: sqlite3.Connection, session_id: str) -> str:
        # Browser-only groups never reach the backend; only file-mode membership counts.
        row = c.execute("SELECT doc FROM physical_storage WHERE id=1").fetchone()
        if row is None:
            return "storage_off"
        if json.loads(row[0])["membership"].get(session_id) is None:
            return "not_in_group"
        return "available"

    def _scope(self, c: sqlite3.Connection, chat: dict[str, Any]) -> tuple[str, ...]:
        sid = chat["session_id"]
        if c.execute("SELECT 1 FROM sessions WHERE id=?", (sid,)).fetchone() is None:
            return ()
        if chat["scope"] == "session":
            return (sid,)
        ids = tuple(row[0] for row in c.execute("SELECT id FROM sessions ORDER BY id"))
        if chat["scope"] == "all":
            return ids
        row = c.execute("SELECT doc FROM physical_storage WHERE id=1").fetchone()
        membership = json.loads(row[0])["membership"] if row else {}
        group = chat.get("group_id") or membership.get(sid)
        if group is None or membership.get(sid) != group:
            return ()
        return tuple(identity for identity in ids if membership.get(identity) == group)

    def create(self, session_id: str, scope: str, *, select: bool = True) -> dict[str, Any]:
        if scope not in ("session", "group", "all"):
            raise ValueError("Invalid scope")
        identity = uuid4().hex
        with self.db.write() as c:
            chat = {"session_id": session_id, "scope": scope}
            ids = self._scope(c, chat)
            if not ids:
                exists = c.execute("SELECT 1 FROM sessions WHERE id=?", (session_id,)).fetchone()
                reason = self._group_scope(c, session_id) if scope == "group" and exists else ""
                raise ValueError(GROUP_UNAVAILABLE.get(reason, "Session unavailable"))
            group = None
            if scope == "group":
                row = c.execute("SELECT doc FROM physical_storage WHERE id=1").fetchone()
                group = json.loads(row[0])["membership"][session_id]
            c.execute(
                "INSERT INTO codex_chats(id,session_id,title,scope,group_id,seen,updated_at) "
                "VALUES (?,?,'New chat',?,?,?,?)",
                (identity, session_id, scope, group, json.dumps(ids), now()),
            )
            if select:
                c.execute("INSERT OR REPLACE INTO codex_selected VALUES (?,?)", (session_id, identity))
        return self.get(identity)

    def authorize(self, chat_id: str) -> tuple[str, ...]:
        with self.db.write() as c:
            chat = self.get(chat_id)
            ids = self._scope(c, chat)
            revoked = chat["revoked"] or not set(chat["seen"]).issubset(ids) or not ids
            if revoked:
                c.execute("UPDATE codex_chats SET revoked=1 WHERE id=?", (chat_id,))
            else:
                c.execute("UPDATE codex_chats SET seen=? WHERE id=?", (json.dumps(ids), chat_id))
        # Raise after committing the permanent revocation.
        if revoked:
            raise ChatAccessRevoked("Source access changed. Start a new chat; this history is read-only.")
        return ids

    def context(self, chat_id: str) -> builtins.list[dict[str, Any]]:
        self.authorize(chat_id)
        messages = self.messages(chat_id)
        if sum(len(m["content"].encode()) for m in messages) > 128 * 1024:
            raise ValueError("Chat context limit reached. Start a new chat; history is retained.")
        return messages

    def messages(self, chat_id: str) -> builtins.list[dict[str, Any]]:
        self.get(chat_id)
        with self.db.read() as c:
            return [
                {**dict(row), "citations": json.loads(row["citations"])}
                for row in c.execute(
                    "SELECT id,role,content,citations,created_at FROM codex_messages "
                    "WHERE chat_id=? ORDER BY seq",
                    (chat_id,),
                )
            ]

    def append(
        self,
        chat_id: str,
        role: str,
        content: str,
        citations: builtins.list[dict[str, Any]],
        *,
        identity: str | None = None,
    ) -> None:
        if role not in ("user", "assistant") or len(content.encode()) > 1024 * 1024:
            raise ValueError("Invalid message")
        with self.db.write() as c:
            chat = self.get(chat_id)
            c.execute(
                "INSERT OR IGNORE INTO codex_messages(id,chat_id,role,content,citations,created_at) "
                "VALUES (?,?,?,?,?,?)",
                (identity or uuid4().hex, chat_id, role, content, json.dumps(citations), now()),
            )
            title = chat["title"]
            # Chats created before the English-only UI still carry the Russian default.
            if role == "user" and not chat["manual_title"] and title in ("New chat", "Новый чат"):
                title = " ".join(content.split())[:80] or title
            c.execute(
                "UPDATE codex_chats SET title=?,updated_at=?,unread=? WHERE id=?",
                (title, now(), int(role == "assistant"), chat_id),
            )

    def rename(self, chat_id: str, title: str) -> None:
        title = " ".join(title.split())
        if not title or len(title) > 120:
            raise ValueError("Chat title must contain 1–120 characters")
        with self.db.write() as c:
            self.get(chat_id)
            c.execute("UPDATE codex_chats SET title=?,manual_title=1 WHERE id=?", (title, chat_id))

    def select(self, chat_id: str) -> None:
        with self.db.write() as c:
            chat = self.get(chat_id)
            c.execute("INSERT OR REPLACE INTO codex_selected VALUES (?,?)", (chat["session_id"], chat_id))
            c.execute("UPDATE codex_chats SET unread=0 WHERE id=?", (chat_id,))

    def selected(self, session_id: str) -> str | None:
        with self.db.read() as c:
            row = c.execute("SELECT chat_id FROM codex_selected WHERE session_id=?", (session_id,)).fetchone()
            return row[0] if row else None

    def delete(self, chat_id: str, *, confirmed: bool) -> None:
        if confirmed is not True:
            raise ValueError("Permanent deletion requires confirmation")
        with self.db.write() as c:
            self.get(chat_id)
            c.execute("DELETE FROM codex_chats WHERE id=?", (chat_id,))
