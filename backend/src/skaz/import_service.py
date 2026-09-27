"""Import jobs: upload, poll, settle — one asyncio task per imported file.

The provider owns the work; this service owns only the bookkeeping around it.
Three properties are deliberate:

* **Submission intent precedes the paid request.** A crash before saving the
  returned job ID is ambiguous; it blocks blind resubmission. Known IDs resume
  only after an explicit Retry, never on application startup.
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
from dataclasses import dataclass, replace
from pathlib import Path
from typing import TYPE_CHECKING

from . import media_tools
from .gateways import ProviderNotConfigured
from .gateways.soniox_async import (
    ASYNC_MODEL,
    AsyncRequest,
    SonioxAsyncError,
    SonioxAsyncGateway,
    TranscriptionJob,
)
from .import_store import UNSETTLED, ImportConflict, ImportRecord, ImportSource, ImportStore, digest_file
from .import_temp import ImportTemp
from .media_source import youtube_source
from .native_io import disk_call

if TYPE_CHECKING:  # pragma: no cover
    from .runtime import Runtime

logger = logging.getLogger(__name__)

#: Poll delays in seconds; the last value repeats until the deadline.
POLL_SCHEDULE: tuple[float, ...] = (2.0, 2.0, 3.0, 5.0, 8.0, 10.0)
#: A job still unfinished after this long is reported, not polled forever.
MAX_WAIT_S = 6 * 60 * 60
#: One active import; additional admissions are rejected, never queued.
MAX_CONCURRENT_IMPORTS = 1
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
    url: str | None = None
    prepare_media: bool = False
    allow_duplicate: bool = False


class ImportService:
    def __init__(self, runtime: Runtime) -> None:
        self._runtime = runtime
        self.store = ImportStore(runtime.db)
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._slots = asyncio.Semaphore(MAX_CONCURRENT_IMPORTS)
        self._closing = False
        self._admitting = False
        self.temp = ImportTemp(runtime.config.data_dir / "import-temp")

    @property
    def active(self) -> int:
        return int(self._admitting) + sum(1 for task in self._tasks.values() if not task.done())

    async def start(self, request: ImportRequest) -> ImportRecord:
        """Reserve before any await: simultaneous requests must not form a queue."""
        self._claim()
        try:
            return await self._start(request)
        finally:
            self._admitting = False

    def _claim(self) -> None:
        if self._closing or self.active:
            raise ImportConflict("Another import is active. Open it to continue or cancel.")
        if self._runtime.native_tasks or self._runtime.native_closing:
            raise ImportConflict("Stop recording before importing media.")
        self._admitting = True

    async def _start(self, request: ImportRequest) -> ImportRecord:
        settings = await disk_call(self._runtime.settings_store.load)
        if not settings.cloud_consent:
            raise ProviderNotConfigured(
                "Importing a file sends its audio to Soniox; enable cloud consent in settings."
            )
        if not await disk_call(self._runtime.api_key, "soniox"):
            raise ProviderNotConfigured("Soniox has no API key stored; add one in settings.")
        duration = request.declared_duration_ms
        if request.url:
            youtube = youtube_source(request.url)
            if not request.allow_duplicate and bool(
                await disk_call(self.store.matching_video, youtube.video_id)
            ):
                raise ImportConflict("This video already has a session. Open it or confirm Transcribe again.")
            info = await media_tools.youtube_metadata(youtube.url)
            duration = info["duration_ms"]
            source = ImportSource("", info["title"], 0, 0, "", "youtube", youtube.url,
                                  youtube.video_id, True)
        else:
            source = await disk_call(_describe_source, request.path)
            if request.prepare_media:
                info = await media_tools.local_metadata(request.path)
                duration = info["duration_ms"]
                source = replace(source, prepare_media=True)
        record = await disk_call(
            self.store.create, request.session_id, source=source, model=ASYNC_MODEL,
            translate=request.translate,
            translation_target_language=settings.translation_target_language,
            used_languages=(tuple(settings.used_languages)
                            if settings.used_languages is not None else None),
            declared_duration_ms=duration,
        )
        await disk_call(self._runtime.storage.ensure_import_directory, request.session_id)
        self._spawn(record)
        return record

    def resume(self) -> None:
        """Mark unfinished jobs interrupted. Only an explicit retry resumes them."""
        self.store.interrupt()

    async def retry(self, session_id: str) -> ImportRecord:
        self._claim()
        try:
            settings = await disk_call(self._runtime.settings_store.load)
            if not settings.cloud_consent:
                raise ProviderNotConfigured("Enable cloud processing before retrying an import.")
            gateway = await self._gateway()
            previous = await disk_call(self.store.get, session_id)
            if previous is None or previous.status not in ("failed", "interrupted"):
                raise ImportConflict("Only a failed or interrupted import can be retried.")
            if previous.transcription_id:
                job = await gateway.status(previous.transcription_id)
                if job.status == "error":
                    # Only an explicit retry of a definitively failed job may create paid work.
                    await self._release(previous, delete_job=True)
                    await disk_call(self.store.reset_failed_job, session_id)
            record = await disk_call(self.store.retry, session_id)
            self._spawn(record)
            return record
        finally:
            self._admitting = False

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
        await self._release(settled or record, delete_job=True)
        await disk_call(self.temp.remove, session_id)
        return cancelled

    async def prepare_delete(self, session_id: str) -> None:
        """Stop imports and drain final projection before either delete endpoint."""
        record = await disk_call(self.store.get, session_id)
        if record is not None and record.status not in ("completed", "cancelled"):
            await self.cancel(session_id)
        task = self._tasks.get(session_id)
        if task is not None:
            await asyncio.gather(task, return_exceptions=True)

    async def _run(self, session_id: str) -> None:
        async with self._slots:
            record = await disk_call(self.store.get, session_id)
            if record is None or record.status not in UNSETTLED:
                return
            try:
                await self._execute(record)
            except asyncio.CancelledError:
                raise
            except SonioxAsyncError as error:
                await self._fail(session_id, str(error))
            except (ImportConflict, ProviderNotConfigured, OSError, media_tools.MediaError) as error:
                await self._fail(session_id, str(error))

    async def _execute(self, record: ImportRecord) -> None:
        await disk_call(self._runtime.storage.ensure_import_directory, record.session_id)
        gateway = await self._gateway()
        session_id = record.session_id
        if record.transcription_id is None:
            file_id = record.provider_file_id
            if file_id is None:
                path = await self._audio_path(record)
                await disk_call(self.store.mark_uploading, session_id)
                uploaded = await gateway.upload_path(path)
                file_id = uploaded.id
                record = await disk_call(
                    self.store.mark_uploaded, session_id, provider_file_id=file_id
                )
            target, languages = await disk_call(self.store.recognition_settings, session_id)
            await disk_call(self.store.mark_submitting, session_id)
            job = await gateway.create(file_id=file_id, request=AsyncRequest(
                translation_target_language=target if record.translate else None,
                used_languages=languages,
            ))
            # A crash before this write leaves submission_pending, refusing blind retry.
            record = await disk_call(
                self.store.mark_processing, session_id, transcription_id=job.id
            )
        transcription_id = record.transcription_id
        assert transcription_id is not None
        job = await self._await_completion(gateway, session_id, transcription_id)
        transcript = await gateway.transcript(transcription_id)
        # Provider cleanup is best-effort, not proof of remote deletion. The job
        # ID stays stored so interrupted local settlement can re-read its result.
        await self._release(record, delete_job=False)
        # The job ID remains usable if cleanup or a crash interrupts completion.
        await disk_call(self.temp.remove, session_id)
        await disk_call(
            self.store.apply_transcript, session_id, tokens=transcript.tokens,
            audio_duration_ms=job.audio_duration_ms or 0,
        )
        await disk_call(self._runtime.session_files.project, session_id)
        self._runtime.mark_verified(
            "asr", "soniox", record.model, "Transcribed an imported audio file through this installation",
        )

    async def _audio_path(self, record: ImportRecord) -> Path:
        if not record.source.prepare_media:
            return Path(record.source.path)
        directory = await disk_call(self.temp.directory, record.session_id)
        ready = directory / "ready.m4a"
        if ready.is_file() and not ready.is_symlink():
            return ready
        source = Path(record.source.path)
        if record.source.url:
            await disk_call(self.store.stage, record.session_id, "downloading")
            source = await media_tools.download_audio(record.source.url, directory)
        await disk_call(self.store.stage, record.session_id, "preparing")
        audio = await media_tools.extract_audio(source, directory)
        await disk_call(audio.replace, ready)
        return ready

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
        if record is None or record.status not in UNSETTLED:
            return
        await disk_call(self.store.mark_failed, session_id, error=error)

    async def _gateway(self) -> SonioxAsyncGateway:
        key = await disk_call(self._runtime.api_key, "soniox")
        if not key:
            raise ProviderNotConfigured("Soniox has no API key stored; add one in settings.")
        return SonioxAsyncGateway(api_key=key, http=self._runtime.http)

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
