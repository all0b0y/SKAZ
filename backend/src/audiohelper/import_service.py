"""Import jobs: upload, poll, settle — one asyncio task per imported file.

The provider owns the work; this service owns only the bookkeeping around it.
Three properties are deliberate:

* **The job id is written before it is used.**  A crash between creating a job
  and recording it would orphan paid work, so the id reaches SQLite first and
  ``resume()`` picks it up at the next start.
* **A transport failure is not a failed import.**  The job keeps running on the
  provider's side, so the poller waits and retries; only the provider itself can
  declare the transcription failed.  Nothing is ever re-created automatically:
  a new job costs money and needs the user to ask for it.
* **Cancellation tells the truth.**  Deleting a job that already completed is
  impossible, so a lost race keeps the paid transcript instead of destroying it.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

from .gateways import ProviderNotConfigured
from .gateways.soniox_async import (
    ASYNC_MODEL,
    AsyncRequest,
    SonioxAsyncError,
    SonioxAsyncGateway,
    TranscriptionJob,
)
from .import_store import ImportConflict, ImportRecord, ImportSource, ImportStore, digest_file
from .native_io import disk_call

if TYPE_CHECKING:  # pragma: no cover
    from .runtime import Runtime

logger = logging.getLogger(__name__)

#: Poll delays in seconds; the last value repeats until the deadline.
POLL_SCHEDULE: tuple[float, ...] = (2.0, 2.0, 3.0, 5.0, 8.0, 10.0)
#: A job still unfinished after this long is reported, not polled forever.
MAX_WAIT_S = 6 * 60 * 60
#: How many imports may be in flight; the rest wait in the queue.
MAX_CONCURRENT_IMPORTS = 3
#: Transport failures tolerated in a row before the import is called failed.
MAX_TRANSPORT_FAILURES = 30


class ImportRejected(ValueError):
    """The request cannot start: unreadable file, no consent, no key."""


@dataclass(frozen=True)
class ImportRequest:
    session_id: str
    path: Path
    translate: bool
    declared_duration_ms: int | None


class ImportService:
    def __init__(self, runtime: Runtime) -> None:
        self._runtime = runtime
        self.store = ImportStore(runtime.db)
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._slots = asyncio.Semaphore(MAX_CONCURRENT_IMPORTS)
        self._closing = False

    @property
    def active(self) -> int:
        return sum(1 for task in self._tasks.values() if not task.done())

    async def start(self, request: ImportRequest) -> ImportRecord:
        """Register the import and run it in the background. Raises before any charge."""
        settings = await disk_call(self._runtime.settings_store.load)
        if not settings.cloud_consent:
            raise ProviderNotConfigured(
                "Importing a file sends its audio to Soniox; enable cloud consent in settings."
            )
        if not await disk_call(self._runtime.api_key, "soniox"):
            raise ProviderNotConfigured("Soniox has no API key stored; add one in settings.")
        source = await disk_call(_describe_source, request.path)
        record = await disk_call(
            self.store.create, request.session_id, source=source, model=ASYNC_MODEL,
            translate=request.translate,
            translation_target_language=settings.translation_target_language,
            used_languages=(tuple(settings.used_languages)
                            if settings.used_languages is not None else None),
            declared_duration_ms=request.declared_duration_ms,
        )
        self._spawn(record)
        return record

    def resume(self) -> None:
        """Re-attach to every import left unfinished by a previous process."""
        for record in self.store.unsettled():
            if record.session_id not in self._tasks:
                self._spawn(record)

    def _spawn(self, record: ImportRecord) -> None:
        if self._closing:
            return
        task = asyncio.create_task(self._run(record.session_id), name=f"import-{record.session_id}")
        self._tasks[record.session_id] = task
        task.add_done_callback(lambda finished: self._forget(record.session_id, finished))

    def _forget(self, session_id: str, task: asyncio.Task[None]) -> None:
        if self._tasks.get(session_id) is task:
            self._tasks.pop(session_id, None)
        if not task.cancelled() and task.exception() is not None:
            logger.warning("Import task for %s ended unexpectedly", session_id,
                           exc_info=task.exception())

    async def cancel(self, session_id: str) -> ImportRecord:
        """Stop an in-flight import, then release provider-side resources.

        A job that finished first is kept: it is already paid for, and deleting a
        completed transcript to honour a cancellation destroys value the user
        cannot get back.
        """
        record = await disk_call(self.store.get, session_id)
        if record is None:
            raise ImportConflict("This session is not an import.")
        if record.status == "completed":
            return record
        task = self._tasks.get(session_id)
        if task is not None and not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        settled = await disk_call(self.store.get, session_id)
        if settled is not None and settled.status == "completed":
            return settled
        cancelled = await disk_call(self.store.mark_cancelled, session_id)
        await self._release(record, delete_job=True)
        return cancelled

    async def _run(self, session_id: str) -> None:
        async with self._slots:
            record = await disk_call(self.store.get, session_id)
            if record is None or record.status not in ("queued", "uploading", "processing"):
                return
            try:
                await self._execute(record)
            except asyncio.CancelledError:
                raise
            except SonioxAsyncError as error:
                await self._fail(session_id, str(error))
            except (ImportConflict, ProviderNotConfigured, OSError) as error:
                await self._fail(session_id, str(error))

    async def _execute(self, record: ImportRecord) -> None:
        gateway = await self._gateway()
        session_id = record.session_id
        if record.transcription_id is None:
            file_id = record.provider_file_id
            if file_id is None:
                await disk_call(self.store.mark_uploading, session_id)
                content = await disk_call(Path(record.source.path).read_bytes)
                uploaded = await gateway.upload(filename=record.source.name, content=content)
                file_id = uploaded.id
                record = await disk_call(
                    self.store.mark_uploaded, session_id, provider_file_id=file_id
                )
            job = await gateway.create(file_id=file_id, request=AsyncRequest(
                translation_target_language=(
                    await self._target_language() if record.translate else None
                ),
                used_languages=await self._used_languages(),
            ))
            # Written before the first poll: a crash here must not orphan paid work.
            record = await disk_call(
                self.store.mark_processing, session_id, transcription_id=job.id
            )
        transcription_id = record.transcription_id
        assert transcription_id is not None
        job = await self._await_completion(gateway, session_id, transcription_id)
        transcript = await gateway.transcript(transcription_id)
        # Release the provider-side copy before the import is observably complete:
        # "completed" must not be a state in which the user's audio still sits on
        # Soniox. The job id stays stored, so a failure below can re-read it.
        await self._release(record, delete_job=False)
        await disk_call(
            self.store.apply_transcript, session_id, tokens=transcript.tokens,
            audio_duration_ms=job.audio_duration_ms or 0,
        )
        await disk_call(self._runtime.session_files.project, session_id)
        self._runtime.mark_verified(
            "asr", "soniox", record.model, "Transcribed an imported audio file through this installation",
        )

    async def _await_completion(
        self, gateway: SonioxAsyncGateway, session_id: str, transcription_id: str,
    ) -> TranscriptionJob:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + MAX_WAIT_S
        transport_failures = 0
        for attempt in range(1 << 30):
            delay = POLL_SCHEDULE[min(attempt, len(POLL_SCHEDULE) - 1)]
            await asyncio.sleep(delay)
            if loop.time() > deadline:
                raise SonioxAsyncError(
                    "Soniox did not finish this transcription within six hours.", retryable=False,
                )
            try:
                job = await gateway.status(transcription_id)
            except SonioxAsyncError as error:
                if not error.retryable:
                    raise
                # The job is unaffected by our connectivity; keep waiting for it.
                transport_failures += 1
                if transport_failures > MAX_TRANSPORT_FAILURES:
                    raise
                continue
            transport_failures = 0
            if job.status == "completed":
                return job
            if job.status == "error":
                raise SonioxAsyncError(
                    _failure_text(job.error_type, job.error_message), retryable=False,
                )
        raise AssertionError("unreachable")  # pragma: no cover

    async def _release(self, record: ImportRecord, *, delete_job: bool) -> None:
        """Remove provider-side copies. Never fails the import over cleanup."""
        try:
            gateway = await self._gateway()
        except ProviderNotConfigured:
            return
        if record.provider_file_id is not None:
            with contextlib.suppress(SonioxAsyncError):
                await gateway.delete_file(record.provider_file_id)
        if delete_job and record.transcription_id is not None:
            # The provider refuses while a job is processing; that is expected and
            # harmless — unused jobs expire on their side after 30 days.
            with contextlib.suppress(SonioxAsyncError):
                await gateway.delete_transcription(record.transcription_id)

    async def _fail(self, session_id: str, error: str) -> None:
        record = await disk_call(self.store.get, session_id)
        if record is None or record.status not in ("queued", "uploading", "processing"):
            return
        await disk_call(self.store.mark_failed, session_id, error=error)
        await self._release(record, delete_job=False)

    async def _gateway(self) -> SonioxAsyncGateway:
        key = await disk_call(self._runtime.api_key, "soniox")
        if not key:
            raise ProviderNotConfigured("Soniox has no API key stored; add one in settings.")
        return SonioxAsyncGateway(api_key=key, http=self._runtime.http)

    async def _target_language(self) -> str:
        settings = await disk_call(self._runtime.settings_store.load)
        return settings.translation_target_language

    async def _used_languages(self) -> tuple[str, ...] | None:
        settings = await disk_call(self._runtime.settings_store.load)
        return tuple(settings.used_languages) if settings.used_languages is not None else None

    async def close(self) -> None:
        self._closing = True
        tasks = [task for task in self._tasks.values() if not task.done()]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)


def _failure_text(error_type: str | None, error_message: str | None) -> str:
    detail = " ".join(part for part in (error_type, error_message) if part)
    return f"Soniox could not transcribe this file: {detail}" if detail else (
        "Soniox could not transcribe this file."
    )


def _describe_source(path: Path) -> ImportSource:
    if not path.is_file():
        raise ImportRejected("The selected file no longer exists.")
    stat = path.stat()
    if stat.st_size <= 0:
        raise ImportRejected("The selected file is empty.")
    return ImportSource(
        path=str(path), name=path.name, size_bytes=stat.st_size,
        mtime_ns=stat.st_mtime_ns, sha256=digest_file(path),
    )
