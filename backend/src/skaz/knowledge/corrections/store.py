"""Reading/writing ``corrections.json`` and keeping the ``corrections`` index table equal to it."""

from __future__ import annotations

import sqlite3
from collections.abc import Sequence
from dataclasses import replace
from pathlib import Path

from pydantic import ValidationError

from ..errors import NotFound
from ..library.fsio import dump_json, read_json, write_atomic
from ..library.layout import SERVICE_DIR
from ..markdown.source import Fragment
from ..service import KnowledgeService
from .model import CORRECTIONS_FILE, CorrectionEntry, CorrectionsFile, apply_to_text


class CorrectionsUnreadable(ValueError):
    pass


def _insert(connection: sqlite3.Connection, material_id: str, entries: Sequence[CorrectionEntry]) -> None:
    for entry in entries:
        connection.execute(
            "INSERT OR REPLACE INTO corrections(id, material_id, seg, before, after, reason, confidence, "
            "state, created_at, auto, decided_at, start) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                entry.id,
                material_id,
                entry.seg,
                entry.before,
                entry.after,
                entry.reason,
                entry.confidence,
                entry.state,
                entry.created_at,
                int(entry.auto),
                entry.decided_at,
                entry.start,
            ),
        )


class CorrectionStore:
    """One material's file at a time, under the library's write lock (``KnowledgeService.writing``):
    read-modify-write is never interleaved, and a library scan's index rebuild never undoes a write."""

    def __init__(self, kb: KnowledgeService) -> None:
        self.kb = kb
        self.lock = kb.writing()

    def _directory(self, material_id: str) -> Path:
        record = self.kb.material_repo.get(material_id)
        if record is None:
            raise NotFound("Material not found.")
        return self.kb.require().root / record.rel_dir

    def path(self, material_id: str) -> Path:
        return self._directory(material_id) / SERVICE_DIR / CORRECTIONS_FILE

    def read(self, material_id: str) -> CorrectionsFile | None:
        """The file, ``None`` when there is none; ``CorrectionsUnreadable`` when it is damaged."""
        path = self.path(material_id)
        try:
            raw = read_json(path)
        except FileNotFoundError:
            return None
        except (OSError, ValueError, UnicodeDecodeError) as error:
            raise CorrectionsUnreadable(str(error)) from error
        try:
            return CorrectionsFile.model_validate(raw)
        except ValidationError as error:
            raise CorrectionsUnreadable(str(error)) from error

    def read_or_empty(self, material_id: str) -> CorrectionsFile:
        """For readers that must not fail: a damaged file corrects nothing (the recognised text is shown)."""
        try:
            return self.read(material_id) or CorrectionsFile(material_id=material_id)
        except CorrectionsUnreadable:
            return CorrectionsFile(material_id=material_id)

    def write(self, material_id: str, data: CorrectionsFile) -> None:
        with self.lock:
            write_atomic(self.path(material_id), dump_json(data.model_dump(mode="json")))
            self.index(material_id, data)

    def index(self, material_id: str, data: CorrectionsFile | None) -> None:
        with self.kb.db.write_rebuildable() as connection:
            connection.execute("DELETE FROM corrections WHERE material_id = ?", (material_id,))
            if data is not None:
                _insert(connection, material_id, data.corrections)

    def rebuild_index(self) -> None:
        """After a library scan: the table equals the files of the indexed materials."""
        with self.lock:  # a correction saved between these reads and the replace would be lost
            files: list[CorrectionsFile] = []
            for record in self.kb.materials():
                try:
                    data = self.read(record.id)
                except (CorrectionsUnreadable, NotFound, OSError):
                    continue
                if data is not None:
                    files.append(data)
            with self.kb.db.write_rebuildable() as connection:
                connection.execute("DELETE FROM corrections")
                for data in files:
                    _insert(connection, data.material_id, data.corrections)

    def counts(self, material_id: str) -> dict[str, int]:
        with self.kb.db.read() as connection:
            rows = connection.execute(
                "SELECT state, COUNT(*) AS n FROM corrections WHERE material_id = ? GROUP BY state",
                (material_id,),
            ).fetchall()
        return {row["state"]: int(row["n"]) for row in rows}

    def material_of(self, correction_id: str) -> str | None:
        with self.kb.db.read() as connection:
            row = connection.execute(
                "SELECT material_id FROM corrections WHERE id = ?", (correction_id,)
            ).fetchone()
        return str(row["material_id"]) if row else None

    def corrected_text(self, material_id: str, seg: int, original: str) -> str:
        data = self.read_or_empty(material_id)
        return apply_to_text(original, data.for_seg(seg))


class CorrectionsLayer:
    """The ingest ``TextLayer``: fragments with their applied corrections, same ``seg`` ids."""

    def __init__(self, store: CorrectionStore) -> None:
        self.store = store

    def apply(self, material_id: str, fragments: Sequence[Fragment]) -> list[Fragment]:
        data = self.store.read_or_empty(material_id)
        if not data.corrections:
            return list(fragments)
        result = []
        for fragment in fragments:
            entries = data.for_seg(fragment.seg)
            if entries:
                fragment = replace(fragment, text=apply_to_text(fragment.text, entries))
            result.append(fragment)
        return result
