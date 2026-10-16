"""``speech_carriers``: the legacy session that carries a speech material."""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from typing import Literal, get_args

from ..ids import utc_now
from ..store.database import KnowledgeDatabase

CarrierKind = Literal["recording", "audio", "video", "video_link"]
CARRIER_KINDS: tuple[CarrierKind, ...] = get_args(CarrierKind)
IMPORT_KINDS: tuple[CarrierKind, ...] = ("audio", "video", "video_link")
#: An import whose session was deleted: there is nothing left to retry.
CANCELLED_IMPORT = "The import was cancelled."


@dataclass(frozen=True)
class Carrier:
    material_id: str
    session_id: str
    kind: CarrierKind
    created_at: str
    attempt_error: str | None = None

    @property
    def is_import(self) -> bool:
        return self.kind in IMPORT_KINDS

    @property
    def can_retry(self) -> bool:
        """A failed or interrupted import can start again (``POST /kb/imports/{id}/retry``, QA E10)."""
        return self.is_import and self.attempt_error is not None and self.attempt_error != CANCELLED_IMPORT


def _carrier(row: sqlite3.Row) -> Carrier:
    return Carrier(row["material_id"], row["session_id"], row["kind"], row["created_at"],
                   row["attempt_error"])


class CarrierRepository:
    def __init__(self, db: KnowledgeDatabase) -> None:
        self.db = db

    def add(self, material_id: str, session_id: str, kind: CarrierKind) -> Carrier:
        """Idempotent for the same pair; a session never carries two materials."""
        with self.db.write() as connection:
            connection.execute(
                "INSERT INTO speech_carriers(material_id, session_id, kind, created_at) VALUES (?, ?, ?, ?) "
                "ON CONFLICT(material_id) DO NOTHING",
                (material_id, session_id, kind, utc_now()),
            )
        carrier = self.get(material_id)
        if carrier is None or carrier.session_id != session_id:
            raise ValueError("This material already has another speech carrier.")
        return carrier

    def get(self, material_id: str) -> Carrier | None:
        with self.db.read() as connection:
            row = connection.execute("SELECT * FROM speech_carriers WHERE material_id = ?",
                                     (material_id,)).fetchone()
        return _carrier(row) if row else None

    def by_session(self, session_id: str) -> Carrier | None:
        with self.db.read() as connection:
            row = connection.execute("SELECT * FROM speech_carriers WHERE session_id = ?",
                                     (session_id,)).fetchone()
        return _carrier(row) if row else None

    def list_all(self, *, kinds: tuple[CarrierKind, ...] = CARRIER_KINDS) -> list[Carrier]:
        marks = ",".join("?" * len(kinds))
        with self.db.read() as connection:
            rows = connection.execute(
                f"SELECT * FROM speech_carriers WHERE kind IN ({marks}) ORDER BY created_at, rowid", kinds,
            ).fetchall()
        return [_carrier(row) for row in rows]

    def set_error(self, material_id: str, error: str | None) -> None:
        with self.db.write() as connection:
            connection.execute("UPDATE speech_carriers SET attempt_error = ? WHERE material_id = ?",
                               (error, material_id))

    def remove(self, material_id: str) -> None:
        with self.db.write() as connection:
            connection.execute("DELETE FROM speech_carriers WHERE material_id = ?", (material_id,))
