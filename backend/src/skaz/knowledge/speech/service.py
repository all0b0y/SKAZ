"""Speech as material: recordings and imported audio/video feeding library materials.

A recording or an import runs in a legacy session (see ``legacy.py``); this
service links that session to a **material** (``speech_carriers``), keeps the
material's status, and projects finished speech into its fragments.

Nothing waits in a queue and nothing polls: the legacy code calls cheap hooks
(an event was saved, a stream opened/settled, an import changed), and each
hook schedules short work for *that* material only. Work for one material is
serialised by its own lock; materials never wait for each other.

Statuses: ``recording`` while audio streams → ``processing`` while the tail is
finished (or an import runs) → ``ready``. Pause settles like Stop (the text so
far is complete, so the material is ``ready``) and Continue makes it
``recording`` again — the same material. A recognition error belongs to the
attempt (``attempt_error``), not to the material: the text received so far is
kept and the material is ``ready``; it is ``failed`` only when an attempt
ended with an error and there is no text at all (PRODUCT: "Recording after a
transcription error").
"""
from __future__ import annotations

import asyncio
import contextlib
import functools
import logging
import os
import shutil
import threading
import uuid
from collections.abc import Awaitable, Callable, Coroutine
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Literal

from ...import_service import ImportRequest
from ...native_io import disk_call
from ..errors import KnowledgeError, NameTaken, NotFound
from ..library.layout import STAGING_PATH
from ..library.library import INBOX_ID
from ..library.names import validate_name
from ..markdown.source import MaterialStatus, Origin
from ..markdown.text import name_key
from ..service import KnowledgeService
from .carriers import IMPORT_KINDS, Carrier, CarrierKind, CarrierRepository
from .legacy import (
    IMPORT_CONFLICT,
    IMPORT_INVALID,
    SPOKEN_LANGUAGES,
    ImportState,
    LegacySpeech,
    RecordingState,
)
from .media import UnsupportedMedia, classify_video_link, default_recording_titles, file_kind
from .projector import SpeechProjector

logger = logging.getLogger(__name__)

LAST_FOLDER_KEY = "last_folder_id"
INTERRUPTED_RECORDING = "SKAZ closed before this recording was stopped."
INTERRUPTED_IMPORT = "The import was interrupted when SKAZ closed. Retry to continue."
CANCELLED_IMPORT = "The import was cancelled."
STILL_STREAMING = "The recorder is still streaming. Stop or pause it in the recorder first."


class SpeechInvalid(KnowledgeError):
    status_code = 400


class SpeechConflict(KnowledgeError):
    status_code = 409


@dataclass(frozen=True)
class SpeechView:
    material_id: str
    session_id: str
    kind: CarrierKind
    title: str
    folder_id: str
    status: str
    fragment_count: int
    created_at: str
    #: Recordings only: what the recorder does now.
    recording_state: RecordingState | None
    #: Imports only.
    import_state: ImportState | None
    import_stage: str | None
    #: The last attempt's problem in plain English (text received so far is kept).
    error: str | None


@dataclass(frozen=True)
class ImportInput:
    path: str | None = None
    url: str | None = None
    folder_id: str | None = None
    title: str | None = None
    translate: bool = False
    language: str | None = None
    allow_duplicate: bool = False
    #: Video metadata the caller already fetched (``media_tools.video_metadata``); spares a second probe.
    metadata: dict[str, Any] | None = None


#: ``(material_id, kind, error)`` — an import failed (``error`` set) or runs again (``error`` is None).
ImportListener = Callable[[str, CarrierKind, str | None], None]


class SpeechService:
    def __init__(self, kb: KnowledgeService, legacy: LegacySpeech, *,
                 clock: Callable[[], datetime] | None = None) -> None:
        self.kb = kb
        self.legacy = legacy
        self.carriers = CarrierRepository(kb.db)
        self.projector = SpeechProjector(kb, legacy.read)
        self._clock = clock or (lambda: datetime.now().astimezone())
        self._by_session: dict[str, str] | None = None
        self._map_lock = threading.Lock()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._tasks: set[asyncio.Task[Any]] = set()
        self._live: dict[str, asyncio.Task[None]] = {}
        self._dirty: set[str] = set()
        self._locks: dict[str, asyncio.Lock] = {}
        self._closing = False
        #: Called with a material id when speech settled finished (Stop or a completed import,
        #: not a Pause): the wiki may process it now.
        self._finished_listeners: list[Callable[[str], None]] = []
        self._import_listeners: list[ImportListener] = []
        legacy.add_listeners(on_event=self._on_event_saved, on_import=self._on_import_changed)

    # -- plumbing -----------------------------------------------------------

    def _remember_loop(self) -> None:
        with contextlib.suppress(RuntimeError):
            self._loop = asyncio.get_running_loop()

    def _session_map(self) -> dict[str, str]:
        with self._map_lock:
            if self._by_session is None:
                self._by_session = {item.session_id: item.material_id for item in self.carriers.list_all()}
            return self._by_session

    def _remember(self, carrier: Carrier) -> None:
        mapping = self._session_map()
        with self._map_lock:
            mapping[carrier.session_id] = carrier.material_id

    def _carrier_for_session(self, session_id: str) -> Carrier | None:
        if session_id not in self._session_map():
            return None
        return self.carriers.by_session(session_id)

    def _lock(self, material_id: str) -> asyncio.Lock:
        return self._locks.setdefault(material_id, asyncio.Lock())

    def _spawn(self, work: Coroutine[Any, Any, None]) -> None:
        if self._closing:
            work.close()
            return
        self._remember_loop()
        task = asyncio.ensure_future(work)
        self._tasks.add(task)
        task.add_done_callback(self._finished)

    def _finished(self, task: asyncio.Task[Any]) -> None:
        self._tasks.discard(task)
        if not task.cancelled() and task.exception() is not None:
            logger.warning("Speech material work failed", exc_info=task.exception())

    async def _guarded(self, material_id: str, work: Callable[[], Awaitable[None]]) -> None:
        """Serialise per material; a missing/unavailable library is not an error here."""
        async with self._lock(material_id):
            try:
                await work()
            except (KnowledgeError, OSError, ValueError) as error:
                logger.warning("Speech material %s not updated: %s", material_id, error)

    async def _set_status(self, material_id: str, status: MaterialStatus) -> None:
        record = await disk_call(self.kb.material_repo.get, material_id)
        if record is not None and record.status == status:
            return
        await disk_call(self.kb.set_material_status, material_id, status)

    # -- hooks called by the legacy code (cheap, never raise) ----------------

    def _on_event_saved(self, session_id: str) -> None:
        """``LiveStore.save_event`` committed new speech (runs on the saving thread)."""
        loop = self._loop
        material_id = self._session_map().get(session_id)
        if material_id is None or loop is None or loop.is_closed() or self._closing:
            return
        with contextlib.suppress(RuntimeError):
            loop.call_soon_threadsafe(self._request_live, material_id, session_id)

    def _request_live(self, material_id: str, session_id: str) -> None:
        """Coalesce bursts of events: one projection runs, one more follows if events came meanwhile."""
        if self._closing:
            return
        running = self._live.get(material_id)
        if running is not None and not running.done():
            self._dirty.add(material_id)
            return
        task = asyncio.ensure_future(self._live_projection(material_id, session_id))
        self._live[material_id] = task
        self._tasks.add(task)
        task.add_done_callback(self._finished)

    async def _live_projection(self, material_id: str, session_id: str) -> None:
        try:
            while True:
                self._dirty.discard(material_id)
                await self._guarded(material_id, lambda: self._project(material_id, session_id, final=False))
                if material_id not in self._dirty or self._closing:
                    return
        finally:
            if self._live.get(material_id) is asyncio.current_task():
                self._live.pop(material_id, None)

    async def _project(self, material_id: str, session_id: str, *, final: bool) -> None:
        await disk_call(self.projector.project, material_id, session_id, final=final)

    def on_stream_opened(self, session_id: str) -> None:
        self._remember_loop()
        carrier = self._carrier_for_session(session_id)
        if carrier is not None:
            self._spawn(self._guarded(carrier.material_id, lambda: self._opened(carrier)))

    async def _opened(self, carrier: Carrier) -> None:
        # A new attempt: its success clears the previous attempt's warning.
        await disk_call(self.carriers.set_error, carrier.material_id, None)
        await self._set_status(carrier.material_id, "recording")

    def on_stream_processing(self, session_id: str) -> None:
        carrier = self._carrier_for_session(session_id)
        if carrier is not None:
            self._spawn(self._guarded(carrier.material_id,
                                      lambda: self._set_status(carrier.material_id, "processing")))

    def on_stream_settled(self, session_id: str, *, reason: str | None) -> None:
        """Stop/Pause finished (or the stream ended abnormally): the tail closes."""
        carrier = self._carrier_for_session(session_id)
        if carrier is not None:
            self._spawn(self._guarded(carrier.material_id, lambda: self._settle(carrier, reason, True)))

    def _on_import_changed(self, session_id: str) -> None:
        carrier = self._carrier_for_session(session_id)
        if carrier is not None:
            self._spawn(self._guarded(carrier.material_id, lambda: self._reconcile_import(carrier)))

    # -- settling -------------------------------------------------------------

    async def _settle(self, carrier: Carrier, reason: str | None, set_error: bool) -> None:
        before = await disk_call(self.kb.material_repo.get, carrier.material_id)
        was_ready = before is not None and before.status == "ready"
        await self._project(carrier.material_id, carrier.session_id, final=True)
        await disk_call(self.projector.write_translation, carrier.material_id, carrier.session_id)
        if set_error:
            await disk_call(self.carriers.set_error, carrier.material_id, reason)
        error = reason if set_error else carrier.attempt_error
        record = await disk_call(self.kb.material_repo.get, carrier.material_id)
        empty = record is None or record.fragment_count == 0
        status: MaterialStatus = "failed" if error and empty else "ready"
        await self._set_status(carrier.material_id, status)
        # Once per finish: an explicit Stop after the stream already settled changes nothing.
        if status == "ready" and not was_ready and \
                await disk_call(self.legacy.recording_state, carrier.session_id) != "paused":
            for listener in list(self._finished_listeners):
                try:
                    listener(carrier.material_id)
                except Exception:
                    logger.exception("Speech finished listener failed for %s", carrier.material_id)

    def on_finished(self, listener: Callable[[str], None]) -> None:
        """Subscribe to finished speech materials (used to add them to the wiki)."""
        self._finished_listeners.append(listener)

    def on_import_state(self, listener: ImportListener) -> None:
        """Subscribe to import failures and restarts (used for ``link_failed`` notifications)."""
        self._import_listeners.append(listener)

    def _emit_import(self, carrier: Carrier, error: str | None) -> None:
        for listener in list(self._import_listeners):
            try:
                listener(carrier.material_id, carrier.kind, error)
            except Exception:
                logger.exception("Speech import listener failed for %s", carrier.material_id)

    async def _reconcile_import(self, carrier: Carrier) -> None:
        status = await disk_call(self.legacy.import_status, carrier.session_id)
        if status is None:
            # The legacy session is gone: only a cancelled import deletes it.
            await disk_call(self.carriers.set_error, carrier.material_id, CANCELLED_IMPORT)
            await self._set_status(carrier.material_id, "failed")
        elif status.state == "running":
            await disk_call(self.carriers.set_error, carrier.material_id, None)
            await self._set_status(carrier.material_id, "processing")
            self._emit_import(carrier, None)
        elif status.state == "completed":
            await self._settle(carrier, None, True)
        else:
            error = {"interrupted": status.error or INTERRUPTED_IMPORT,
                     "cancelled": CANCELLED_IMPORT}.get(status.state, status.error or "The import failed.")
            await disk_call(self.carriers.set_error, carrier.material_id, error)
            await self._set_status(carrier.material_id, "failed")
            if status.state == "failed":
                self._emit_import(carrier, error)

    # -- lifecycle ------------------------------------------------------------

    async def start(self) -> None:
        """App startup (after the legacy recovery): settle what a restart interrupted."""
        self._remember_loop()
        self._spawn(self._reconcile_all())

    async def _reconcile_all(self) -> None:
        await disk_call(self._restore_carriers)
        for carrier in await disk_call(self.carriers.list_all):
            if carrier.is_import:
                await self._guarded(carrier.material_id, functools.partial(self._reconcile_import, carrier))
                continue
            state = await disk_call(self.legacy.recording_state, carrier.session_id)
            if state in ("recording", "processing"):
                continue  # a stream opened meanwhile owns it
            record = await disk_call(self.kb.material_repo.get, carrier.material_id)
            if record is not None and record.status in ("recording", "processing"):
                await self._guarded(carrier.material_id,
                                    functools.partial(self._settle, carrier, INTERRUPTED_RECORDING, True))

    def _restore_carriers(self) -> None:
        """A crash between creating the material and linking it: the link is in ``origin``."""
        known = {item.material_id for item in self.carriers.list_all()}
        for record in self.kb.materials():
            session_id = (record.origin or {}).get("session_id")
            if record.id in known or record.kind not in ("recording", *IMPORT_KINDS) \
                    or not isinstance(session_id, str):
                continue
            with contextlib.suppress(ValueError):
                self._remember(self.carriers.add(record.id, session_id, record.kind))

    async def close(self) -> None:
        """App shutdown: let in-flight projections finish (each is short and crash-safe anyway)."""
        self._closing = True
        while self._tasks:
            await asyncio.gather(*list(self._tasks), return_exceptions=True)

    # -- folders and names ----------------------------------------------------

    def _folder(self, folder_id: str | None) -> str:
        if folder_id is not None:
            if self.kb.folder_repo.get(folder_id) is None:
                raise NotFound("Folder not found.")
            return folder_id
        last = self.kb.settings.get(LAST_FOLDER_KEY)
        if isinstance(last, str) and self.kb.folder_repo.get(last) is not None:
            return last
        return INBOX_ID

    def default_folder(self) -> str:
        """The folder a new recording/import goes to: the last used one, else Inbox (decision 16)."""
        return self._folder(None)

    def _assert_free(self, folder_id: str, title: str) -> None:
        key = name_key(title)
        if any(name_key(item.title) == key for item in self.kb.materials(folder_id=folder_id)):
            raise NameTaken()

    def _new_material(self, folder_id: str, title: str, kind: CarrierKind, status: MaterialStatus,
                      origin: Origin, languages: list[str]) -> str:
        return self.kb.create_material(folder_id, title, kind, [], status=status, origin=origin,
                                       languages=languages).manifest.id

    def _link(self, material_id: str, session_id: str, kind: CarrierKind, folder_id: str) -> Carrier:
        carrier = self.carriers.add(material_id, session_id, kind)
        self._remember(carrier)
        self.kb.settings.set(LAST_FOLDER_KEY, folder_id)
        return carrier

    # -- recordings -----------------------------------------------------------

    async def start_recording(self, folder_id: str | None, title: str | None) -> SpeechView:
        """A new material in ``folder_id`` (default: last used) and the session the recorder streams to."""
        self._remember_loop()
        self.kb.require()
        folder = await disk_call(self._folder, folder_id)
        titles = (validate_name(title),) if title else default_recording_titles(self._clock())
        chosen = None
        for candidate in titles:
            try:
                await disk_call(self._assert_free, folder, candidate)
            except NameTaken:
                continue
            chosen = candidate
            break
        if chosen is None:
            raise NameTaken()
        session_id = await disk_call(self.legacy.create_recording_session, chosen)
        origin = Origin.model_validate({"type": "recording", "session_id": session_id})
        try:
            material_id = await disk_call(self._new_material, folder, chosen, "recording", "recording",
                                          origin, [])
        except BaseException:
            await self.legacy.delete_session(session_id)
            raise
        await disk_call(self._link, material_id, session_id, "recording", folder)
        return await self.view(material_id)

    async def _recording(self, material_id: str) -> Carrier:
        carrier = await disk_call(self.carriers.get, material_id)
        if carrier is None:
            raise NotFound("This material is not a recording.")
        if carrier.kind != "recording":
            raise SpeechConflict("This material is an import, not a recording.")
        return carrier

    async def end_recording(self, material_id: str, action: Literal["stop", "pause"]) -> SpeechView:
        """Settle a recording whose recorder is not streaming (after the recorder's own Stop/Pause,
        or after a crash). The live stream itself is ended by the recorder over its WebSocket."""
        carrier = await self._recording(material_id)
        state = await disk_call(self.legacy.recording_state, carrier.session_id)
        if state == "recording":
            raise SpeechConflict(STILL_STREAMING)
        if state == "processing":
            return await self.view(material_id)  # settles itself when the tail is done
        if state is not None:
            target: Literal["paused", "stopped"] = "paused" if action == "pause" else "stopped"
            await disk_call(self.legacy.mark_session, carrier.session_id, target)
        await self._guarded(material_id, lambda: self._settle(carrier, None, False))
        return await self.view(material_id)

    async def resume_recording(self, material_id: str) -> SpeechView:
        """Check that the recorder may continue this material; it then opens the session's stream."""
        carrier = await self._recording(material_id)
        state = await disk_call(self.legacy.recording_state, carrier.session_id)
        if state is None:
            raise NotFound("This recording's session no longer exists.")
        if state == "recording":
            raise SpeechConflict("This recording is already running.")
        if state == "processing":
            raise SpeechConflict(
                "SKAZ is still finishing the end of this recording. Continue when it is ready.")
        return await self.view(material_id)

    # -- imports --------------------------------------------------------------

    async def start_import(self, request: ImportInput) -> SpeechView:
        self._remember_loop()
        self.kb.require()
        if (request.path is None) == (request.url is None):
            raise SpeechInvalid("Choose one file or one video link.")
        if request.language is not None and request.language not in SPOKEN_LANGUAGES:
            raise SpeechInvalid("Unsupported spoken language.")
        folder = await disk_call(self._folder, request.folder_id)
        metadata: dict[str, Any] | None = None
        path = Path(request.path or "")
        if request.url is not None:
            try:
                link = classify_video_link(request.url)
            except UnsupportedMedia as error:
                raise SpeechInvalid(str(error)) from error
            kind: CarrierKind = "video_link"
            url: str | None = link.url
            origin = Origin(type="url", url=link.url)
            title = request.title
            metadata = request.metadata
            if metadata is None and not title:
                try:
                    metadata = await self.legacy.video_metadata(link.url)
                except IMPORT_INVALID as error:
                    raise SpeechInvalid(str(error)) from error
            if not title:
                assert metadata is not None
                title = str(metadata["title"])
        else:
            if not path.is_absolute():
                raise SpeechInvalid("The file path must be absolute.")
            try:
                kind = file_kind(path)
            except UnsupportedMedia as error:
                raise SpeechInvalid(str(error)) from error
            url = None
            origin = Origin(type="file", file_name=path.name)
            title = request.title or path.stem
        clean = validate_name(title[:200])
        await disk_call(self._assert_free, folder, clean)
        session_id = await disk_call(self.legacy.create_import_session, clean)
        try:
            await self.legacy.start_import(ImportRequest(
                session_id=session_id, path=path, translate=request.translate, declared_duration_ms=None,
                url=url, prepare_media=kind != "audio", allow_duplicate=request.allow_duplicate,
                used_languages=(request.language,) if request.language else None, metadata=metadata,
            ))
        except IMPORT_CONFLICT as error:
            await self.legacy.delete_session(session_id)
            raise SpeechConflict(str(error)) from error
        except IMPORT_INVALID as error:
            await self.legacy.delete_session(session_id)
            raise SpeechInvalid(str(error)) from error
        try:
            material_id = await disk_call(
                self._new_material, folder, clean, kind, "processing",
                origin.model_copy(update={"session_id": session_id}),
                [request.language] if request.language else [])
        except BaseException:
            await self.legacy.cancel_import(session_id)
            raise
        carrier = await disk_call(self._link, material_id, session_id, kind, folder)
        # The import may have finished before the link existed; its hook found no carrier.
        await self._guarded(material_id, lambda: self._reconcile_import(carrier))
        return await self.view(material_id)

    async def add_video_link(self, url: str, folder_id: str | None, title: str | None, *,
                             language: str | None = None, translate: bool = False,
                             avoid_title: str | None = None) -> SpeechView:
        """A video link added as material (``POST /kb/materials/link``): checked, then imported.

        The video's details are read first, so a playlist, a private, 18+ or live
        video is refused with its reason before anything is created.
        ``avoid_title``: the article added from the same page (mode ``both``) —
        the video then gets its own name instead of colliding with it.
        """
        try:
            link = classify_video_link(url)
        except UnsupportedMedia as error:
            raise SpeechInvalid(str(error)) from error
        try:
            metadata = await self.legacy.video_metadata(link.url)
        except IMPORT_INVALID as error:
            raise SpeechInvalid(str(error)) from error
        chosen = (title or "").strip() or str(metadata["title"])
        if avoid_title is not None and name_key(chosen) == name_key(avoid_title):
            chosen = f"{chosen[:190]} (video)"
        return await self.start_import(ImportInput(url=link.url, folder_id=folder_id, title=chosen,
                                                   translate=translate, language=language,
                                                   metadata=metadata))

    async def _import(self, material_id: str) -> Carrier:
        carrier = await disk_call(self.carriers.get, material_id)
        if carrier is None or not carrier.is_import:
            raise NotFound("This material is not an import.")
        return carrier

    async def active_imports(self) -> list[SpeechView]:
        views = []
        for carrier in await disk_call(self.carriers.list_all, kinds=IMPORT_KINDS):
            status = await disk_call(self.legacy.import_status, carrier.session_id)
            if status is not None and status.state not in ("completed", "cancelled"):
                with contextlib.suppress(NotFound):
                    views.append(await self.view(carrier.material_id))
        return views

    async def cancel_import(self, material_id: str) -> SpeechView:
        """Cancels this import only; other imports and recordings are untouched."""
        carrier = await self._import(material_id)
        try:
            await self.legacy.cancel_import(carrier.session_id)
        except IMPORT_CONFLICT as error:
            raise SpeechConflict(str(error)) from error
        await self._guarded(material_id, lambda: self._reconcile_import(carrier))
        return await self.view(material_id)

    async def discard_failed_import(self, material_id: str) -> None:
        """Remove an import that failed before any text arrived (``link_failed`` → Delete).

        Only such a material: it has no fragments, so nothing in the wiki can cite
        it. Anything else is deleted through the general material deletion (W2).
        """
        carrier = await self._import(material_id)
        status = await disk_call(self.legacy.import_status, carrier.session_id)
        if status is not None and status.state in ("running", "completed"):
            raise SpeechConflict("Only an import that failed can be deleted here.")
        record = await disk_call(self.kb.material_repo.get, material_id)
        if record is None:
            raise NotFound("Material not found.")
        if record.fragment_count:
            raise SpeechConflict("This material already has text. Delete it from the material page.")
        if status is not None:
            await self.legacy.delete_session(carrier.session_id)
        async with self._lock(material_id):
            await disk_call(self._remove_material, material_id, record.rel_dir)

    def _remove_material(self, material_id: str, rel_dir: str) -> None:
        library = self.kb.require()
        directory = library.locate_material(material_id, hint=rel_dir)
        area = library.root / STAGING_PATH
        area.mkdir(parents=True, exist_ok=True)
        doomed = area / f"delete-{uuid.uuid4().hex}"
        os.rename(directory, doomed)
        shutil.rmtree(doomed, ignore_errors=True)
        with self.kb.db.write() as connection:
            connection.execute("DELETE FROM fragments_fts WHERE material_id = ?", (material_id,))
            connection.execute("DELETE FROM materials WHERE id = ?", (material_id,))
        self.carriers.remove(material_id)
        with self._map_lock:
            if self._by_session is not None:
                self._by_session = {key: value for key, value in self._by_session.items()
                                    if value != material_id}

    async def retry_import(self, material_id: str) -> SpeechView:
        carrier = await self._import(material_id)
        try:
            await self.legacy.retry_import(carrier.session_id)
        except IMPORT_CONFLICT as error:
            raise SpeechConflict(str(error)) from error
        except IMPORT_INVALID as error:
            raise SpeechInvalid(str(error)) from error
        self._emit_import(carrier, None)  # a new attempt: its own failure is news again
        await self._guarded(material_id, lambda: self._reconcile_import(carrier))
        return await self.view(material_id)

    # -- reading --------------------------------------------------------------

    async def view(self, material_id: str) -> SpeechView:
        carrier = await disk_call(self.carriers.get, material_id)
        record = await disk_call(self.kb.material_repo.get, material_id)
        if carrier is None or record is None:
            raise NotFound("Material not found.")
        recording_state = import_state = import_stage = None
        if carrier.is_import:
            status = await disk_call(self.legacy.import_status, carrier.session_id)
            import_state = status.state if status else "cancelled"
            import_stage = status.stage if status else "cancelled"
        else:
            recording_state = await disk_call(self.legacy.recording_state, carrier.session_id)
        return SpeechView(
            material_id=material_id, session_id=carrier.session_id, kind=carrier.kind, title=record.title,
            folder_id=record.folder_id, status=record.status, fragment_count=record.fragment_count,
            created_at=record.created_at, recording_state=recording_state, import_state=import_state,
            import_stage=import_stage, error=carrier.attempt_error,
        )
