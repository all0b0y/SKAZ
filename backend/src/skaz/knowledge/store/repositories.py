"""Typed repositories over ``knowledge.sqlite3``.

Index tables are written only by ``knowledge.index.indexer`` (they are
rebuilt from files); the repositories here read them and own the service
tables (library state, notifications, settings).
"""
from __future__ import annotations

import json
import sqlite3
from collections import defaultdict
from typing import Any

from ..ids import new_id, utc_now
from .database import KnowledgeDatabase
from .records import (
    BlockRecord,
    CitationRecord,
    FolderRecord,
    FragmentRecord,
    LibraryStateRecord,
    MaterialRecord,
    NotificationRecord,
    PageRecord,
)


class LibraryStateRepository:
    def __init__(self, db: KnowledgeDatabase) -> None:
        self.db = db

    def get(self) -> LibraryStateRecord | None:
        with self.db.read() as connection:
            row = connection.execute("SELECT root, library_id, connected_at FROM library_state").fetchone()
        return LibraryStateRecord(row["root"], row["library_id"], row["connected_at"]) if row else None

    def set(self, root: str, library_id: str) -> None:
        with self.db.write() as connection:
            connection.execute(
                "INSERT INTO library_state(id, root, library_id, connected_at) VALUES (1, ?, ?, ?) "
                "ON CONFLICT(id) DO UPDATE SET root = excluded.root, library_id = excluded.library_id, "
                "connected_at = excluded.connected_at",
                (root, library_id, utc_now()),
            )


class SettingsRepository:
    def __init__(self, db: KnowledgeDatabase) -> None:
        self.db = db

    def get(self, key: str, default: Any = None) -> Any:
        with self.db.read() as connection:
            row = connection.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
        return json.loads(row["value"]) if row else default

    def set(self, key: str, value: Any) -> None:
        with self.db.write() as connection:
            connection.execute(
                "INSERT INTO settings(key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, json.dumps(value, ensure_ascii=False)),
            )


def _folder(row: sqlite3.Row) -> FolderRecord:
    return FolderRecord(row["id"], row["name"], row["rel_path"], bool(row["system"]), row["created_at"],
                        row["material_count"])


class FolderRepository:
    _SELECT = (
        "SELECT f.*, (SELECT COUNT(*) FROM materials m WHERE m.folder_id = f.id) AS material_count "
        "FROM folders f"
    )

    def __init__(self, db: KnowledgeDatabase) -> None:
        self.db = db

    def list_all(self) -> list[FolderRecord]:
        with self.db.read() as connection:
            rows = connection.execute(
                f"{self._SELECT} ORDER BY f.system DESC, f.name COLLATE NOCASE").fetchall()
        return [_folder(row) for row in rows]

    def get(self, folder_id: str) -> FolderRecord | None:
        with self.db.read() as connection:
            row = connection.execute(f"{self._SELECT} WHERE f.id = ?", (folder_id,)).fetchone()
        return _folder(row) if row else None


def _material(row: sqlite3.Row) -> MaterialRecord:
    return MaterialRecord(
        id=row["id"], folder_id=row["folder_id"], kind=row["kind"], status=row["status"], title=row["title"],
        rel_dir=row["rel_dir"], source_file=row["source_file"],
        origin=json.loads(row["origin"]) if row["origin"] else None,
        languages=tuple(json.loads(row["languages"])), created_at=row["created_at"],
        fragment_count=row["fragment_count"],
    )


def _fragment(row: sqlite3.Row) -> FragmentRecord:
    return FragmentRecord(row["material_id"], row["seg"], row["ordinal"], row["text"], row["start_ms"],
                          row["end_ms"], row["speaker"], row["page"], row["idx"], row["role"], row["level"])


class MaterialRepository:
    _SELECT = (
        "SELECT m.*, (SELECT COUNT(*) FROM fragments x WHERE x.material_id = m.id) AS fragment_count "
        "FROM materials m"
    )

    def __init__(self, db: KnowledgeDatabase) -> None:
        self.db = db

    def list_all(self, *, folder_id: str | None = None, kind: str | None = None) -> list[MaterialRecord]:
        clauses, params = [], []
        if folder_id is not None:
            clauses.append("m.folder_id = ?")
            params.append(folder_id)
        if kind is not None:
            clauses.append("m.kind = ?")
            params.append(kind)
        where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        with self.db.read() as connection:
            rows = connection.execute(
                f"{self._SELECT}{where} ORDER BY m.created_at DESC, m.title COLLATE NOCASE", params,
            ).fetchall()
        return [_material(row) for row in rows]

    def get(self, material_id: str) -> MaterialRecord | None:
        with self.db.read() as connection:
            row = connection.execute(f"{self._SELECT} WHERE m.id = ?", (material_id,)).fetchone()
        return _material(row) if row else None

    def fragments(self, material_id: str) -> list[FragmentRecord]:
        with self.db.read() as connection:
            rows = connection.execute(
                "SELECT * FROM fragments WHERE material_id = ? ORDER BY ordinal", (material_id,),
            ).fetchall()
        return [_fragment(row) for row in rows]

    def fragments_after(self, material_id: str, after_seg: int, up_to_seg: int) -> list[FragmentRecord]:
        """Fragments with ``after_seg < seg <= up_to_seg`` (``seg`` only grows): a live tail."""
        with self.db.read() as connection:
            rows = connection.execute(
                "SELECT * FROM fragments WHERE material_id = ? AND seg > ? AND seg <= ? ORDER BY ordinal",
                (material_id, after_seg, up_to_seg),
            ).fetchall()
        return [_fragment(row) for row in rows]

    def fragment_map(self, keys: set[tuple[str, int]]) -> dict[tuple[str, int], tuple[FragmentRecord, str]]:
        """``(material_id, seg)`` → (fragment, material title) for the keys that exist."""
        found: dict[tuple[str, int], tuple[FragmentRecord, str]] = {}
        with self.db.read() as connection:
            for material_id, seg in keys:
                row = connection.execute(
                    "SELECT x.*, m.title AS material_title FROM fragments x JOIN materials m "
                    "ON m.id = x.material_id WHERE x.material_id = ? AND x.seg = ?", (material_id, seg),
                ).fetchone()
                if row is not None:
                    found[(material_id, seg)] = (_fragment(row), row["material_title"])
        return found


class PageRepository:
    def __init__(self, db: KnowledgeDatabase) -> None:
        self.db = db

    def _with_lists(self, connection: sqlite3.Connection, rows: list[sqlite3.Row]) -> list[PageRecord]:
        lists: dict[str, dict[str, list[str]]] = defaultdict(lambda: defaultdict(list))
        ids = [row["id"] for row in rows]
        if not ids:
            return []
        marks = ",".join("?" * len(ids))
        for table, column in (("page_folders", "folder_id"), ("page_sources", "material_id"),
                              ("aliases", "alias")):
            for row in connection.execute(
                f"SELECT page_id, {column} AS value FROM {table} WHERE page_id IN ({marks}) ORDER BY rowid",
                ids,
            ):
                lists[row["page_id"]][table].append(row["value"])
        return [
            PageRecord(
                id=row["id"], kind=row["kind"], title=row["title"], rel_path=row["rel_path"],
                original=row["original"], language=row["language"], file_sha256=row["file_sha256"],
                indexed_at=row["indexed_at"], folders=tuple(lists[row["id"]]["page_folders"]),
                sources=tuple(lists[row["id"]]["page_sources"]), aliases=tuple(lists[row["id"]]["aliases"]),
            )
            for row in rows
        ]

    def list_all(self, *, kind: str | None = None, folder_id: str | None = None) -> list[PageRecord]:
        clauses, params = [], []
        if kind is not None:
            clauses.append("p.kind = ?")
            params.append(kind)
        if folder_id is not None:
            clauses.append("EXISTS (SELECT 1 FROM page_folders f WHERE f.page_id = p.id AND f.folder_id = ?)")
            params.append(folder_id)
        where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        with self.db.read() as connection:
            rows = connection.execute(f"SELECT p.* FROM pages p{where} ORDER BY p.title COLLATE NOCASE",
                                      params).fetchall()
            return self._with_lists(connection, rows)

    def get(self, page_id: str) -> PageRecord | None:
        with self.db.read() as connection:
            rows = connection.execute("SELECT * FROM pages WHERE id = ?", (page_id,)).fetchall()
            records = self._with_lists(connection, rows)
        return records[0] if records else None

    def blocks(self, page_id: str) -> list[BlockRecord]:
        with self.db.read() as connection:
            cites: dict[str, list[CitationRecord]] = defaultdict(list)
            for row in connection.execute(
                "SELECT block_id, material_id, seg, quote FROM citations WHERE page_id = ? "
                "ORDER BY block_id, ordinal",
                (page_id,),
            ):
                cites[row["block_id"]].append(CitationRecord(row["material_id"], row["seg"], row["quote"]))
            rows = connection.execute("SELECT * FROM blocks WHERE page_id = ? ORDER BY ordinal",
                                      (page_id,)).fetchall()
        return [
            BlockRecord(row["page_id"], row["block_id"], row["ordinal"], row["section"], row["kind"],
                        row["owner"], row["hash"], row["text"], bool(row["marked"]),
                        tuple(cites[row["block_id"]]))
            for row in rows
        ]


def _notification(row: sqlite3.Row) -> NotificationRecord:
    return NotificationRecord(row["id"], row["kind"], row["title"], row["body"], json.loads(row["payload"]),
                              bool(row["requires_action"]), row["created_at"], row["dismissed_at"],
                              seq=row["seq"], subject=json.loads(row["subject"]) if row["subject"] else None,
                              resolved_at=row["resolved_at"], resolution=row["resolution"],
                              read_at=row["read_at"])


def _subject_of(payload: dict[str, Any] | None) -> dict[str, Any] | None:
    """Kinds raised without a subject open their material (``payload.material_id``), if any."""
    material_id = (payload or {}).get("material_id")
    return {"type": "material", "id": material_id} if isinstance(material_id, str) and material_id else None


_NEXT_SEQ = "(SELECT COALESCE(MAX(seq), 0) + 1 FROM notifications)"


class NotificationRepository:
    def __init__(self, db: KnowledgeDatabase) -> None:
        self.db = db

    def add(self, kind: str, title: str, *, body: str = "", payload: dict[str, Any] | None = None,
            requires_action: bool = False, subject: dict[str, Any] | None = None) -> NotificationRecord:
        notification_id = new_id("ntf")
        subject = subject if subject is not None else _subject_of(payload)
        with self.db.write() as connection:
            connection.execute(
                "INSERT INTO notifications(id, kind, title, body, payload, requires_action, created_at, seq, "
                f"subject) VALUES (?, ?, ?, ?, ?, ?, ?, {_NEXT_SEQ}, ?)",
                (notification_id, kind, title, body, json.dumps(payload or {}, ensure_ascii=False),
                 int(requires_action), utc_now(),
                 json.dumps(subject, ensure_ascii=False) if subject is not None else None),
            )
        record = self.get(notification_id)
        assert record is not None
        return record

    def cursor(self) -> int:
        """The highest ``seq``: every change since a cursor has a larger one."""
        with self.db.read() as connection:
            return int(connection.execute("SELECT COALESCE(MAX(seq), 0) FROM notifications").fetchone()[0])

    def changed_after(self, after: int) -> list[NotificationRecord]:
        """Notifications created or changed after ``after`` (dismissed ones included), newest first."""
        with self.db.read() as connection:
            rows = connection.execute(
                "SELECT * FROM notifications WHERE seq > ? ORDER BY created_at DESC, rowid DESC", (after,),
            ).fetchall()
        return [_notification(row) for row in rows]

    def counters(self) -> tuple[int, int]:
        """(unread, open decisions) among notifications that are not dismissed."""
        with self.db.read() as connection:
            row = connection.execute(
                "SELECT COALESCE(SUM(read_at IS NULL), 0) AS unread, "
                "COALESCE(SUM(requires_action = 1 AND resolved_at IS NULL), 0) AS open "
                "FROM notifications WHERE dismissed_at IS NULL",
            ).fetchone()
        return int(row["unread"]), int(row["open"])

    def resolve(self, notification_id: str, resolution: str) -> NotificationRecord | None:
        """Record the chosen action once; ``None`` when it does not exist. Never overwrites a resolution."""
        with self.db.write() as connection:
            connection.execute(
                f"UPDATE notifications SET resolved_at = ?, resolution = ?, seq = {_NEXT_SEQ} "
                "WHERE id = ? AND resolved_at IS NULL",
                (utc_now(), resolution, notification_id),
            )
        return self.get(notification_id)

    def mark_read(self, up_to_seq: int) -> int:
        """Everything up to ``up_to_seq`` is read; returns how many became read."""
        with self.db.write() as connection:
            cursor = connection.execute(
                "UPDATE notifications SET read_at = ? WHERE read_at IS NULL AND seq <= ?",
                (utc_now(), up_to_seq),
            )
            return cursor.rowcount

    def get(self, notification_id: str) -> NotificationRecord | None:
        with self.db.read() as connection:
            row = connection.execute("SELECT * FROM notifications WHERE id = ?",
                                     (notification_id,)).fetchone()
        return _notification(row) if row else None

    def list_all(self, *, include_dismissed: bool = False) -> list[NotificationRecord]:
        where = "" if include_dismissed else " WHERE dismissed_at IS NULL"
        with self.db.read() as connection:
            rows = connection.execute(
                f"SELECT * FROM notifications{where} ORDER BY created_at DESC, rowid DESC").fetchall()
        return [_notification(row) for row in rows]

    def dismiss(self, notification_id: str) -> NotificationRecord | None:
        with self.db.write() as connection:
            connection.execute(
                f"UPDATE notifications SET dismissed_at = ?, seq = {_NEXT_SEQ} "
                "WHERE id = ? AND dismissed_at IS NULL",
                (utc_now(), notification_id),
            )
        return self.get(notification_id)
