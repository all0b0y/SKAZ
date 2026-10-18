"""Chats in ``knowledge.sqlite3`` (service data; see ``store/schema/chats.py``)."""
from __future__ import annotations

import json
import logging
import sqlite3
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import replace
from typing import Any, cast

from ..agents.engine import EngineId
from ..index.search import fts_query
from ..logsafe import error_note
from ..store.database import KnowledgeDatabase
from .model import Chat, Failure, Message, MessageInput, MessageState, Role, part_to_json, parts_from_json
from .text import plain_text

log = logging.getLogger(__name__)

_CHAT_COLUMNS = frozenset({
    "title", "title_auto", "pinned", "engine", "model", "effort", "folder_ids", "unread", "last_preview",
    "updated_at",
})
RESTART_REASON = "SKAZ was closed before the answer finished."


def _chat(row: sqlite3.Row) -> Chat:
    return Chat(
        id=row["id"], title=row["title"], title_auto=bool(row["title_auto"]), pinned=bool(row["pinned"]),
        engine=cast(EngineId, row["engine"]), model=row["model"], effort=row["effort"],
        recording_material_id=row["recording_material_id"], folder_ids=tuple(json.loads(row["folder_ids"])),
        unread=bool(row["unread"]), last_preview=row["last_preview"], created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def _message(row: sqlite3.Row) -> Message:
    return Message(
        id=row["id"], chat_id=row["chat_id"], seq=int(row["seq"]), role=cast(Role, row["role"]),
        state=cast(MessageState, row["state"]), created_at=row["created_at"],
        parts=tuple(parts_from_json(json.loads(row["parts"]))),
        engine=cast(EngineId | None, row["engine"]), model=row["model"], effort=row["effort"],
        failure=Failure.from_json(json.loads(row["failure"])) if row["failure"] else None,
        input=MessageInput.from_json(json.loads(row["input"])) if row["input"] else None,
        reply_to=row["reply_to"], saved_page_id=row["saved_page_id"],
    )


def _dump(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def searchable_text(message: Message) -> str:
    text = message.input.text if message.input is not None else ""
    return (text + "\n" + plain_text(message.parts)).strip()


class ChatRepository:
    def __init__(self, db: KnowledgeDatabase) -> None:
        self.db = db

    # -- chats ----------------------------------------------------------------

    def create(self, chat: Chat) -> None:
        with self.db.write() as connection:
            connection.execute(
                "INSERT INTO chat_threads(id, title, title_auto, pinned, engine, model, effort, "
                "recording_material_id, folder_ids, unread, last_preview, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (chat.id, chat.title, int(chat.title_auto), int(chat.pinned), chat.engine, chat.model,
                 chat.effort, chat.recording_material_id, _dump(list(chat.folder_ids)), int(chat.unread),
                 chat.last_preview, chat.created_at, chat.updated_at),
            )
            self._index_title(connection, chat.id, chat.title)

    def get(self, chat_id: str) -> Chat | None:
        with self.db.read() as connection:
            row = connection.execute("SELECT * FROM chat_threads WHERE id = ?", (chat_id,)).fetchone()
        return _chat(row) if row else None

    def list_all(self, *, pinned_only: bool = False, recording_only: bool = False,
                 folder_id: str | None = None, ids: Iterable[str] | None = None,
                 limit: int | None = None) -> list[Chat]:
        clauses: list[str] = []
        args: list[Any] = []
        if pinned_only:
            clauses.append("pinned = 1")
        if recording_only:
            clauses.append("recording_material_id IS NOT NULL")
        if folder_id is not None:
            clauses.append("EXISTS (SELECT 1 FROM json_each(chat_threads.folder_ids) WHERE value = ?)")
            args.append(folder_id)
        if ids is not None:
            wanted = list(ids)
            if not wanted:
                return []
            clauses.append(f"id IN ({','.join('?' * len(wanted))})")
            args.extend(wanted)
        where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        sql = f"SELECT * FROM chat_threads{where} ORDER BY updated_at DESC, rowid DESC"
        if limit is not None:
            sql += " LIMIT ?"
            args.append(limit)
        with self.db.read() as connection:
            return [_chat(row) for row in connection.execute(sql, args).fetchall()]

    def count(self) -> int:
        with self.db.read() as connection:
            return int(connection.execute("SELECT COUNT(*) FROM chat_threads").fetchone()[0])

    def search(self, query: str) -> set[str]:
        """Chats whose title or messages contain every word of ``query`` (prefix match)."""
        expression = fts_query(query)
        if expression is None:
            return set()
        with self.db.read() as connection:
            try:
                rows = connection.execute("SELECT DISTINCT chat_id FROM chat_fts WHERE chat_fts MATCH ?",
                                          (expression,)).fetchall()
            except sqlite3.OperationalError as error:
                log.warning("Chat search failed: %s", error_note(error))
                return set()
        return {row[0] for row in rows}

    def update(self, chat_id: str, **values: Any) -> None:
        if not values:
            return
        with self.db.write() as connection:
            self._set_chat(connection, chat_id, values)

    def delete(self, chat_id: str) -> bool:
        with self.db.write() as connection:
            connection.execute("DELETE FROM chat_fts WHERE chat_id = ?", (chat_id,))
            return connection.execute("DELETE FROM chat_threads WHERE id = ?", (chat_id,)).rowcount > 0

    @classmethod
    def _set_chat(cls, connection: sqlite3.Connection, chat_id: str, values: Mapping[str, Any]) -> None:
        unknown = set(values) - _CHAT_COLUMNS
        if unknown:
            raise ValueError(f"Unknown chat columns: {sorted(unknown)}")
        if not values:
            return
        encoded = {key: (_dump(list(value)) if key == "folder_ids" else
                         int(value) if isinstance(value, bool) else value) for key, value in values.items()}
        assignments = ", ".join(f"{key} = ?" for key in encoded)
        connection.execute(f"UPDATE chat_threads SET {assignments} WHERE id = ?",
                           (*encoded.values(), chat_id))
        if "title" in values:
            cls._index_title(connection, chat_id, str(values["title"]))

    @staticmethod
    def _index_title(connection: sqlite3.Connection, chat_id: str, title: str) -> None:
        connection.execute("DELETE FROM chat_fts WHERE chat_id = ? AND message_id = ''", (chat_id,))
        connection.execute("INSERT INTO chat_fts(text, chat_id, message_id) VALUES (?, ?, '')",
                           (title, chat_id))

    # -- messages ---------------------------------------------------------------

    def add_messages(self, messages: Sequence[Message], chat_update: Mapping[str, Any]) -> list[Message]:
        """Insert messages (numbered after the chat's last one) and update their chat, in one transaction."""
        if not messages:
            return []
        chat_id = messages[0].chat_id
        added: list[Message] = []
        with self.db.write() as connection:
            last = int(connection.execute("SELECT COALESCE(MAX(seq), 0) FROM chat_messages WHERE chat_id = ?",
                                          (chat_id,)).fetchone()[0])
            for offset, given in enumerate(messages, start=1):
                message = replace(given, seq=last + offset)
                added.append(message)
                connection.execute(
                    "INSERT INTO chat_messages(id, chat_id, seq, role, state, engine, model, effort, parts, "
                    "failure, input, reply_to, saved_page_id, created_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (message.id, message.chat_id, message.seq, message.role, message.state, message.engine,
                     message.model, message.effort, _dump([part_to_json(part) for part in message.parts]),
                     _dump(message.failure.to_json()) if message.failure else None,
                     _dump(message.input.to_json()) if message.input else None, message.reply_to,
                     message.saved_page_id, message.created_at),
                )
                self._index_message(connection, message)
            self._set_chat(connection, chat_id, chat_update)
        return added

    def save_message(self, message: Message, chat_update: Mapping[str, Any] | None = None) -> None:
        """Write a message's current parts/state/failure (a checkpoint or the end of an answer)."""
        with self.db.write() as connection:
            connection.execute(
                "UPDATE chat_messages SET state = ?, parts = ?, failure = ?, saved_page_id = ? WHERE id = ?",
                (message.state, _dump([part_to_json(part) for part in message.parts]),
                 _dump(message.failure.to_json()) if message.failure else None, message.saved_page_id,
                 message.id),
            )
            self._index_message(connection, message)
            self._set_chat(connection, message.chat_id, chat_update or {})

    def messages(self, chat_id: str) -> list[Message]:
        with self.db.read() as connection:
            rows = connection.execute("SELECT * FROM chat_messages WHERE chat_id = ? ORDER BY seq",
                                      (chat_id,)).fetchall()
        return [_message(row) for row in rows]

    def message(self, chat_id: str, message_id: str) -> Message | None:
        with self.db.read() as connection:
            row = connection.execute("SELECT * FROM chat_messages WHERE chat_id = ? AND id = ?",
                                     (chat_id, message_id)).fetchone()
        return _message(row) if row else None

    def interrupt_streaming(self) -> int:
        """At startup: answers that were streaming when SKAZ stopped become "interrupted" (resumable)."""
        failure = _dump(Failure("other", RESTART_REASON).to_json())
        with self.db.write() as connection:
            return connection.execute(
                "UPDATE chat_messages SET state = 'interrupted', failure = ? WHERE state = 'streaming'",
                (failure,),
            ).rowcount

    @staticmethod
    def _index_message(connection: sqlite3.Connection, message: Message) -> None:
        connection.execute("DELETE FROM chat_fts WHERE message_id = ?", (message.id,))
        if message.role == "system":
            return
        text = searchable_text(message)
        if text:
            connection.execute("INSERT INTO chat_fts(text, chat_id, message_id) VALUES (?, ?, ?)",
                               (text, message.chat_id, message.id))
