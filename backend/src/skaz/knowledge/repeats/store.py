"""``material_repeat_checks`` and ``repeat_check_runs`` (B7). Blocking: callers use ``disk_call``.

Evidence holds ids and verdicts only — never material or wiki text — so it can be shown, journalled or
backed up without leaking what the user wrote.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal, cast

from ..store.database import KnowledgeDatabase

Verdict = Literal["repeat", "new", "unsure"]
VERDICTS: tuple[Verdict, ...] = ("repeat", "new", "unsure")


@dataclass(frozen=True)
class StatementRef:
    page_id: str
    block_id: str


@dataclass(frozen=True)
class Judged:
    """One statement of the material compared with the others on its concept page."""

    page_id: str
    block_id: str
    #: Hash of the statement's text when it was compared: an edited statement is not covered by it.
    text_hash: str
    verdict: Verdict
    #: The statement it repeats (``verdict == "repeat"``).
    match: StatementRef | None = None

    @property
    def key(self) -> tuple[str, str]:
        return (self.page_id, self.block_id)


@dataclass
class Evidence:
    material_id: str
    status: Literal["checked", "not_checked"]
    checked_at: datetime | None
    judged: dict[tuple[str, str], Judged] = field(default_factory=dict)


@dataclass(frozen=True)
class Run:
    check_id: str
    area_id: str
    materials_checked: int
    materials_remaining: int


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _encode(judged: dict[tuple[str, str], Judged]) -> str:
    rows = [{"page": item.page_id, "block": item.block_id, "hash": item.text_hash, "verdict": item.verdict,
             "match": ({"page": item.match.page_id, "block": item.match.block_id}
                       if item.match is not None else None)}
            for item in judged.values()]
    return json.dumps({"version": 1, "statements": rows}, separators=(",", ":"))


def _decode(raw: str) -> dict[tuple[str, str], Judged]:
    try:
        data = json.loads(raw)
        rows = data["statements"]
    except (ValueError, KeyError, TypeError):
        return {}
    found: dict[tuple[str, str], Judged] = {}
    for row in rows if isinstance(rows, list) else []:
        try:
            verdict = row["verdict"]
            if verdict not in VERDICTS:
                continue
            match = row.get("match")
            item = Judged(str(row["page"]), str(row["block"]), str(row["hash"]), cast(Verdict, verdict),
                          StatementRef(str(match["page"]), str(match["block"])) if match else None)
        except (KeyError, TypeError, AttributeError):
            continue
        found[item.key] = item
    return found


class RepeatStore:
    def __init__(self, db: KnowledgeDatabase) -> None:
        self._db = db

    # -- per material -----------------------------------------------------------------

    def evidence(self, material_ids: list[str]) -> dict[str, Evidence]:
        if not material_ids:
            return {}
        found: dict[str, Evidence] = {}
        with self._db.read() as connection:
            for start in range(0, len(material_ids), 500):
                chunk = material_ids[start:start + 500]
                rows = connection.execute(
                    "SELECT material_id, status, evidence_json, checked_at FROM material_repeat_checks "
                    f"WHERE material_id IN ({','.join('?' * len(chunk))})", chunk).fetchall()
                for material_id, status, raw, checked_at in rows:
                    found[material_id] = Evidence(
                        material_id, "checked" if status == "checked" else "not_checked",
                        datetime.fromisoformat(checked_at) if checked_at else None, _decode(raw))
        return found

    def save(self, evidence: Evidence) -> None:
        checked_at = evidence.checked_at.isoformat(timespec="seconds") if evidence.checked_at else None
        with self._db.write() as connection:
            connection.execute(
                "INSERT INTO material_repeat_checks(material_id, status, evidence_json, checked_at) "
                "VALUES (?, ?, ?, ?) ON CONFLICT(material_id) DO UPDATE SET status = excluded.status, "
                "evidence_json = excluded.evidence_json, checked_at = excluded.checked_at",
                (evidence.material_id, evidence.status, _encode(evidence.judged), checked_at))

    def forget(self, material_id: str) -> None:
        with self._db.write() as connection:
            connection.execute("DELETE FROM material_repeat_checks WHERE material_id = ?", (material_id,))

    # -- runs -------------------------------------------------------------------------

    def add_run(self, check_id: str, area_id: str, remaining: int) -> None:
        with self._db.write() as connection:
            connection.execute(
                "INSERT INTO repeat_check_runs(id, area_id, materials_checked, materials_remaining) "
                "VALUES (?, ?, 0, ?)", (check_id, area_id, remaining))

    def set_run(self, check_id: str, *, checked: int, remaining: int) -> None:
        with self._db.write() as connection:
            connection.execute(
                "UPDATE repeat_check_runs SET materials_checked = ?, materials_remaining = ? WHERE id = ?",
                (checked, remaining, check_id))

    def run(self, check_id: str) -> Run | None:
        with self._db.read() as connection:
            row = connection.execute(
                "SELECT id, area_id, materials_checked, materials_remaining FROM repeat_check_runs "
                "WHERE id = ?", (check_id,)).fetchone()
        return Run(*row) if row else None

    def runs_of_area(self, area_id: str) -> list[Run]:
        with self._db.read() as connection:
            rows = connection.execute(
                "SELECT id, area_id, materials_checked, materials_remaining FROM repeat_check_runs "
                "WHERE area_id = ? ORDER BY rowid", (area_id,)).fetchall()
        return [Run(*row) for row in rows]


def as_json(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), sort_keys=True)
