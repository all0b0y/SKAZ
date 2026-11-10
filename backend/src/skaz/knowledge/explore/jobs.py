"""``JobStore``: the one writer of ``explore_jobs``, ``explore_checkpoints`` and ``explore_completed_work``.

Every 0.4.0 background job (funnel runs, research tasks, Check links, the weekly check, N3 re-checks)
keeps its state, budget, counters, checkpoints and finished work here, so a pause, a crash or Quit never
does finished work twice. Blocking repository: callers run it through ``disk_call``.
"""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Collection, Sequence
from typing import Literal, cast

from ..api.schemas_explore_common import (
    KbCheckpoint,
    KbExploreJob,
    KbExploreJobState,
    KbJobOwner,
    KbRunBudget,
    KbRunCounters,
    KbRunStage,
    KbStopReason,
)
from ..errors import KnowledgeError, NotFound
from ..ids import new_id, utc_now_ms
from ..store.database import KnowledgeDatabase

DecisionProvider = Literal["local", "openrouter_jev"]

#: Stop reason → job state (CONTRACT "Budget and checkpoint model").
STATE_OF: dict[str, KbExploreJobState] = {
    "budget": "paused",
    "user_pause": "paused",
    "app_exit": "paused",
    "openalex_daily_limit": "paused",
    "decision_model_required": "paused",
    "science_consent_required": "paused",
    "provider_unavailable": "paused",
    "completed": "done",
    "cancelled": "cancelled",
    "failed": "error",
}
ACTIVE_STATES: tuple[KbExploreJobState, ...] = ("queued", "running", "paused")
_DECISION_CHOICES = ["download_local", "openrouter_jev"]


class WorkAlreadyDone(KnowledgeError):
    """The same ``(job, candidate, stage)`` twice: Continue must never repeat finished work."""

    status_code = 409


class JobNotFound(NotFound):
    pass


def _dump(model: KbRunBudget | KbRunCounters) -> str:
    return json.dumps(model.model_dump(mode="json"), separators=(",", ":"))


class SqliteJobStore:
    """Implements ``explore.protocols.JobStore`` (plus a few reads the explore routes need)."""

    def __init__(self, db: KnowledgeDatabase) -> None:
        self.db = db

    # -- JobStore ---------------------------------------------------------------------------------

    def create(self, owner: KbJobOwner, title: str, stage: KbRunStage, budget: KbRunBudget) -> KbExploreJob:
        job_id = new_id("job")
        now = utc_now_ms()
        counters = KbRunCounters(
            checked=0, after_rules=0, decided=0, on_topic=0, novelty_checked=0, new=0, covered=0
        )
        with self.db.write() as connection:
            connection.execute(
                "INSERT INTO explore_jobs(id, owner, state, stage, title, budget_json, counters_json,"
                " created_at, updated_at) VALUES (?, ?, 'running', ?, ?, ?, ?, ?, ?)",
                (job_id, owner, stage, title[:300], _dump(budget), _dump(counters), now, now),
            )
        return self._require(job_id)

    def get(self, job_id: str) -> KbExploreJob | None:
        with self.db.read() as connection:
            row = connection.execute("SELECT * FROM explore_jobs WHERE id = ?", (job_id,)).fetchone()
            return None if row is None else self._job(connection, row)

    def active(self) -> Sequence[KbExploreJob]:
        marks = ",".join("?" for _ in ACTIVE_STATES)
        with self.db.read() as connection:
            rows = connection.execute(
                f"SELECT * FROM explore_jobs WHERE state IN ({marks}) ORDER BY updated_at DESC, id",
                ACTIVE_STATES,
            ).fetchall()
            return [self._job(connection, row) for row in rows]

    def progress(
        self, job_id: str, *, stage: KbRunStage, budget: KbRunBudget, counters: KbRunCounters
    ) -> KbExploreJob:
        """The job is working (again): running, no stop reason, no pending decision choice."""
        with self.db.write() as connection:
            changed = connection.execute(
                "UPDATE explore_jobs SET state = 'running', stage = ?, stop_reason = NULL, retry_at = NULL,"
                " budget_json = ?, counters_json = ?, updated_at = ? WHERE id = ?",
                (stage, _dump(budget), _dump(counters), utc_now_ms(), job_id),
            ).rowcount
        if not changed:
            raise JobNotFound("This job wasn't found.")
        return self._require(job_id)

    def stop(self, job_id: str, reason: KbStopReason, *, retry_at: str | None = None) -> KbExploreJob:
        state = STATE_OF[reason]
        with self.db.write() as connection:
            row = connection.execute("SELECT stage FROM explore_jobs WHERE id = ?", (job_id,)).fetchone()
            if row is None:
                raise JobNotFound("This job wasn't found.")
            connection.execute(
                "UPDATE explore_jobs SET state = ?, stop_reason = ?, retry_at = ?, updated_at = ?"
                " WHERE id = ?",
                (state, reason, retry_at if state == "paused" else None, utc_now_ms(), job_id),
            )
            if state == "paused" and self._latest(connection, job_id) is None:
                # Continue needs a checkpoint to name: a stop without one still gets a first revision.
                self._save_checkpoint(
                    connection, job_id, stage=row["stage"], cursor=None, completed=[], pending=[]
                )
        return self._require(job_id)

    def checkpoint(
        self,
        job_id: str,
        *,
        stage: KbRunStage,
        cursor: str | None,
        completed_ids: Sequence[str],
        pending_ids: Sequence[str],
    ) -> KbCheckpoint:
        with self.db.write() as connection:
            if connection.execute("SELECT 1 FROM explore_jobs WHERE id = ?", (job_id,)).fetchone() is None:
                raise JobNotFound("This job wasn't found.")
            return self._save_checkpoint(
                connection,
                job_id,
                stage=stage,
                cursor=cursor,
                completed=list(completed_ids),
                pending=list(pending_ids),
            )

    def complete(self, job_id: str, candidate_id: str, stage: KbRunStage, result_json: str) -> None:
        try:
            json.loads(result_json)
        except ValueError as error:
            raise KnowledgeError("The result of finished work must be JSON.") from error
        try:
            with self.db.write() as connection:
                connection.execute(
                    "INSERT INTO explore_completed_work(job_id, candidate_id, stage, result_json,"
                    " completed_at)"
                    " VALUES (?, ?, ?, ?, ?)",
                    (job_id, candidate_id, stage, result_json, utc_now_ms()),
                )
        except sqlite3.IntegrityError as error:
            if self.get(job_id) is None:
                raise JobNotFound("This job wasn't found.") from error
            raise WorkAlreadyDone("This work is already done.") from error

    def completed(self, job_id: str, stage: KbRunStage) -> Collection[str]:
        with self.db.read() as connection:
            rows = connection.execute(
                "SELECT candidate_id FROM explore_completed_work WHERE job_id = ? AND stage = ?",
                (job_id, stage),
            ).fetchall()
        return {str(row[0]) for row in rows}

    def recover(self) -> Sequence[str]:
        """On start: running or queued jobs become paused with ``app_exit``, each with a fresh checkpoint
        revision (a Continue sent with a card seen before the crash is stale); returns their ids."""
        recovered: list[str] = []
        now = utc_now_ms()
        with self.db.write() as connection:
            rows = connection.execute(
                "SELECT id, stage FROM explore_jobs WHERE state IN ('running', 'queued')"
                " ORDER BY created_at, id"
            ).fetchall()
            for row in rows:
                job_id = str(row["id"])
                connection.execute(
                    "UPDATE explore_jobs SET state = 'paused', stop_reason = 'app_exit', updated_at = ?"
                    " WHERE id = ?",
                    (now, job_id),
                )
                latest = self._latest(connection, job_id)
                self._save_checkpoint(
                    connection,
                    job_id,
                    stage=latest.stage if latest is not None else row["stage"],
                    cursor=latest.cursor if latest is not None else None,
                    completed=latest.completed_ids if latest is not None else [],
                    pending=latest.pending_ids if latest is not None else [],
                )
                recovered.append(job_id)
        return recovered

    # -- reads beyond the Protocol (B2's routes) -------------------------------------------------

    def title(self, job_id: str) -> str | None:
        with self.db.read() as connection:
            row = connection.execute("SELECT title FROM explore_jobs WHERE id = ?", (job_id,)).fetchone()
        return None if row is None else str(row[0])

    def recent(self, *, limit: int = 50) -> Sequence[KbExploreJob]:
        """Active jobs first, then the latest finished ones."""
        with self.db.read() as connection:
            rows = connection.execute(
                "SELECT * FROM explore_jobs ORDER BY state IN ('done','cancelled','error'), updated_at DESC,"
                " id LIMIT ?",
                (max(1, min(limit, 200)),),
            ).fetchall()
            return [self._job(connection, row) for row in rows]

    def result(self, job_id: str, candidate_id: str, stage: KbRunStage) -> str | None:
        with self.db.read() as connection:
            row = connection.execute(
                "SELECT result_json FROM explore_completed_work WHERE job_id = ? AND candidate_id = ?"
                " AND stage = ?",
                (job_id, candidate_id, stage),
            ).fetchone()
        return None if row is None else str(row[0])

    def results(self, job_id: str, stage: KbRunStage) -> dict[str, str]:
        """Finished work of one stage, in the order it was done."""
        with self.db.read() as connection:
            rows = connection.execute(
                "SELECT candidate_id, result_json FROM explore_completed_work WHERE job_id = ? AND stage = ?"
                " ORDER BY completed_at, rowid",
                (job_id, stage),
            ).fetchall()
        return {str(row[0]): str(row[1]) for row in rows}

    def earlier_result(
        self, candidate_id: str, stage: KbRunStage, *, owners: Sequence[KbJobOwner], exclude_job: str
    ) -> str | None:
        """The newest verdict another job of these owners reached on the same work (open question 4)."""
        marks = ",".join("?" for _ in owners)
        with self.db.read() as connection:
            row = connection.execute(
                "SELECT w.result_json FROM explore_completed_work w JOIN explore_jobs j ON j.id = w.job_id"
                f" WHERE w.candidate_id = ? AND w.stage = ? AND w.job_id != ? AND j.owner IN ({marks})"
                " ORDER BY w.completed_at DESC LIMIT 1",
                (candidate_id, stage, exclude_job, *owners),
            ).fetchone()
        return None if row is None else str(row[0])

    def set_decision_provider(self, job_id: str, provider: DecisionProvider | None) -> None:
        with self.db.write() as connection:
            connection.execute(
                "UPDATE explore_jobs SET decision_provider = ? WHERE id = ?", (provider, job_id)
            )

    def delete(self, job_id: str) -> None:
        """Only for a run that never started (refused before any request left)."""
        with self.db.write() as connection:
            connection.execute("DELETE FROM explore_jobs WHERE id = ?", (job_id,))

    # -- internals --------------------------------------------------------------------------------

    def _require(self, job_id: str) -> KbExploreJob:
        job = self.get(job_id)
        if job is None:
            raise JobNotFound("This job wasn't found.")
        return job

    @staticmethod
    def _latest(connection: sqlite3.Connection, job_id: str) -> KbCheckpoint | None:
        row = connection.execute(
            "SELECT * FROM explore_checkpoints WHERE job_id = ? ORDER BY revision DESC LIMIT 1", (job_id,)
        ).fetchone()
        if row is None:
            return None
        return KbCheckpoint.model_validate(
            {
                "id": row["id"],
                "revision": row["revision"],
                "stage": row["stage"],
                "cursor": row["cursor"],
                "completed_ids": json.loads(row["completed_ids_json"]),
                "pending_ids": json.loads(row["pending_ids_json"]),
                "saved_at": row["saved_at"],
            }
        )

    @classmethod
    def _save_checkpoint(
        cls,
        connection: sqlite3.Connection,
        job_id: str,
        *,
        stage: str,
        cursor: str | None,
        completed: list[str],
        pending: list[str],
    ) -> KbCheckpoint:
        latest = cls._latest(connection, job_id)
        revision = 1 if latest is None else latest.revision + 1
        checkpoint_id = new_id("cp")
        connection.execute(
            "INSERT INTO explore_checkpoints(id, job_id, revision, stage, cursor, completed_ids_json,"
            " pending_ids_json, saved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                checkpoint_id,
                job_id,
                revision,
                stage,
                cursor,
                json.dumps(completed),
                json.dumps(pending),
                utc_now_ms(),
            ),
        )
        saved = cls._latest(connection, job_id)
        assert saved is not None
        return saved

    @classmethod
    def _job(cls, connection: sqlite3.Connection, row: sqlite3.Row) -> KbExploreJob:
        state = cast(KbExploreJobState, row["state"])
        reason = row["stop_reason"]
        checkpoint = cls._latest(connection, row["id"]) if state in ACTIVE_STATES else None
        return KbExploreJob.model_validate(
            {
                "id": row["id"],
                "owner": row["owner"],
                "state": state,
                "stage": row["stage"],
                "stop_reason": reason,
                "budget": json.loads(row["budget_json"]),
                "counters": json.loads(row["counters_json"]),
                "checkpoint": checkpoint,
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
                "decision_choices": _DECISION_CHOICES
                if state == "paused" and reason == "decision_model_required"
                else [],
                "decision_provider": row["decision_provider"],
                "retry_at": row["retry_at"],
            }
        )
