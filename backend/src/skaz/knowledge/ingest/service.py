"""``runtime.kb_ingest``: request, follow and cancel ingest jobs; wiki settings.

Each request starts its own asyncio task right away (no queue; jobs of
different materials run in parallel). One material has at most one running
job: a second request for it is refused, not queued. At construction, jobs
left ``running`` by a previous process are marked ``interrupted`` (they never
continue silently; the user retries). Closing the app interrupts running
model calls the same way, but lets a job that is already saving pages finish.
"""
from __future__ import annotations

import asyncio
import logging
import threading
from collections.abc import Callable
from dataclasses import dataclass

from ...native_io import disk_call
from ..decisions.protocol import DecisionLayer
from ..errors import KnowledgeError, NotFound
from ..service import KnowledgeService
from .jobs import INTERRUPTED_REASON, JobKind, JobRecord, JobRepository, JobState
from .protocols import (
    ConceptUpdateHook,
    EngineResolver,
    IdentityTextLayer,
    InstructionDetector,
    RecognitionCheck,
    TextLayer,
)
from .runner import BLOCKED_KIND, IngestCancelled, IngestFailed, IngestRun, Limits
from .settings import WikiSettings, read_settings, update_settings
from .writer import WikiWriter

logger = logging.getLogger(__name__)

NO_DETECTOR = ("The safety check for wiki output isn't available in this build, so SKAZ won't write to the "
               "wiki. Update SKAZ and retry.")
NO_ENGINE = "No agent is ready to write the wiki. Connect one in Settings → Models, then retry."
UNEXPECTED = "Something went wrong while adding this material to the wiki. Retry."


class IngestBusy(KnowledgeError):
    status_code = 409

    def __init__(self, message: str = "This material is already being added to the wiki.") -> None:
        super().__init__(message)


class JobNotCancellable(KnowledgeError):
    status_code = 409


@dataclass
class _Active:
    material_id: str
    kind: JobKind = "ingest"
    task: asyncio.Task[None] | None = None
    run: IngestRun | None = None
    cancel_requested: bool = False


class IngestService:
    def __init__(self, kb: KnowledgeService, *, engines: EngineResolver | None = None,
                 detector: InstructionDetector | None = None, decisions: DecisionLayer | None = None,
                 text_layer: TextLayer | None = None, hook: ConceptUpdateHook | None = None,
                 limits: Limits | None = None) -> None:
        self.kb = kb
        self.jobs = JobRepository(kb.db)
        #: Wired by the runtime: the engine registry (A2), detector (S1), decisions (D1), corrections and
        #: discrepancy hook (W2). Assignable so the composition root can fill them after construction.
        self.engines = engines
        self.detector = detector
        self.decisions = decisions
        self.text_layer: TextLayer = text_layer or IdentityTextLayer()
        self.hook = hook
        #: Area W2: the recognition check before the notes (speech only); ``None`` skips the step.
        self.recognition: RecognitionCheck | None = None
        #: Called with ``(material_id, job)`` after a job finished ``done`` (W2: overview, connections).
        self.finished_listeners: list[Callable[[str, JobRecord], None]] = []
        self.limits = limits or Limits()
        self._writer = WikiWriter(kb, threading.Lock())
        #: The one lock for writing wiki files; W2 page edits take it too, so writes never interleave.
        self.write_lock = self._writer.lock
        self._active: dict[str, _Active] = {}
        self._closing = False
        self.recovered = self.jobs.interrupt_running()

    # -- settings -----------------------------------------------------------

    def settings(self) -> WikiSettings:
        return read_settings(self.kb.settings)

    def update_settings(self, *, language: str | None = None, engine: str | None = None,
                        clear_engine: bool = False, auto_add_files_links: bool | None = None,
                        auto_add_text: bool | None = None, background_connections: bool | None = None,
                        auto_corrections: bool | None = None) -> WikiSettings:
        return update_settings(self.kb.settings, language=language, engine=engine, clear_engine=clear_engine,
                               auto_add_files_links=auto_add_files_links, auto_add_text=auto_add_text,
                               background_connections=background_connections,
                               auto_corrections=auto_corrections)

    # -- jobs ---------------------------------------------------------------

    def job(self, job_id: str) -> JobRecord:
        record = self.jobs.get(job_id)
        if record is None:
            raise NotFound("Job not found.")
        return record

    def list_jobs(self, *, material_id: str | None = None) -> list[JobRecord]:
        return self.jobs.list_all(material_id=material_id)

    async def request_ingest(self, material_id: str, *, kind: JobKind = "ingest") -> JobRecord:
        """Start adding a material to the wiki now; returns the running job.

        ``kind="refresh"`` is the same work started by SKAZ after a recognition
        correction changed the text the wiki was built from.
        """
        if self._closing:
            raise IngestBusy("SKAZ is closing. Retry after it starts again.")
        if any(active.material_id == material_id for active in self._active.values()):
            raise IngestBusy()
        reservation = _Active(material_id, kind)
        self._active[f"pending-{id(reservation)}"] = reservation
        try:
            self.kb.require()
            if await disk_call(self.kb.material_repo.get, material_id) is None:
                raise NotFound("Material not found.")
            job = await disk_call(lambda: self.jobs.create(material_id, kind=kind))
        finally:
            self._active.pop(f"pending-{id(reservation)}", None)
        self._active[job.id] = reservation
        reservation.task = asyncio.create_task(self._run(job.id, reservation), name=f"ingest-{job.id}")
        return job

    async def cancel(self, job_id: str) -> JobRecord:
        record = await disk_call(self.job, job_id)
        active = self._active.get(job_id)
        if active is None or active.task is None:
            raise JobNotCancellable("This job has already finished.")
        run = active.run
        if run is not None and run.writing:
            raise JobNotCancellable("The pages are being saved right now; this can't be stopped.")
        active.cancel_requested = True
        if run is not None:
            run.cancel_requested = True
            if run.current_run is not None:
                await run.engine.interrupt(run.current_run)
        active.task.cancel()
        await asyncio.wait({active.task}, timeout=10)
        return await disk_call(self.job, record.id)

    async def close(self) -> None:
        """App shutdown: running model calls are stopped and their jobs marked interrupted."""
        self._closing = True
        tasks = []
        for active in list(self._active.values()):
            if active.task is None:
                continue
            tasks.append(active.task)
            if active.run is not None and active.run.writing:
                continue  # saving pages takes moments; let it finish rather than leave half a wiki update
            if active.run is not None and active.run.current_run is not None:
                await active.run.engine.interrupt(active.run.current_run)
            active.task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    def active_jobs(self) -> set[str]:
        return {job_id for job_id, active in self._active.items() if active.task is not None}

    # -- one job ------------------------------------------------------------

    async def _run(self, job_id: str, active: _Active) -> None:
        state: JobState = "failed"
        error = UNEXPECTED
        try:
            settings = read_settings(self.kb.settings)
            if self.detector is None:
                raise IngestFailed(NO_DETECTOR)
            engine = self.engines(settings.engine) if self.engines is not None else None
            if engine is None:
                raise IngestFailed(NO_ENGINE)
            active.run = IngestRun(
                kb=self.kb, jobs=self.jobs, job_id=job_id, material_id=active.material_id, engine=engine,
                detector=self.detector, decisions=self.decisions, text_layer=self.text_layer,
                writer=self._writer, hook=self.hook, language=settings.language, limits=self.limits,
                recognition=self.recognition,
            )
            active.run.cancel_requested = active.cancel_requested
            await active.run.execute()
            state, error = "done", ""
        except IngestCancelled:
            state, error = "cancelled", "Stopped. Nothing from this run was saved."
        except asyncio.CancelledError:
            if active.cancel_requested:
                state, error = "cancelled", "Stopped. Nothing from this run was saved."
            else:
                state, error = "interrupted", INTERRUPTED_REASON
        except IngestFailed as failure:
            error = failure.message
        except KnowledgeError as failure:
            error = failure.message
        except OSError as failure:
            error = f"SKAZ couldn't use the library folder: {failure.strerror or failure}."
        except Exception:
            logger.exception("ingest job %s failed", job_id)
        finally:
            try:
                self.jobs.finish(job_id, state, error=error or None)
                self._notify_blocked(job_id, active)
            finally:
                self._active.pop(job_id, None)
            if state == "done":
                self._tell_finished(job_id, active.material_id)

    def _tell_finished(self, job_id: str, material_id: str) -> None:
        record = self.jobs.get(job_id)
        for listener in list(self.finished_listeners):
            if record is None:
                break
            try:
                listener(material_id, record)
            except Exception:  # a listener's failure never changes the finished job
                logger.exception("ingest listener failed for job %s", job_id)

    def _notify_blocked(self, job_id: str, active: _Active) -> None:
        run = active.run
        if run is None or not run.report.blocked:
            return
        record = self.kb.material_repo.get(active.material_id)
        title = record.title if record else "a material"
        count = len(run.report.blocked)
        self.kb.notify(
            BLOCKED_KIND, "Text that looked like instructions to an AI was kept out of the wiki",
            body=f"{count} item(s) written from “{title}” were not saved because they read as instructions "
                 "to an AI.",
            payload={"material_id": active.material_id, "job_id": job_id, "items": run.report.blocked[:50]},
        )
