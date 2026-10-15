"""Wiki jobs (``recheck``, ``connections``, ``folder_overview``): rows of the shared ``jobs`` table.

No queue: each job is its own asyncio task, like ingest. A job left running by
a previous process is marked interrupted at the next start (``JobRepository.
interrupt_running``); closing the app interrupts running jobs the same way.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from ...native_io import disk_call
from ..agents.registry import EngineUnavailable
from ..errors import KnowledgeError
from ..ingest.jobs import (
    AGENT_UNAVAILABLE,
    WIKI_INTERRUPTED_REASON,
    JobKind,
    JobRecord,
    JobRepository,
    JobState,
    JobStep,
)
from .agent import WikiJobFailed

logger = logging.getLogger(__name__)
UNEXPECTED = "Something went wrong while working on the wiki. Retry."


@dataclass
class JobContext:
    jobs: JobRepository
    job_id: str

    async def step(self, step: JobStep) -> None:
        await disk_call(self.jobs.set_step, self.job_id, step)

    async def log(self, message: str) -> None:
        """A code-written line for the job journal (never source or model text)."""
        await disk_call(self.jobs.log, self.job_id, message)

    async def count(self, **values: int) -> None:
        await disk_call(self.jobs.update_counters, self.job_id, dict(values))


Work = Callable[[JobContext], Awaitable[None]]


class WikiJobs:
    def __init__(self, jobs: JobRepository) -> None:
        self.jobs = jobs
        self._tasks: dict[str, tuple[JobKind, str | None, asyncio.Task[None]]] = {}
        self._closing = False

    def running(self, kind: JobKind | None = None, target: str | None = None) -> bool:
        return any(
            (kind is None or job_kind == kind) and (target is None or job_target == target)
            for job_kind, job_target, _task in self._tasks.values()
        )

    @property
    def any_running(self) -> bool:
        return bool(self._tasks)

    async def start(self, kind: JobKind, target: str | None, step: JobStep, work: Work) -> JobRecord:
        if self._closing:
            raise WikiBusy("SKAZ is closing. Retry after it starts again.")
        job = await disk_call(lambda: self.jobs.create(target, kind=kind, step=step))
        if self._closing:
            # close() ran while the job row was being written: start nothing after it.
            await disk_call(self.jobs.finish, job.id, "interrupted", error=WIKI_INTERRUPTED_REASON)
            raise WikiBusy("SKAZ is closing. Retry after it starts again.")
        task = asyncio.create_task(self._run(job.id, work), name=f"wiki-{kind}-{job.id}")
        self._tasks[job.id] = (kind, target, task)
        return job

    async def _run(self, job_id: str, work: Work) -> None:
        state: JobState = "failed"
        error: str | None = UNEXPECTED
        code: str | None = None
        try:
            await work(JobContext(self.jobs, job_id))
            state, error = "done", None
        except asyncio.CancelledError:
            state, error = "interrupted", WIKI_INTERRUPTED_REASON
        except WikiJobFailed as failure:
            error, code = failure.message, failure.code
        except EngineUnavailable as failure:
            error, code = failure.message, AGENT_UNAVAILABLE
        except KnowledgeError as failure:
            error = failure.message
        except OSError as failure:
            error = f"SKAZ couldn't use the library folder: {failure.strerror or failure}."
        except Exception:
            logger.exception("wiki job %s failed", job_id)
        finally:
            try:
                self.jobs.finish(job_id, state, error=error, error_code=code if state == "failed" else None)
            finally:
                self._tasks.pop(job_id, None)

    async def wait(self, job_id: str) -> None:
        entry = self._tasks.get(job_id)
        if entry is not None:
            await asyncio.wait({entry[2]})

    async def close(self) -> None:
        self._closing = True
        tasks = [task for _kind, _target, task in self._tasks.values()]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)


class WikiBusy(KnowledgeError):
    status_code = 409
