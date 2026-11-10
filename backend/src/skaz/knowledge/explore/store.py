"""B2's own tables: ``explore_runs``, ``explore_findings``, ``explore_readings``. Blocking repository."""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from ..ids import new_id, utc_now_ms
from ..store.database import KnowledgeDatabase


@dataclass(frozen=True)
class RunRow:
    id: str
    area_id: str | None
    task_id: str | None
    request: Mapping[str, Any]


@dataclass(frozen=True)
class FindingRow:
    id: str
    run_id: str
    task_id: str | None
    area_id: str | None
    work_id: str
    channel: str
    label: str
    reason: str
    theses: list[dict[str, Any]]
    details: dict[str, Any]
    material_id: str | None
    created_at: str


@dataclass(frozen=True)
class ReadingRow:
    id: str
    finding_id: str
    chat_id: str
    mode: str
    text_kind: str
    material_id: str | None
    started_at: str


def _finding(row: sqlite3.Row) -> FindingRow:
    return FindingRow(
        id=row["id"],
        run_id=row["run_id"],
        task_id=row["task_id"],
        area_id=row["area_id"],
        work_id=row["work_id"],
        channel=row["channel"],
        label=row["label"],
        reason=row["reason"],
        theses=json.loads(row["theses_json"]),
        details=json.loads(row["details_json"]),
        material_id=row["material_id"],
        created_at=row["created_at"],
    )


class ExploreStore:
    def __init__(self, db: KnowledgeDatabase) -> None:
        self.db = db

    # -- runs ---------------------------------------------------------------------------------------

    def create_run(
        self, job_id: str, *, area_id: str | None, task_id: str | None, request: Mapping[str, Any]
    ) -> None:
        with self.db.write() as connection:
            connection.execute(
                "INSERT INTO explore_runs(id, area_id, task_id, request_json) VALUES (?, ?, ?, ?)",
                (job_id, area_id, task_id, json.dumps(dict(request), ensure_ascii=False)),
            )

    def run(self, run_id: str) -> RunRow | None:
        with self.db.read() as connection:
            row = connection.execute("SELECT * FROM explore_runs WHERE id = ?", (run_id,)).fetchone()
        if row is None:
            return None
        return RunRow(row["id"], row["area_id"], row["task_id"], json.loads(row["request_json"]))

    def runs(self, run_ids: Sequence[str]) -> dict[str, RunRow]:
        if not run_ids:
            return {}
        marks = ",".join("?" for _ in run_ids)
        with self.db.read() as connection:
            rows = connection.execute(
                f"SELECT * FROM explore_runs WHERE id IN ({marks})", tuple(run_ids)
            ).fetchall()
        return {
            row["id"]: RunRow(row["id"], row["area_id"], row["task_id"], json.loads(row["request_json"]))
            for row in rows
        }

    def task_runs(self, task_ids: Sequence[str]) -> dict[str, str]:
        """task id → its newest run id (the job whose state the group heading shows)."""
        if not task_ids:
            return {}
        marks = ",".join("?" for _ in task_ids)
        with self.db.read() as connection:
            rows = connection.execute(
                "SELECT r.task_id AS task_id, r.id AS id FROM explore_runs r"
                " JOIN explore_jobs j ON j.id = r.id"
                f" WHERE r.task_id IN ({marks}) ORDER BY j.created_at",
                tuple(task_ids),
            ).fetchall()
        return {row["task_id"]: row["id"] for row in rows}

    def latest_checked(self, *, area_id: str | None, task_id: str | None) -> str | None:
        """When the newest finished run of this scope finished."""
        sql = (
            "SELECT max(j.updated_at) FROM explore_runs r JOIN explore_jobs j ON j.id = r.id"
            " WHERE j.state = 'done'"
        )
        params: list[str] = []
        if area_id is not None:
            sql += " AND r.area_id = ?"
            params.append(area_id)
        if task_id is not None:
            sql += " AND r.task_id = ?"
            params.append(task_id)
        with self.db.read() as connection:
            row = connection.execute(sql, params).fetchone()
        return None if row is None or row[0] is None else str(row[0])

    # -- findings -----------------------------------------------------------------------------------

    def add_finding(
        self,
        *,
        run_id: str,
        task_id: str | None,
        area_id: str | None,
        work_id: str,
        channel: str,
        label: str,
        reason: str,
        theses: Sequence[Mapping[str, Any]],
        details: Mapping[str, Any],
    ) -> str:
        """One finding per work and run; a second add of the same work returns the first one."""
        finding_id = new_id("finding")
        with self.db.write() as connection:
            connection.execute(
                "INSERT OR IGNORE INTO explore_findings(id, run_id, task_id, area_id, work_id, channel,"
                " label,"
                " reason, theses_json, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    finding_id,
                    run_id,
                    task_id,
                    area_id,
                    work_id,
                    channel,
                    label,
                    reason,
                    json.dumps(list(theses), ensure_ascii=False),
                    json.dumps(dict(details), ensure_ascii=False),
                    utc_now_ms(),
                ),
            )
            row = connection.execute(
                "SELECT id FROM explore_findings WHERE run_id = ? AND work_id = ?", (run_id, work_id)
            ).fetchone()
        return str(row[0])

    def finding(self, finding_id: str) -> FindingRow | None:
        with self.db.read() as connection:
            row = connection.execute("SELECT * FROM explore_findings WHERE id = ?", (finding_id,)).fetchone()
        return None if row is None else _finding(row)

    def found_work_ids(self, work_ids: Sequence[str], *, task_id: str | None) -> set[str]:
        """Works an earlier run of the same scope (this task, or Explore itself) already made findings."""
        if not work_ids:
            return set()
        marks = ",".join("?" for _ in work_ids)
        with self.db.read() as connection:
            rows = connection.execute(
                f"SELECT DISTINCT work_id FROM explore_findings WHERE work_id IN ({marks}) AND task_id IS ?",
                (*work_ids, task_id),
            ).fetchall()
        return {str(row[0]) for row in rows}

    def run_findings(self, run_id: str) -> list[FindingRow]:
        with self.db.read() as connection:
            rows = connection.execute(
                "SELECT * FROM explore_findings WHERE run_id = ? ORDER BY created_at, rowid", (run_id,)
            ).fetchall()
        return [_finding(row) for row in rows]

    def findings(
        self, *, area_id: str | None, task_id: str | None, include_covered: bool, offset: int, limit: int
    ) -> tuple[list[FindingRow], bool, int]:
        """A page of findings (newest first), whether more follow, and the covered ones in scope."""
        where, params = self._scope(area_id, task_id)
        shown = where + ("" if include_covered else " AND label != 'covered'")
        with self.db.read() as connection:
            rows = connection.execute(
                f"SELECT * FROM explore_findings WHERE {shown} ORDER BY created_at DESC, rowid DESC"
                " LIMIT ? OFFSET ?",
                (*params, limit + 1, offset),
            ).fetchall()
            covered = connection.execute(
                f"SELECT count(*) FROM explore_findings WHERE {where} AND label = 'covered'", params
            ).fetchone()[0]
        return [_finding(row) for row in rows[:limit]], len(rows) > limit, int(covered)

    def new_by_area(self) -> dict[str, int]:
        """Findings not yet in the library, per area (B4's "new findings" on a tile)."""
        with self.db.read() as connection:
            rows = connection.execute(
                "SELECT area_id, count(*) FROM explore_findings WHERE area_id IS NOT NULL"
                " AND label != 'covered' AND material_id IS NULL GROUP BY area_id"
            ).fetchall()
        return {str(row[0]): int(row[1]) for row in rows}

    def set_material(self, finding_id: str, material_id: str) -> None:
        with self.db.write() as connection:
            connection.execute(
                "UPDATE explore_findings SET material_id = ? WHERE id = ?", (material_id, finding_id)
            )

    def update_details(self, finding_id: str, changes: Mapping[str, Any]) -> None:
        with self.db.write() as connection:
            row = connection.execute(
                "SELECT details_json FROM explore_findings WHERE id = ?", (finding_id,)
            ).fetchone()
            if row is None:
                return
            details = {**json.loads(row[0]), **changes}
            connection.execute(
                "UPDATE explore_findings SET details_json = ? WHERE id = ?",
                (json.dumps(details, ensure_ascii=False), finding_id),
            )

    @staticmethod
    def _scope(area_id: str | None, task_id: str | None) -> tuple[str, list[str]]:
        where, params = "1 = 1", []
        if area_id is not None:
            where += " AND area_id = ?"
            params.append(area_id)
        if task_id is not None:
            where += " AND task_id = ?"
            params.append(task_id)
        return where, params

    # -- readings (Exploring) -----------------------------------------------------------------------

    def add_reading(
        self, *, finding_id: str, chat_id: str, mode: str, text_kind: str, material_id: str | None
    ) -> ReadingRow:
        reading_id = new_id("reading")
        now = utc_now_ms()
        with self.db.write() as connection:
            connection.execute(
                "INSERT INTO explore_readings(id, finding_id, chat_id, mode, text_kind, material_id,"
                " started_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?)",
                (reading_id, finding_id, chat_id, mode, text_kind, material_id, now),
            )
        return ReadingRow(reading_id, finding_id, chat_id, mode, text_kind, material_id, now)

    def readings(self, *, limit: int = 100) -> list[ReadingRow]:
        with self.db.read() as connection:
            rows = connection.execute(
                "SELECT * FROM explore_readings ORDER BY started_at DESC, rowid DESC LIMIT ?", (limit,)
            ).fetchall()
        return [
            ReadingRow(
                row["id"],
                row["finding_id"],
                row["chat_id"],
                row["mode"],
                row["text_kind"],
                row["material_id"],
                row["started_at"],
            )
            for row in rows
        ]
