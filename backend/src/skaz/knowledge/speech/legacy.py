"""The speech area's bridge to the legacy recording/import code.

Recording and import engines (``live_store``, ``NativeStream``, Soniox/Whisper
gateways, ``import_service``) are proven by months of real runs and are reused
as they are: a recording or an import still runs in a technical legacy
*session*. This module creates, reads and settles those sessions for the
speech service; together with ``transcript.py`` (read-only SQL over the
legacy token tables) and ``media.py`` it is the only legacy-facing code in
``knowledge``.
"""
from __future__ import annotations

import sqlite3
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal

from ... import media_tools
from ... import repository as repo
from ...gateways import ProviderNotConfigured
from ...import_service import ImportRejected, ImportRequest
from ...import_store import UNSETTLED, ImportConflict, ImportRecord
from ...languages import SUPPORTED_LANGUAGES
from ...media_source import InvalidMediaSource

if TYPE_CHECKING:  # pragma: no cover
    from ...runtime import Runtime

RecordingState = Literal["recording", "processing", "paused", "stopped"]
ImportState = Literal["running", "completed", "failed", "interrupted", "cancelled"]
#: Refusals of an import start that are the request's fault (HTTP 400 in the legacy route).
IMPORT_INVALID: tuple[type[Exception], ...] = (ImportRejected, InvalidMediaSource, media_tools.MediaError,
                                               OSError)
#: Refusals that are a state conflict (HTTP 409 in the legacy route).
IMPORT_CONFLICT: tuple[type[Exception], ...] = (ImportConflict, ProviderNotConfigured)
SPOKEN_LANGUAGES = frozenset(SUPPORTED_LANGUAGES)


@dataclass(frozen=True)
class ImportStatus:
    state: ImportState
    #: The legacy step (``queued``, ``downloading``, ``processing``, …) or the settled state.
    stage: str
    error: str | None


class LegacySpeech:
    def __init__(self, runtime: Runtime) -> None:
        self._runtime = runtime

    @contextmanager
    def read(self) -> Iterator[sqlite3.Connection]:
        with self._runtime.db.read() as connection:
            yield connection

    def add_listeners(self, *, on_event: Callable[[str], None], on_import: Callable[[str], None]) -> None:
        self._runtime.live_store.add_listener(on_event)
        self._runtime.imports.add_listener(on_import)

    # -- sessions -----------------------------------------------------------

    def create_recording_session(self, title: str) -> str:
        """The same path ``POST /sessions`` uses (managed storage decides where it lives)."""
        return self._runtime.storage.create(title, "legacy").id

    def create_import_session(self, title: str) -> str:
        """The same call the legacy ``POST /imports`` route makes."""
        return repo.create_session(self._runtime.db, title).id

    async def delete_session(self, session_id: str) -> None:
        """The legacy deletion path (stops capture/imports, removes files and rows)."""
        from ...routes.sessions import delete_session

        await delete_session(session_id, self._runtime)

    def session_status(self, session_id: str) -> str | None:
        session = repo.get_session(self._runtime.db, session_id)
        return session.status if session else None

    def mark_session(self, session_id: str, status: Literal["paused", "stopped"]) -> None:
        repo.update_session(self._runtime.db, session_id, status=status)

    # -- recordings ---------------------------------------------------------

    def recording_state(self, session_id: str) -> RecordingState | None:
        """What the recorder does now; ``None`` when the session is gone."""
        stream = self._runtime.native_streams.get(session_id)
        if stream is not None and stream.processing:
            return "processing"
        if session_id in self._runtime.native_tasks:
            return "recording"
        status = self.session_status(session_id)
        if status is None:
            return None
        # ``recording`` without a live task was interrupted: it continues like a pause.
        return "paused" if status in ("paused", "recording") else "stopped"

    # -- imports ------------------------------------------------------------

    async def start_import(self, request: ImportRequest) -> ImportRecord:
        return await self._runtime.imports.start(request)

    async def cancel_import(self, session_id: str) -> ImportRecord:
        """Like ``POST /imports/{id}/cancel``: a cancelled import's session is deleted."""
        record = await self._runtime.imports.cancel(session_id)
        if record.status == "cancelled":
            await self.delete_session(session_id)
        return record

    async def retry_import(self, session_id: str) -> ImportRecord:
        return await self._runtime.imports.retry(session_id)

    def import_status(self, session_id: str) -> ImportStatus | None:
        record = self._runtime.imports.store.get(session_id)
        if record is None:
            return None
        if record.status in UNSETTLED:
            return ImportStatus("running", record.status, None)
        state: ImportState = record.status  # type: ignore[assignment]
        return ImportStatus(state, record.status, record.error)

    def import_running(self, session_id: str) -> bool:
        status = self.import_status(session_id)
        return status is not None and status.state == "running"

    async def video_metadata(self, url: str) -> dict[str, Any]:
        return await media_tools.youtube_metadata(url)
