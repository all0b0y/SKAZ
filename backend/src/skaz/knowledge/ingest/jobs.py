"""Ingest jobs: rows of the foundation ``jobs`` table plus ``ingest_jobs`` details.

No queue: every job runs on its own. A job that was running when the backend
stopped is marked ``interrupted`` at the next start and is never resumed
silently; the user retries it (a new job).
"""
from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass, field
from typing import Any, Literal

from ..agents.engine import FailureKind
from ..ids import new_id, utc_now
from ..store.database import KnowledgeDatabase

JOB_KIND = "ingest"
JobKind = Literal["ingest", "refresh", "recheck", "connections", "folder_overview", "corrections", "export"]
#: Every kind run by ingest (W1) and the wiki (W2); ``refresh`` re-ingests after a correction changed.
JOB_KINDS: tuple[JobKind, ...] = (
    "ingest", "refresh", "recheck", "connections", "folder_overview", "corrections", "export",
)
#: Kinds about one material (``target_id`` is the material id).
MATERIAL_JOB_KINDS: tuple[JobKind, ...] = ("ingest", "refresh", "corrections")
JobState = Literal["running", "done", "failed", "cancelled", "interrupted"]
JobStep = Literal["reading", "checking_recognition", "writing_notes", "concepts", "saving", "done",
                  "checking_discrepancies", "finding_connections", "rechecking", "writing_overview",
                  "exporting"]
FINISHED: tuple[JobState, ...] = ("done", "failed", "cancelled", "interrupted")
INTERRUPTED_REASON = "SKAZ was closed while this material was being added to the wiki. Retry to start again."
WIKI_INTERRUPTED_REASON = "SKAZ was closed while this wiki job was running. Start it again when needed."
#: Bounded journal: the status view never grows without limit.
MAX_JOURNAL = 200
#: ``JobRecord.error_code``: the agent can't work until the user fixes it (sign in, update, connect
#: one) in Settings → Accounts & keys — retrying alone won't help. Same code as the chats' 409.
AGENT_UNAVAILABLE = "AGENT_UNAVAILABLE"


def agent_failure_text(kind: FailureKind, message: str) -> str:
    """The job's reason for a failed agent turn: an agent that isn't installed or can't be used
    never started, so it didn't "stop" (QA C26)."""
    lead = "The agent couldn't start" if kind == "incompatible" else "The agent stopped"
    return f"{lead}: {message}"


def agent_failure_code(kind: FailureKind) -> str | None:
    """The job's ``error_code`` for an agent turn that failed this way (``None``: retrying may help)."""
    return AGENT_UNAVAILABLE if kind in ("auth", "incompatible") else None


@dataclass(frozen=True)
class JournalEntry:
    at: str
    message: str


@dataclass(frozen=True)
class JobRecord:
    id: str
    #: The material of the job; ``None`` for wiki-wide work (connections, folder overviews).
    material_id: str | None
    state: JobState
    step: JobStep | None
    error: str | None
    created_at: str
    updated_at: str
    counters: dict[str, int] = field(default_factory=dict)
    journal: tuple[JournalEntry, ...] = ()
    kind: JobKind = "ingest"
    #: What the job works on: a material, a page (``recheck``), a folder (``folder_overview``) or nothing.
    target_id: str | None = None
    #: ``AGENT_UNAVAILABLE`` when the failure is fixed in Settings, not by a retry; else ``None``.
    error_code: str | None = None

    @property
    def finished(self) -> bool:
        return self.state in FINISHED

    @property
    def can_retry(self) -> bool:
        return self.state in ("failed", "cancelled", "interrupted")

    @property
    def label(self) -> str:
        """The material status line: Reading / Writing notes / Concepts N / Done."""
        if self.state == "running":
            if self.step == "concepts":
                return f"Concepts {self.counters.get('concepts_found', 0)}"
            return {"reading": "Reading", "checking_recognition": "Checking recognition",
                    "writing_notes": "Writing notes", "saving": "Saving pages", "done": "Done",
                    "checking_discrepancies": "Checking for disagreements",
                    "finding_connections": "Finding connections", "rechecking": "Rechecking",
                    "writing_overview": "Writing the folder overview",
                    "exporting": "Exporting"}.get(self.step or "reading", "Reading")
        return {"done": "Done", "failed": "Failed", "cancelled": "Cancelled",
                "interrupted": "Interrupted"}[self.state]


def _record(row: sqlite3.Row) -> JobRecord:
    journal = tuple(JournalEntry(item["at"], item["message"]) for item in json.loads(row["journal"] or "[]"))
    kind = row["kind"]
    material_id = row["target_id"] if kind in MATERIAL_JOB_KINDS else None
    return JobRecord(
        id=row["id"], material_id=material_id, state=row["state"], step=row["step"], error=row["error"],
        created_at=row["created_at"], updated_at=row["updated_at"],
        counters={key: int(value) for key, value in json.loads(row["counters"] or "{}").items()},
        journal=journal, kind=kind, target_id=row["target_id"], error_code=row["error_code"],
    )


_KINDS_IN = "(" + ", ".join(f"'{kind}'" for kind in JOB_KINDS) + ")"
_SELECT = (
    "SELECT j.*, COALESCE(d.counters, '{}') AS counters, COALESCE(d.journal, '[]') AS journal, "
    "d.error_code AS error_code "
    f"FROM jobs j LEFT JOIN ingest_jobs d ON d.job_id = j.id WHERE j.kind IN {_KINDS_IN}"
)


class JobRepository:
    def __init__(self, db: KnowledgeDatabase) -> None:
        self.db = db

    def create(self, material_id: str | None, *, kind: JobKind = "ingest",
               step: JobStep = "reading") -> JobRecord:
        """A running job; ``material_id`` is the target (a page for ``recheck``, a folder for overviews)."""
        job_id = new_id("job")
        now = utc_now()
        with self.db.write() as connection:
            connection.execute(
                "INSERT INTO jobs(id, kind, target_id, state, step, error, created_at, updated_at) "
                "VALUES (?, ?, ?, 'running', ?, NULL, ?, ?)",
                (job_id, kind, material_id, step, now, now),
            )
            connection.execute("INSERT INTO ingest_jobs(job_id) VALUES (?)", (job_id,))
        record = self.get(job_id)
        assert record is not None
        return record

    def get(self, job_id: str) -> JobRecord | None:
        with self.db.read() as connection:
            row = connection.execute(f"{_SELECT} AND j.id = ?", (job_id,)).fetchone()
        return _record(row) if row else None

    def list_all(self, *, material_id: str | None = None) -> list[JobRecord]:
        where, params = "", []
        if material_id is not None:
            kinds = ", ".join(f"'{kind}'" for kind in MATERIAL_JOB_KINDS)
            where, params = f" AND j.target_id = ? AND j.kind IN ({kinds})", [material_id]
        with self.db.read() as connection:
            rows = connection.execute(f"{_SELECT}{where} ORDER BY j.created_at DESC, j.rowid DESC",
                                      params).fetchall()
        return [_record(row) for row in rows]

    def running_for(self, material_id: str) -> JobRecord | None:
        return next((job for job in self.list_all(material_id=material_id) if job.state == "running"), None)

    def set_step(self, job_id: str, step: JobStep) -> None:
        with self.db.write() as connection:
            connection.execute("UPDATE jobs SET step = ?, updated_at = ? WHERE id = ? AND state = 'running'",
                               (step, utc_now(), job_id))

    def finish(self, job_id: str, state: JobState, *, error: str | None = None,
               error_code: str | None = None) -> None:
        with self.db.write() as connection:
            finished = connection.execute(
                "UPDATE jobs SET state = ?, error = ?, "
                "step = CASE WHEN ? = 'done' THEN 'done' ELSE step END, "
                "updated_at = ? WHERE id = ? AND state = 'running'",
                (state, error, state, utc_now(), job_id),
            ).rowcount
            if finished:
                connection.execute("UPDATE ingest_jobs SET error_code = ? WHERE job_id = ?",
                                   (error_code, job_id))

    def update_counters(self, job_id: str, values: dict[str, int]) -> None:
        with self.db.write() as connection:
            row = connection.execute("SELECT counters FROM ingest_jobs WHERE job_id = ?",
                                     (job_id,)).fetchone()
            counters: dict[str, Any] = json.loads(row["counters"]) if row else {}
            counters.update(values)
            connection.execute("UPDATE ingest_jobs SET counters = ? WHERE job_id = ?",
                               (json.dumps(counters), job_id))
            connection.execute("UPDATE jobs SET updated_at = ? WHERE id = ?", (utc_now(), job_id))

    def log(self, job_id: str, message: str) -> None:
        """Append a code-written line to the job journal (never source or model text)."""
        with self.db.write() as connection:
            row = connection.execute("SELECT journal FROM ingest_jobs WHERE job_id = ?", (job_id,)).fetchone()
            journal: list[dict[str, str]] = json.loads(row["journal"]) if row else []
            journal.append({"at": utc_now(), "message": message})
            connection.execute("UPDATE ingest_jobs SET journal = ? WHERE job_id = ?",
                               (json.dumps(journal[-MAX_JOURNAL:], ensure_ascii=False), job_id))

    def interrupt_running(self) -> list[str]:
        """Startup: jobs left ``running`` by a previous process become ``interrupted``."""
        with self.db.write() as connection:
            ids = [row[0] for row in connection.execute(
                f"SELECT id FROM jobs WHERE kind IN {_KINDS_IN} AND state = 'running'")]
            connection.execute(
                "UPDATE jobs SET state = 'interrupted', "
                "error = CASE WHEN kind IN ('ingest', 'refresh') THEN ? ELSE ? END, updated_at = ? "
                f"WHERE kind IN {_KINDS_IN} AND state = 'running'",
                (INTERRUPTED_REASON, WIKI_INTERRUPTED_REASON, utc_now()),
            )
        return ids
