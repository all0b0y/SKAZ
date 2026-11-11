"""Ingest jobs: rows of the foundation ``jobs`` table plus ``ingest_jobs`` details.

Adding materials to the wiki goes through a queue: a job is created ``queued`` and
``IngestService`` starts queued jobs in order while the wiki engine has a free slot.
The queue lives in the database, so it survives a restart: an ingest job that was
queued or running when SKAZ closed is queued again at the next start and continues
by itself. Other wiki jobs left ``running`` become ``interrupted``.
"""
from __future__ import annotations

import json
import sqlite3
import time
from collections.abc import Awaitable, Callable
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal

from ..agents.engine import FailureKind
from ..agents.history import ENGINE_LABELS
from ..ids import new_id, utc_now
from ..store.database import KnowledgeDatabase
from ..store.repositories import SettingsRepository
from .budget import PAUSED_LABEL
from .execution import ExecutionView, ProcessingProfile, execution_view, new_execution
from .settings import ENGINE_PAUSE_KEY, EnginePause, parse_engine_pause, read_engine_pauses

#: Counter key: epoch milliseconds when the running step began (C1-f).
STEP_STARTED = "step_started_ms"

JOB_KIND = "ingest"
JobKind = Literal["ingest", "refresh", "recheck", "connections", "folder_overview", "corrections", "export"]
#: Every kind run by ingest (W1) and the wiki (W2); ``refresh`` re-ingests after a correction changed.
JOB_KINDS: tuple[JobKind, ...] = (
    "ingest", "refresh", "recheck", "connections", "folder_overview", "corrections", "export",
)
#: Kinds about one material (``target_id`` is the material id).
MATERIAL_JOB_KINDS: tuple[JobKind, ...] = ("ingest", "refresh", "corrections")
#: ``paused``: the material's wiki budget (C1-d) or its engine's quota; Continue keeps its checkpoint.
JobState = Literal["queued", "running", "done", "failed", "cancelled", "interrupted", "paused"]
JobStep = Literal["reading", "checking_recognition", "writing_notes", "concepts", "saving", "done",
                  "checking_discrepancies", "finding_connections", "rechecking", "writing_overview",
                  "exporting"]
FINISHED: tuple[JobState, ...] = ("done", "failed", "cancelled", "interrupted", "paused")
INTERRUPTED_REASON = "SKAZ was closed while this material was being added to the wiki. Retry to start again."
WIKI_INTERRUPTED_REASON = "SKAZ was closed while this wiki job was running. Start it again when needed."
#: Kinds that wait in the ingest queue and continue after a restart.
QUEUED_KINDS: tuple[JobKind, ...] = ("ingest", "refresh")
#: Bounded journal: the status view never grows without limit.
MAX_JOURNAL = 200
#: ``JobRecord.error_code``: the agent can't work until the user fixes it (sign in, update, connect
#: one) in Settings → Accounts & keys — retrying alone won't help. Same code as the chats' 409.
AGENT_UNAVAILABLE = "AGENT_UNAVAILABLE"
ENGINE_LIMIT = "ENGINE_LIMIT"


def wall_clock() -> datetime:
    return datetime.now(UTC)


class EngineLimited(Exception):
    """A provider quota: finished checkpoint items stay kept; the engine's queue must wait."""

    def __init__(self, engine: str, retry_at: datetime | None) -> None:
        self.pause = EnginePause(engine, retry_at)
        label = ENGINE_LABELS.get(engine, engine)
        self.message = f"{label}: usage limit reached. The finished work is kept."
        super().__init__(self.message)


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
    execution: ExecutionView | None = None
    #: A quota pause of this queued/paused job's engine; budget pauses never carry this.
    engine_pause: EnginePause | None = None

    @property
    def finished(self) -> bool:
        return self.state in FINISHED

    @property
    def step_started_at(self) -> str | None:
        """When the current step began (UTC, ISO 8601), while the job runs; ``None`` otherwise."""
        started = self.counters.get(STEP_STARTED)
        if self.state != "running" or not started:
            return None
        return datetime.fromtimestamp(started / 1000, UTC).strftime("%Y-%m-%dT%H:%M:%SZ")

    @property
    def can_retry(self) -> bool:
        return self.state in ("failed", "cancelled", "interrupted")

    @property
    def label(self) -> str:
        """The material status line: Queued / Reading / Writing notes / Concepts N / Done."""
        if self.state == "queued":
            return "Paused · usage limit reached" if self.engine_pause is not None else "Queued"
        if self.state == "running":
            if self.step == "concepts":
                found = max(self.counters.get("concepts_found", 0), self.counters.get("concepts_streamed", 0))
                return f"Concepts {found}"
            if self.step == "writing_notes" and self.counters.get("parts_total"):
                total = self.counters["parts_total"]
                line = f"Writing notes · part {min(self.counters.get('parts_done', 0) + 1, total)} of {total}"
                written = self.counters.get("notes_sections", 0)
                if written:
                    line += f" · {written} section{'' if written == 1 else 's'}"
                return line
            return {"reading": "Reading", "checking_recognition": "Checking recognition",
                    "writing_notes": "Writing notes", "saving": "Saving pages", "done": "Done",
                    "checking_discrepancies": "Checking for disagreements",
                    "finding_connections": "Finding connections", "rechecking": "Rechecking",
                    "writing_overview": "Writing the folder overview",
                    "exporting": "Exporting"}.get(self.step or "reading", "Reading")
        if self.state == "paused" and self.error_code == ENGINE_LIMIT:
            return "Paused · usage limit reached"
        return {"done": "Done", "failed": "Failed", "cancelled": "Cancelled",
                "interrupted": "Interrupted", "paused": PAUSED_LABEL}[self.state]


def _record(row: sqlite3.Row) -> JobRecord:
    journal = tuple(JournalEntry(item["at"], item["message"]) for item in json.loads(row["journal"] or "[]"))
    kind = row["kind"]
    material_id = row["target_id"] if kind in MATERIAL_JOB_KINDS else None
    data = json.loads(row["execution"]) if row["execution"] else {}
    engine = data.get("quota_engine") or data.get("profile", {}).get("engine")
    raw_pause = json.loads(row["engine_pause"]) if row["engine_pause"] else None
    quota_paused = row["state"] == "paused" and row["error_code"] == ENGINE_LIMIT
    if quota_paused and raw_pause is None:
        raw_pause = {"retry_at": data.get("quota_retry_at")}
    pause = (parse_engine_pause(engine, raw_pause)
             if engine and (row["state"] == "queued" or quota_paused) else None)
    return JobRecord(
        id=row["id"], material_id=material_id, state=row["state"], step=row["step"], error=row["error"],
        created_at=row["created_at"], updated_at=row["updated_at"],
        counters={key: int(value) for key, value in json.loads(row["counters"] or "{}").items()},
        journal=journal, kind=kind, target_id=row["target_id"], error_code=row["error_code"],
        execution=execution_view(row["execution"]),
        engine_pause=pause,
    )


_KINDS_IN = "(" + ", ".join(f"'{kind}'" for kind in JOB_KINDS) + ")"
_SELECT = (
    "SELECT j.*, COALESCE(d.counters, '{}') AS counters, COALESCE(d.journal, '[]') AS journal, "
    "d.error_code AS error_code, e.data AS execution, p.value AS engine_pause "
    "FROM jobs j LEFT JOIN ingest_jobs d ON d.job_id = j.id "
    "LEFT JOIN wiki_execution e ON e.job_id = j.id "
    "LEFT JOIN settings p ON p.key = 'wiki_engine_pause.' || "
    "COALESCE(json_extract(e.data, '$.quota_engine'), json_extract(e.data, '$.profile.engine')) "
    f"WHERE j.kind IN {_KINDS_IN}"
)


class JobRepository:
    def __init__(self, db: KnowledgeDatabase, *, clock: Callable[[], datetime] = wall_clock) -> None:
        self.db = db
        self.clock = clock
        self.queue_slots: dict[str | None, int] = {"codex": 4, "claude_code": 3, "hermes": 2,
                                                  "opencode": 2, None: 2}
        #: Queue composition hooks; disk mutations notify the service on its owning event loop.
        self.changed: Callable[[], None] | None = None
        self.resume_wiki: Callable[[str], Awaitable[bool]] | None = None

    def create(self, material_id: str | None, *, kind: JobKind = "ingest",
               step: JobStep = "reading", state: Literal["running", "queued"] = "running",
               profile: ProcessingProfile | None = None, root_job_id: str | None = None,
               budget: int | None = None, budget_material: str | None = None) -> JobRecord:
        """A new job; ``material_id`` is the target (a page for ``recheck``, a folder for overviews)."""
        job_id = new_id("job")
        now = utc_now()
        with self.db.write() as connection:
            connection.execute(
                "INSERT INTO jobs(id, kind, target_id, state, step, error, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, NULL, ?, ?)",
                (job_id, kind, material_id, state, step, now, now),
            )
            connection.execute("INSERT INTO ingest_jobs(job_id) VALUES (?)", (job_id,))
            if profile is not None:
                connection.execute("INSERT INTO wiki_execution(job_id, data, root_job_id) VALUES (?, ?, ?)",
                                   (job_id, new_execution(profile, job_id, root_job_id, budget=budget,
                                                          material_id=budget_material),
                                    root_job_id or job_id))
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
            where = (f" AND ((j.target_id = ? AND j.kind IN ({kinds})) OR "
                     "(json_extract(e.data, '$.material_id') = ? AND d.error_code = ?))")
            params = [material_id, material_id, ENGINE_LIMIT]
        with self.db.read() as connection:
            rows = connection.execute(f"{_SELECT}{where} ORDER BY j.created_at DESC, j.rowid DESC",
                                      params).fetchall()
        return [_record(row) for row in rows]

    def running_for(self, material_id: str) -> JobRecord | None:
        return next((job for job in self.list_all(material_id=material_id) if job.state == "running"), None)

    def pending_for(self, material_id: str) -> JobRecord | None:
        """The material's queued/running/quota-paused ingest (wiki checks of it don't count)."""
        return next((job for job in self.list_all(material_id=material_id)
                     if job.kind in QUEUED_KINDS and (job.state in ("queued", "running")
                         or (job.state == "paused" and job.error_code == ENGINE_LIMIT))), None)

    def pending_in_folder(self, folder_id: str) -> bool:
        """A queued or running ingest of a material in this folder (a batch import is still going)."""
        kinds = ", ".join(f"'{kind}'" for kind in QUEUED_KINDS)
        with self.db.read() as connection:
            row = connection.execute(
                f"SELECT 1 FROM jobs JOIN materials ON materials.id = jobs.target_id "
                f"WHERE jobs.kind IN ({kinds}) AND jobs.state IN ('queued', 'running') "
                "AND materials.folder_id = ? LIMIT 1", (folder_id,)).fetchone()
        return row is not None

    def claim_next(self) -> JobRecord | None:
        """Start the oldest queued ingest job: ``queued`` → ``running`` in one write; ``None`` if none."""
        kinds = ", ".join(f"'{kind}'" for kind in QUEUED_KINDS)
        with self.db.write() as connection:
            rows = connection.execute(
                f"{_SELECT} AND j.kind IN ({kinds}) AND j.state = 'queued' "
                "ORDER BY j.created_at, j.rowid").fetchall()
            counts: dict[str | None, int] = {}
            for running in connection.execute(
                "SELECT json_extract(e.data, '$.profile.engine') AS engine FROM jobs j "
                "LEFT JOIN wiki_execution e ON e.job_id = j.id "
                f"WHERE j.kind IN ({kinds}) AND j.state = 'running'",
            ):
                engine = running["engine"]
                counts[engine] = counts.get(engine, 0) + 1
            row = None
            for candidate in rows:
                record = _record(candidate)
                engine = record.execution.profile.engine if record.execution else None
                if record.engine_pause is None and counts.get(engine, 0) < self.queue_slots.get(engine, 2):
                    row = candidate
                    break
            if row is None:
                return None
            connection.execute("UPDATE jobs SET state = 'running', step = 'reading', updated_at = ? "
                               "WHERE id = ? AND state = 'queued'", (utc_now(), row["id"]))
        return self.get(row["id"])

    def engine_pauses(self) -> dict[str, EnginePause]:
        return read_engine_pauses(SettingsRepository(self.db))

    def pause(self, job_id: str, limited: EngineLimited) -> None:
        """Persist the engine gate and the job's pause atomically before another job can be claimed."""
        pause = limited.pause
        at = pause.retry_at
        if at is not None and at.tzinfo is None:
            at = at.replace(tzinfo=UTC)
        if at is not None and at <= self.clock():
            at = None  # no future reset was reported: prevent an immediate paid retry loop
        key = ENGINE_PAUSE_KEY + pause.engine
        with self.db.write() as connection:
            row = connection.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
            previous = parse_engine_pause(pause.engine, json.loads(row[0])) if row else None
            if previous is not None:
                # Every in-flight failure counts: an unknown reset needs manual Continue.
                at = (max(at, previous.retry_at) if at is not None and previous.retry_at is not None
                      else None)
            connection.execute("INSERT INTO settings(key, value) VALUES (?, ?) "
                               "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                               (key, json.dumps({"retry_at": at.isoformat() if at else None})))
            changed = connection.execute("UPDATE jobs SET state = 'paused', error = ?, updated_at = ? "
                               "WHERE id = ? AND state IN ('running', 'queued')",
                               (limited.message, utc_now(), job_id)).rowcount
            if changed:
                connection.execute("UPDATE ingest_jobs SET error_code = ? WHERE job_id = ?",
                                   (ENGINE_LIMIT, job_id))
                connection.execute("UPDATE wiki_execution SET data = json_set(data, '$.quota_engine', ?, "
                                   "'$.quota_retry_at', ?) WHERE job_id = ?",
                                   (pause.engine, at.isoformat() if at else None, job_id))
        self.log(job_id, limited.message)
        if self.changed is not None:
            self.changed()

    def release_engine(self, engine: str) -> None:
        with self.db.write() as connection:
            connection.execute("DELETE FROM settings WHERE key = ?", (ENGINE_PAUSE_KEY + engine,))
        if self.changed is not None:
            self.changed()

    def release_due(self) -> None:
        for engine, pause in self.engine_pauses().items():
            if pause.retry_at is not None and pause.retry_at <= self.clock():
                self.release_engine(engine)

    def ready_pauses(self) -> list[JobRecord]:
        paused = self.engine_pauses()
        return [record for record in self.list_all()
                if record.state == "paused" and record.error_code == ENGINE_LIMIT
                and record.engine_pause is not None and record.engine_pause.engine not in paused]

    def continue_paused(self, job_id: str, *, state: Literal["running", "queued"] = "queued",
                        profile: ProcessingProfile | None = None) -> bool:
        with self.db.write() as connection:
            changed = connection.execute(
                "UPDATE jobs SET state = ?, error = NULL, updated_at = ? "
                "WHERE id = ? AND state = 'paused' AND EXISTS "
                "(SELECT 1 FROM ingest_jobs d WHERE d.job_id = jobs.id AND d.error_code = ?)",
                (state, utc_now(), job_id, ENGINE_LIMIT)).rowcount
            if changed:
                connection.execute("UPDATE ingest_jobs SET error_code = NULL WHERE job_id = ?", (job_id,))
                connection.execute("UPDATE wiki_execution SET data = "
                                   "json_remove(data, '$.quota_engine', '$.quota_retry_at') "
                                   "WHERE job_id = ?", (job_id,))
        if changed and profile is not None:
            self.reprofile(job_id, profile)
        return bool(changed)

    def reprofile(self, job_id: str, profile: ProcessingProfile) -> None:
        """Explicit Continue uses the user's current model, retaining the root's usage and budget."""
        with self.db.write() as connection:
            connection.execute("UPDATE wiki_execution SET data = json_set(data, '$.profile', json(?)) "
                               "WHERE job_id = ?", (json.dumps(asdict(profile)), job_id))

    def cancel_waiting(self, job_id: str, error: str) -> bool:
        with self.db.write() as connection:
            changed = connection.execute("UPDATE jobs SET state = 'cancelled', error = ?, updated_at = ? "
                                         "WHERE id = ? AND state IN ('queued', 'paused')",
                                         (error, utc_now(), job_id)).rowcount
            if changed:
                connection.execute("UPDATE ingest_jobs SET error_code = NULL WHERE job_id = ?", (job_id,))
        if changed and self.changed is not None:
            self.changed()
        return bool(changed)

    def requeue(self, job_id: str) -> None:
        """A running job goes back to the queue (SKAZ is closing): it continues at the next start."""
        with self.db.write() as connection:
            connection.execute(
                "UPDATE jobs SET state = 'queued', step = 'reading', error = NULL, updated_at = ? "
                "WHERE id = ? AND state = 'running'", (utc_now(), job_id))

    def queued_count(self) -> int:
        kinds = ", ".join(f"'{kind}'" for kind in QUEUED_KINDS)
        with self.db.read() as connection:
            row = connection.execute(
                f"SELECT COUNT(*) FROM jobs WHERE kind IN ({kinds}) AND state = 'queued'").fetchone()
        return int(row[0])

    def latest_failed_materials(self) -> list[str]:
        """Materials whose latest ingest job failed or was interrupted (not ones the user cancelled)."""
        kinds = ", ".join(f"'{kind}'" for kind in QUEUED_KINDS)
        with self.db.read() as connection:
            rows = connection.execute(
                f"SELECT target_id, state FROM jobs WHERE kind IN ({kinds}) AND target_id IS NOT NULL "
                "ORDER BY created_at DESC, rowid DESC").fetchall()
        latest: dict[str, str] = {}
        for row in rows:
            latest.setdefault(row["target_id"], row["state"])
        return [material_id for material_id, state in latest.items() if state in ("failed", "interrupted")]

    def set_step(self, job_id: str, step: JobStep) -> None:
        with self.db.write() as connection:
            moved = connection.execute(
                "UPDATE jobs SET step = ?, updated_at = ? WHERE id = ? AND state = 'running'",
                (step, utc_now(), job_id)).rowcount
            row = connection.execute("SELECT counters FROM ingest_jobs WHERE job_id = ?",
                                     (job_id,)).fetchone()
            if moved and row is not None:
                # When the step began, for the live "3:20" on the material (C1-f).
                counters: dict[str, Any] = json.loads(row["counters"] or "{}")
                counters[STEP_STARTED] = int(time.time() * 1000)
                connection.execute("UPDATE ingest_jobs SET counters = ? WHERE job_id = ?",
                                   (json.dumps(counters), job_id))

    def finish(self, job_id: str, state: JobState, *, error: str | None = None,
               error_code: str | None = None) -> None:
        with self.db.write() as connection:
            finished = connection.execute(
                "UPDATE jobs SET state = ?, error = ?, "
                "step = CASE WHEN ? = 'done' THEN 'done' ELSE step END, "
                "updated_at = ? WHERE id = ? AND state IN ('running', 'queued')",
                (state, error, state, utc_now(), job_id),
            ).rowcount
            if finished:
                connection.execute("UPDATE ingest_jobs SET error_code = ? WHERE job_id = ?",
                                   (error_code, job_id))

    def cancel_queued(self, job_id: str, error: str) -> bool:
        """Stop a job that hasn't started: ``False`` when the queue claimed it meanwhile (or it ended)."""
        with self.db.write() as connection:
            stopped = connection.execute(
                "UPDATE jobs SET state = 'cancelled', error = ?, updated_at = ? "
                "WHERE id = ? AND state = 'queued'",
                (error, utc_now(), job_id)).rowcount
            if stopped:
                connection.execute("UPDATE ingest_jobs SET error_code = NULL WHERE job_id = ?", (job_id,))
        return bool(stopped)

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
        """Startup: ingest jobs left ``running`` go back to the queue and continue; other jobs left
        ``running`` by a previous process become ``interrupted``. Returns the interrupted ids."""
        queued = ", ".join(f"'{kind}'" for kind in QUEUED_KINDS)
        with self.db.write() as connection:
            connection.execute(
                "UPDATE jobs SET state = 'queued', step = 'reading', error = NULL, updated_at = ? "
                f"WHERE kind IN ({queued}) AND state = 'running'", (utc_now(),))
            ids = [row[0] for row in connection.execute(
                f"SELECT id FROM jobs WHERE kind IN {_KINDS_IN} AND state = 'running'")]
            connection.execute(
                "UPDATE jobs SET state = 'interrupted', "
                "error = CASE WHEN kind IN ('ingest', 'refresh') THEN ? ELSE ? END, updated_at = ? "
                f"WHERE kind IN {_KINDS_IN} AND state = 'running'",
                (INTERRUPTED_REASON, WIKI_INTERRUPTED_REASON, utc_now()),
            )
        return ids
