"""B6's tables (``freshness_marks``, ``weekly_checks``), its two settings, and the wiki rows it reads.

Blocking repository: callers run it through ``disk_call``. Marks keep their evidence as JSON (the
matching ``KbFreshnessMark`` fields); one mark per material, kind and ``key`` (a version mark is one per
material; a "newer source disagrees" mark is one per disagreement), so a check run twice never doubles one.
"""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from ..errors import KnowledgeError
from ..ids import new_id, utc_now_ms
from ..store.database import KnowledgeDatabase
from ..store.repositories import SettingsRepository

ENABLED = "weekly_check.enabled"
ENABLED_AT = "weekly_check.enabled_at"
MAX_STATEMENTS = 50


class CheckExists(KnowledgeError):
    status_code = 409


@dataclass(frozen=True)
class MarkRow:
    id: str
    material_id: str
    kind: str
    evidence: dict[str, Any]
    kept_marked: bool
    created_at: str


@dataclass(frozen=True)
class CheckRow:
    id: str
    trigger: str
    due_at: str
    completed_at: str | None
    candidates_waiting: int
    candidate_ids: list[str]
    counts: dict[str, Any]


@dataclass(frozen=True)
class CitedStatement:
    page_id: str
    title: str
    block_id: str
    others: tuple[str, ...]


@dataclass(frozen=True)
class Disagreement:
    id: str
    page_id: str
    block_a: str
    block_b: str


def parse_stamp(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def stamp(value: datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _mark(row: sqlite3.Row) -> MarkRow:
    return MarkRow(
        id=str(row["id"]),
        material_id=str(row["material_id"]),
        kind=str(row["kind"]),
        evidence=json.loads(row["evidence_json"]),
        kept_marked=bool(row["kept_marked"]),
        created_at=str(row["created_at"]),
    )


def _check(row: sqlite3.Row) -> CheckRow:
    return CheckRow(
        id=str(row["id"]),
        trigger=str(row["trigger"]),
        due_at=str(row["due_at"]),
        completed_at=row["completed_at"],
        candidates_waiting=int(row["candidates_waiting"]),
        candidate_ids=list(json.loads(row["candidate_ids_json"])),
        counts=dict(json.loads(row["counts_json"])),
    )


def _dump(data: Mapping[str, Any] | Sequence[Any]) -> str:
    return json.dumps(data, separators=(",", ":"), sort_keys=True)


class MaintenanceStore:
    def __init__(self, db: KnowledgeDatabase, settings: SettingsRepository) -> None:
        self.db = db
        self.settings = settings

    # -- settings -------------------------------------------------------------------------------------

    def enabled(self) -> bool:
        return self.settings.get(ENABLED, False) is True

    def enabled_at(self) -> datetime | None:
        return parse_stamp(self.settings.get(ENABLED_AT))

    def set_enabled(self, enabled: bool, now: datetime) -> None:
        if enabled == self.enabled():
            return
        self.settings.set(ENABLED, enabled)
        self.settings.set(ENABLED_AT, stamp(now) if enabled else None)

    # -- marks ----------------------------------------------------------------------------------------

    def mark(self, mark_id: str) -> MarkRow | None:
        with self.db.read() as connection:
            row = connection.execute("SELECT * FROM freshness_marks WHERE id = ?", (mark_id,)).fetchone()
        return None if row is None else _mark(row)

    def marks_of(self, material_ids: Sequence[str]) -> list[MarkRow]:
        ids = list(dict.fromkeys(material_ids))
        if not ids:
            return []
        found: list[MarkRow] = []
        with self.db.read() as connection:
            for start in range(0, len(ids), 500):
                chunk = ids[start : start + 500]
                marks = ",".join("?" for _ in chunk)
                rows = connection.execute(
                    f"SELECT * FROM freshness_marks WHERE material_id IN ({marks}) ORDER BY created_at, id",
                    chunk,
                ).fetchall()
                found.extend(_mark(row) for row in rows)
        return found

    def upsert(self, material_id: str, kind: str, key: str, evidence: Mapping[str, Any]) -> tuple[str, bool]:
        """Returns the mark id and whether it is a new fact: a new mark, or another version than the mark had
        (which also clears "Keep, marked")."""
        with self.db.write() as connection:
            rows = connection.execute(
                "SELECT * FROM freshness_marks WHERE material_id = ? AND kind = ?", (material_id, kind)
            ).fetchall()
            existing = next((mark for mark in map(_mark, rows) if mark.evidence.get("key") == key), None)
            if existing is None:
                mark_id = new_id("mark")
                connection.execute(
                    "INSERT INTO freshness_marks(id, material_id, kind, evidence_json, kept_marked,"
                    " created_at) VALUES (?, ?, ?, ?, 0, ?)",
                    (mark_id, material_id, kind, _dump({**evidence, "key": key}), utc_now_ms()),
                )
                return mark_id, True
            merged = {**existing.evidence, **evidence, "key": key}
            changed_fact = existing.evidence.get("version") != merged.get("version")
            connection.execute(
                "UPDATE freshness_marks SET evidence_json = ?, kept_marked = ? WHERE id = ?",
                (_dump(merged), 0 if changed_fact else int(existing.kept_marked), existing.id),
            )
            return existing.id, changed_fact

    def update_evidence(self, mark_id: str, changes: Mapping[str, Any]) -> None:
        with self.db.write() as connection:
            row = connection.execute(
                "SELECT evidence_json FROM freshness_marks WHERE id = ?", (mark_id,)
            ).fetchone()
            if row is None:
                return
            connection.execute(
                "UPDATE freshness_marks SET evidence_json = ? WHERE id = ?",
                (_dump({**json.loads(row[0]), **changes}), mark_id),
            )

    def keep(self, mark_id: str) -> None:
        with self.db.write() as connection:
            connection.execute("UPDATE freshness_marks SET kept_marked = 1 WHERE id = ?", (mark_id,))

    def remove_unkept(self, material_id: str, kind: str) -> None:
        with self.db.write() as connection:
            connection.execute(
                "DELETE FROM freshness_marks WHERE material_id = ? AND kind = ? AND kept_marked = 0",
                (material_id, kind),
            )

    # -- the wiki (read only) -------------------------------------------------------------------------

    def material_ids_on_page(self, page_id: str) -> list[str]:
        with self.db.read() as connection:
            rows = connection.execute(
                "SELECT DISTINCT material_id FROM citations WHERE page_id = ? ORDER BY material_id",
                (page_id,),
            ).fetchall()
        return [str(row[0]) for row in rows]

    def page_exists(self, page_id: str) -> bool:
        with self.db.read() as connection:
            return connection.execute("SELECT 1 FROM pages WHERE id = ?", (page_id,)).fetchone() is not None

    def cited_statements(
        self,
        material_id: str,
        *,
        page_id: str | None = None,
        blocks: Sequence[tuple[str, str]] | None = None,
    ) -> list[CitedStatement]:
        """Marked wiki statements citing the material (``blocks`` narrows them), with the other sources."""
        query = (
            "SELECT DISTINCT c.page_id, c.block_id, p.title, b.ordinal FROM citations c"
            " JOIN pages p ON p.id = c.page_id"
            " JOIN blocks b ON b.page_id = c.page_id AND b.block_id = c.block_id"
            " WHERE c.material_id = ? AND b.marked = 1"
        )
        params: list[Any] = [material_id]
        if page_id is not None:
            query += " AND c.page_id = ?"
            params.append(page_id)
        query += " ORDER BY p.title, c.page_id, b.ordinal"
        wanted = set(blocks) if blocks is not None else None
        found: list[CitedStatement] = []
        with self.db.read() as connection:
            for row in connection.execute(query, params).fetchall():
                key = (str(row["page_id"]), str(row["block_id"]))
                if wanted is not None and key not in wanted:
                    continue
                others = connection.execute(
                    "SELECT DISTINCT c.material_id FROM citations c JOIN materials m ON m.id = c.material_id"
                    " WHERE c.page_id = ? AND c.block_id = ? AND c.material_id != ? ORDER BY c.material_id",
                    (key[0], key[1], material_id),
                ).fetchall()
                found.append(
                    CitedStatement(key[0], str(row["title"]), key[1], tuple(str(o[0]) for o in others))
                )
                if len(found) >= MAX_STATEMENTS:
                    break
        return found

    def disagreements(self) -> list[Disagreement]:
        with self.db.read() as connection:
            rows = connection.execute(
                "SELECT id, page_id, block_a, block_b FROM wiki_discrepancies ORDER BY created_at, id"
            ).fetchall()
        return [Disagreement(str(r[0]), str(r[1]), str(r[2]), str(r[3])) for r in rows]

    def block_material(self, page_id: str, block_id: str) -> str | None:
        """The source a statement rests on (its first citation), as the disagreement check compared it."""
        with self.db.read() as connection:
            row = connection.execute(
                "SELECT material_id FROM citations WHERE page_id = ? AND block_id = ?"
                " ORDER BY ordinal LIMIT 1",
                (page_id, block_id),
            ).fetchone()
        return None if row is None else str(row[0])

    # -- weekly checks --------------------------------------------------------------------------------

    def create_check(self, job_id: str, trigger: str, due_at: str) -> CheckRow:
        try:
            with self.db.write() as connection:
                connection.execute(
                    "INSERT INTO weekly_checks(id, trigger, due_at) VALUES (?, ?, ?)",
                    (job_id, trigger, due_at),
                )
        except sqlite3.IntegrityError as error:
            raise CheckExists("A check for this week already exists.") from error
        found = self.check(job_id)
        assert found is not None
        return found

    def check(self, job_id: str) -> CheckRow | None:
        with self.db.read() as connection:
            row = connection.execute("SELECT * FROM weekly_checks WHERE id = ?", (job_id,)).fetchone()
        return None if row is None else _check(row)

    def latest(self) -> CheckRow | None:
        with self.db.read() as connection:
            row = connection.execute(
                "SELECT * FROM weekly_checks ORDER BY due_at DESC, id DESC LIMIT 1"
            ).fetchone()
        return None if row is None else _check(row)

    def latest_completed(self) -> CheckRow | None:
        with self.db.read() as connection:
            row = connection.execute(
                "SELECT * FROM weekly_checks WHERE completed_at IS NOT NULL"
                " ORDER BY completed_at DESC, id DESC LIMIT 1"
            ).fetchone()
        return None if row is None else _check(row)

    def set_counts(self, job_id: str, changes: Mapping[str, Any]) -> None:
        with self.db.write() as connection:
            row = connection.execute(
                "SELECT counts_json FROM weekly_checks WHERE id = ?", (job_id,)
            ).fetchone()
            if row is None:
                return
            connection.execute(
                "UPDATE weekly_checks SET counts_json = ? WHERE id = ?",
                (_dump({**json.loads(row[0]), **changes}), job_id),
            )

    def finish(self, job_id: str, *, completed_at: str, candidate_ids: Sequence[str]) -> None:
        with self.db.write() as connection:
            connection.execute(
                "UPDATE weekly_checks SET completed_at = ?, candidates_waiting = ?, candidate_ids_json = ?"
                " WHERE id = ?",
                (completed_at, len(candidate_ids), _dump(list(candidate_ids)), job_id),
            )
