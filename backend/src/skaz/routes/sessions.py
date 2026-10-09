"""Session lifecycle and transient ASR input. Audio is never archived."""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING, Any

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse, Response

from .. import note_store, transcript_monologues
from .. import repository as repo
from ..asr_providers import provider_of_model
from ..audio import InvalidAudio
from ..gateways import ProviderError, ProviderNotConfigured
from ..ingestion import ChunkConflict, QueueFull
from ..live_asr import LiveDraftBusy, LiveDraftConflict, LiveDraftMissing, LiveDraftTooLarge
from ..live_fragments import LiveFragmentConflict, LiveFragmentMissing
from ..live_scheduler import LiveSchedulerBusy, LiveSchedulerConflict, LiveSchedulerUnavailable
from ..live_store import LiveConflict
from ..native_event_pages import EventCursorConflict, EventPageTooLarge, read_event_page
from ..native_io import disk_call, drain_on_cancel
from ..native_page_projection import read_projected_page
from ..schemas import (
    AcceptLiveAsrFragmentRequest,
    AsrPreviewRequest,
    AsrPreviewResponse,
    AudioResponse,
    BufferedAudioResponse,
    BulkDeleteFailure,
    BulkDeleteSessionsRequest,
    BulkDeleteSessionsResponse,
    CreateSessionRequest,
    DeleteResponse,
    EditLiveAsrFragmentRequest,
    LiveAsrAdvanceRequest,
    LiveAsrAdvanceResponse,
    LiveAsrDraftResponse,
    LiveAsrFragment,
    LiveAsrFragmentsResponse,
    LiveAsrSchedulerStatus,
    LiveAsrUpdateRequest,
    PatchSessionRequest,
    Session,
    SessionDetail,
    SessionsResponse,
)
from ..session_files import FileDeletionBlocked
from ..window_asr import (
    PreviewBusy,
    PreviewDecodeFailed,
    PreviewSourceConflict,
    PreviewSourceMissing,
    PreviewStale,
    PreviewTooLarge,
)
from .deps import RuntimeDep

if TYPE_CHECKING:
    from ..runtime import Runtime

router = APIRouter(prefix="/sessions")
logger = logging.getLogger(__name__)


@router.get("/{session_id}/live/events")
async def read_native_events(
    session_id: str, runtime: RuntimeDep,
    connection_id: str | None = Query(default=None, min_length=1, max_length=128),
    after: int | None = Query(default=None, ge=-1),
    before: int | None = Query(default=None, ge=0),
    limit: int = Query(default=64, ge=1, le=128),
    project: bool = False,
    segment_id: str | None = Query(default=None, min_length=1, max_length=128),
) -> dict[str, Any]:
    if after is not None and before is not None:
        raise HTTPException(status_code=422, detail="Use either after or before, not both.")
    if connection_id is None and (after is not None or before is not None):
        raise HTTPException(status_code=422, detail="A cursor requires its connection_id epoch.")
    if segment_id is not None and (
        not project or connection_id is not None or after is not None or before is not None
    ):
        raise HTTPException(status_code=422, detail="A source locator requires project=true and no cursor.")
    try:
        if project:
            page = await disk_call(
                read_projected_page,
                runtime.db,
                session_id,
                connection_id=connection_id,
                after=after,
                before=before,
                limit=limit,
                **({"segment_id": segment_id} if segment_id else {}),
            )
        else:
            page = await disk_call(
                read_event_page,
                runtime.db,
                session_id,
                connection_id=connection_id,
                after=after,
                before=before,
                limit=limit,
            )
        stream = runtime.native_streams.get(session_id)
        page["transcription"] = stream.state if stream is not None else "inactive"
        return page
    except LiveConflict as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except EventCursorConflict as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except EventPageTooLarge as error:
        raise HTTPException(status_code=413, detail=str(error)) from error


@router.get("/{session_id}/live/status")
async def read_native_status(session_id: str, runtime: RuntimeDep) -> dict[str, Any]:
    await disk_call(_require_session, runtime, session_id)
    stream = runtime.native_streams.get(session_id)
    return {
        "state": stream.state if stream is not None else "inactive",
        "attempt": stream.recovery.attempt if stream is not None else 0,
        "max_attempts": 3,
        "processing": bool(stream and stream.processing),
        "background_sessions": [sid for sid, worker in runtime.native_streams.items() if worker.processing],
        "incomplete": await disk_call(runtime.live_store.last_incomplete, session_id),
        "buffered_audio_ms": (stream.buffer.size_bytes * 500 // stream.connection.sample_rate
                              if stream is not None else 0),
    }


@router.get("/{session_id}/live")
async def read_native_live(session_id: str, runtime: RuntimeDep) -> dict[str, Any]:
    await disk_call(_require_session, runtime, session_id)
    try:
        snapshot = await disk_call(runtime.live_store.snapshot, session_id)
        stream = runtime.native_streams.get(session_id)
        snapshot["transcription"] = stream.state if stream is not None else "inactive"
        snapshot["processing"] = bool(stream and stream.processing)
        _describe_provider(snapshot, stream)
        return _live_view(snapshot)
    except LiveConflict as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


# Derived views the live client never reads. They are recomputed on every poll
# and dominated the response: at minute 60 of a real recording
# `final_stream_tokens` alone was 10.5 MiB of a 34.5 MiB payload, and the whole
# translation half is dead weight in a transcription recording
# (docs/BASELINE-PROFILE.md). The durable tables and LiveStore.snapshot() keep
# producing them for diagnostics and replay checks; only this per-second
# response drops them.
_LIVE_INTERNAL_FIELDS = (
    "final_stream_tokens", "final_translation_projection", "partial_stream_tokens",
)
_LIVE_TRANSLATION_FIELDS = (
    "live_translation_projection", "final_translation_tokens", "partial_translation_tokens",
)


def _describe_provider(snapshot: dict[str, Any], stream: Any) -> None:
    """Which provider transcribes (or last transcribed) this recording, and why it cannot."""
    connections = snapshot.get("connections") or []
    last_model = connections[-1].get("model") if connections else None
    provider = (stream.provider if stream is not None else None) or provider_of_model(last_model)
    snapshot["transcription_provider"] = provider
    if stream is not None and stream.state == "unavailable" and stream.failure_reason:
        snapshot["transcription_detail"] = stream.failure_reason


def _live_view(snapshot: dict[str, Any]) -> dict[str, Any]:
    """Trim the live response to what a client actually renders."""
    view = {key: value for key, value in snapshot.items() if key not in _LIVE_INTERNAL_FIELDS}
    if view.get("recording_mode") == "translation":
        # Translation UI reads the projection; the flat original list is the
        # same tokens a second time.
        view.pop("final_tokens", None)
    else:
        for field in _LIVE_TRANSLATION_FIELDS:
            view.pop(field, None)
    return view


def _live_response(payload: LiveAsrDraftResponse) -> JSONResponse:
    body = payload.model_dump(mode="json", exclude_none=True)
    if payload.draft is None:
        body["draft"] = None
    return JSONResponse(content=body)


def _require_session(runtime: RuntimeDep, session_id: str) -> Session:
    session = repo.get_session(runtime.db, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail=f"Session '{session_id}' does not exist.")
    return session


async def _read_audio_body(
    request: Request, runtime: RuntimeDep, *, start_ms: int, end_ms: int
) -> bytes:
    if end_ms <= start_ms:
        raise HTTPException(status_code=422, detail="end_ms must be greater than start_ms.")
    maximum = runtime.config.max_chunk_bytes
    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            if int(content_length) > maximum:
                raise HTTPException(
                    status_code=413, detail="Audio chunk is larger than the accepted limit."
                )
        except ValueError:
            pass

    body = bytearray()
    async for part in request.stream():
        if len(body) + len(part) > maximum:
            raise HTTPException(
                status_code=413, detail="Audio chunk is larger than the accepted limit."
            )
        body.extend(part)
    return bytes(body)


@router.get("")
def list_sessions(runtime: RuntimeDep) -> SessionsResponse:
    return SessionsResponse(sessions=repo.list_sessions(runtime.db))


@router.post("")
def create_session(payload: CreateSessionRequest, runtime: RuntimeDep) -> Session:
    return runtime.storage.create(payload.title.strip() or "Untitled session", payload.mode)


@router.get("/{session_id}/files")
def session_files_status(session_id: str, runtime: RuntimeDep) -> dict[str, Any]:
    _require_session(runtime, session_id)
    return runtime.session_files.status(session_id)


@router.post("/{session_id}/files")
def project_session_files(session_id: str, runtime: RuntimeDep) -> dict[str, Any]:
    _require_session(runtime, session_id)
    return runtime.session_files.project(session_id)


@router.post("/{session_id}/files/preserve")
def preserve_session_files(session_id: str, runtime: RuntimeDep) -> dict[str, Any]:
    _require_session(runtime, session_id)
    try:
        return runtime.session_files.preserve(session_id)
    except FileDeletionBlocked as error:
        raise HTTPException(status_code=409, detail="File preservation needs attention.") from error


def _guard_contextual_writer(runtime: RuntimeDep, session: Session) -> None:
    # Empty legacy sessions remain available to the explicit backend-only live
    # API for its established tests/diagnostics. Persisted provenance, not the
    # immutable compatibility mode, decides whether an opposite writer owns finals.
    try:
        repo.assert_final_writer_available(runtime.db, session.id, "contextual")
    except repo.FinalWriterConflict as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@router.get("/{session_id}")
def read_session(session_id: str, runtime: RuntimeDep, native_window: bool = False) -> SessionDetail:
    session = _require_session(runtime, session_id)
    with runtime.db.read() as connection:
        native = native_window and connection.execute(
            "SELECT 1 FROM native_recordings WHERE session_id=?", (session_id,),
        ).fetchone() is not None
        has_transcript = transcript_monologues.has_transcript(connection, session_id)
    return SessionDetail(
        has_transcript=has_transcript,
        session=session,
        segments=[] if native else repo.list_segments(runtime.db, session_id),
        messages=repo.list_messages(runtime.db, session_id),
        notes=repo.latest_note(runtime.db, session_id),
        notes_list=note_store.list_notes(runtime.db, session_id),
    )


@router.post("/{session_id}/asr/preview")
async def preview_asr(
    session_id: str, payload: AsrPreviewRequest, runtime: RuntimeDep
) -> AsrPreviewResponse:
    try:
        return await runtime.window_asr.preview(
            session_id, payload.first_sequence, payload.last_sequence
        )
    except PreviewSourceMissing as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except PreviewSourceConflict as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except PreviewTooLarge as error:
        raise HTTPException(status_code=413, detail=str(error)) from error
    except PreviewBusy as error:
        raise HTTPException(status_code=429, detail=str(error)) from error
    except PreviewStale as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except ProviderNotConfigured as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except (ProviderError, PreviewDecodeFailed) as error:
        raise HTTPException(status_code=502, detail=str(error)) from error


@router.get("/{session_id}/asr/live")
async def read_live_asr(session_id: str, runtime: RuntimeDep) -> JSONResponse:
    _require_session(runtime, session_id)
    try:
        return _live_response(runtime.live_asr.read(session_id))
    except PreviewSourceMissing as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except (PreviewSourceConflict, PreviewStale, LiveDraftConflict) as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except PreviewTooLarge as error:
        raise HTTPException(status_code=413, detail=str(error)) from error
    except ProviderNotConfigured as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@router.get(
    "/{session_id}/asr/fragments",
    response_model=LiveAsrFragmentsResponse,
)
async def read_live_asr_fragments(
    session_id: str, runtime: RuntimeDep
) -> LiveAsrFragmentsResponse:
    _require_session(runtime, session_id)
    return runtime.live_fragments.read(session_id)


@router.put(
    "/{session_id}/asr/fragments/{fragment_id}/text",
    response_model=LiveAsrFragment,
)
async def edit_live_asr_fragment(
    session_id: str,
    fragment_id: str,
    payload: EditLiveAsrFragmentRequest,
    runtime: RuntimeDep,
) -> LiveAsrFragment:
    session = _require_session(runtime, session_id)
    _guard_contextual_writer(runtime, session)
    try:
        return runtime.live_fragments.edit(
            session_id,
            fragment_id,
            expected_revision=payload.expected_revision,
            range_fingerprint=payload.range_fingerprint,
            text=payload.text,
        )
    except LiveFragmentMissing as error:
        raise HTTPException(status_code=404, detail="Fragment does not exist.") from error
    except LiveFragmentConflict as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@router.post(
    "/{session_id}/asr/fragments/{fragment_id}/accept",
    response_model=LiveAsrFragment,
)
async def accept_live_asr_fragment(
    session_id: str,
    fragment_id: str,
    payload: AcceptLiveAsrFragmentRequest,
    runtime: RuntimeDep,
) -> LiveAsrFragment:
    session = _require_session(runtime, session_id)
    _guard_contextual_writer(runtime, session)
    try:
        return runtime.live_fragments.accept(
            session_id,
            fragment_id,
            expected_revision=payload.expected_revision,
            range_fingerprint=payload.range_fingerprint,
            idempotency_key=payload.idempotency_key,
        )
    except LiveFragmentMissing as error:
        raise HTTPException(status_code=404, detail="Fragment does not exist.") from error
    except LiveFragmentConflict as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@router.post("/{session_id}/asr/live/update")
async def update_live_asr(
    session_id: str, payload: LiveAsrUpdateRequest, runtime: RuntimeDep
) -> JSONResponse:
    session = _require_session(runtime, session_id)
    _guard_contextual_writer(runtime, session)
    try:
        return _live_response(
            await runtime.live_asr.update(
                session_id,
                payload.first_sequence,
                payload.last_sequence,
                payload.expected_revision,
            )
        )
    except (PreviewSourceMissing, LiveDraftMissing) as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except (PreviewSourceConflict, PreviewStale, LiveDraftConflict) as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except (PreviewTooLarge, LiveDraftTooLarge) as error:
        raise HTTPException(status_code=413, detail=str(error)) from error
    except (PreviewBusy, LiveDraftBusy) as error:
        raise HTTPException(status_code=429, detail=str(error)) from error
    except ProviderNotConfigured as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except (ProviderError, PreviewDecodeFailed) as error:
        raise HTTPException(status_code=502, detail=str(error)) from error


@router.post(
    "/{session_id}/asr/live/advance",
    response_model=LiveAsrAdvanceResponse,
    status_code=202,
)
async def advance_live_asr(
    session_id: str, payload: LiveAsrAdvanceRequest, runtime: RuntimeDep
) -> LiveAsrAdvanceResponse:
    session = _require_session(runtime, session_id)
    _guard_contextual_writer(runtime, session)
    try:
        return await runtime.live_scheduler.advance(session_id, payload.through_sequence)
    except PreviewSourceMissing as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except PreviewSourceConflict as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except PreviewTooLarge as error:
        raise HTTPException(status_code=413, detail=str(error)) from error
    except LiveSchedulerBusy as error:
        raise HTTPException(status_code=429, detail=str(error)) from error
    except LiveSchedulerConflict as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except (LiveSchedulerUnavailable, ProviderNotConfigured) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@router.get(
    "/{session_id}/asr/live/scheduler",
    response_model=LiveAsrSchedulerStatus,
)
async def read_live_asr_scheduler(
    session_id: str, runtime: RuntimeDep
) -> LiveAsrSchedulerStatus:
    _require_session(runtime, session_id)
    return runtime.live_scheduler.status(session_id)


@router.patch("/{session_id}")
async def patch_session(session_id: str, payload: PatchSessionRequest, runtime: RuntimeDep) -> Session:
    session = _require_session(runtime, session_id)
    # The legacy tail flush runs only on an actual pause/stop transition: a rename
    # (even one that resends the current status) must never touch transcription,
    # and a native recording's transcript is never the legacy writer's to finish.
    if (
        session.mode != "contextual_local"
        and payload.status in ("stopped", "paused")
        and payload.status != session.status
        and payload.flush_transcription
        and not await disk_call(repo.has_native_recording, runtime.db, session_id)
    ):
        # Stopping waits for the tail: in-flight chunks finish and failed ones are retried.
        try:
            for problem in await runtime.ingestion.flush(session_id):
                logger.warning("Flush of session %s left work undone: %s", session_id, problem)
        except repo.FinalWriterConflict as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
    updated = repo.update_session(runtime.db, session_id, status=payload.status, title=payload.title)
    if updated is None:
        raise HTTPException(status_code=404, detail=f"Session '{session_id}' does not exist.")
    if updated.mode == "contextual_local" and payload.status == "stopped":
        runtime.live_scheduler.source_ended(session_id)
    if payload.status in ("stopped", "paused"):
        if not (updated.mode == "contextual_local" and payload.status == "stopped"):
            runtime.ingestion.audio.discard(session_id)
        await disk_call(runtime.session_files.project, session_id)
    return updated


@router.delete("/{session_id}")
async def delete_session(session_id: str, runtime: RuntimeDep) -> DeleteResponse:
    await _delete_session(session_id, runtime)
    return DeleteResponse(deleted=True)


@router.post("/delete")
async def delete_sessions(
    payload: BulkDeleteSessionsRequest, runtime: RuntimeDep,
) -> BulkDeleteSessionsResponse:
    """Deletes each id through the single-session path; one failure never stops the rest."""
    deleted: list[str] = []
    failed: list[BulkDeleteFailure] = []
    for session_id in dict.fromkeys(payload.ids):
        try:
            await _delete_session(session_id, runtime)
        except HTTPException as error:
            failed.append(BulkDeleteFailure(id=session_id, reason=str(error.detail)))
        else:
            deleted.append(session_id)
    return BulkDeleteSessionsResponse(deleted=deleted, failed=failed)


async def _delete_session(session_id: str, runtime: Runtime) -> None:
    async def remove() -> None:
        await runtime.imports.prepare_delete(session_id)
        await runtime.stop_native(session_id)
        runtime.proactive.forget(session_id)
        runtime.ingestion.audio.discard(session_id)
        try:
            await disk_call(_require_session, runtime, session_id)
            try:
                if runtime.storage.enabled():
                    await disk_call(runtime.storage.delete, session_id)
                else:
                    await disk_call(runtime.session_files.delete_session, session_id)
            except FileDeletionBlocked as error:
                raise HTTPException(status_code=409, detail=(
                    "Session was not deleted: Markdown files need attention. "
                    "Preserve external/conflict/recovery files outside the session folder "
                    "and retry. If the files root changed, restore the previous root first."
                )) from error

        finally:
            runtime.native_closing.discard(session_id)

    async def guarded_remove() -> None:
        async with runtime.codex.source_change(session_id):
            await remove()

    # Concurrent callers join the same deletion, including its source revocation.
    # A later, separate request still gets the usual missing-session response.
    pending = runtime.session_deletions.get(session_id)
    if pending is None:
        pending = asyncio.create_task(guarded_remove())
        runtime.session_deletions[session_id] = pending
        pending.add_done_callback(lambda _task: runtime.session_deletions.pop(session_id, None))

    async def join() -> None:
        await asyncio.shield(pending)

    await drain_on_cancel(join())


@router.post("/{session_id}/audio")
async def upload_audio(
    session_id: str,
    request: Request,
    runtime: RuntimeDep,
    sequence: int = Query(ge=0),
    start_ms: int = Query(ge=0),
    end_ms: int = Query(ge=0),
) -> AudioResponse:
    session = _require_session(runtime, session_id)
    if session.mode == "contextual_local":
        raise HTTPException(
            status_code=409,
            detail=(
                "Contextual local sessions accept transient live audio and scheduler advance, "
                "not legacy ASR upload."
            ),
        )
    try:
        repo.assert_final_writer_available(runtime.db, session_id, "legacy")
    except repo.FinalWriterConflict as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    body = await _read_audio_body(request, runtime, start_ms=start_ms, end_ms=end_ms)
    try:
        return await runtime.ingestion.ingest(session_id, sequence, start_ms, end_ms, body)
    except InvalidAudio as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except ChunkConflict as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except repo.FinalWriterConflict as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except QueueFull as error:
        raise HTTPException(status_code=429, detail=str(error)) from error
    except ProviderNotConfigured as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except ProviderError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error
    except OSError as error:
        raise HTTPException(status_code=500, detail="Audio input receipt could not be committed.") from error


@router.post("/{session_id}/audio/buffer", status_code=201)
async def buffer_audio(
    session_id: str,
    request: Request,
    response: Response,
    runtime: RuntimeDep,
    sequence: int = Query(ge=0),
    start_ms: int = Query(ge=0),
    end_ms: int = Query(ge=0),
) -> BufferedAudioResponse:
    _require_session(runtime, session_id)
    body = await _read_audio_body(request, runtime, start_ms=start_ms, end_ms=end_ms)
    try:
        stored = await runtime.ingestion.buffer(session_id, sequence, start_ms, end_ms, body)
    except InvalidAudio as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except ChunkConflict as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except OSError as error:
        raise HTTPException(status_code=500, detail="Audio input receipt could not be committed.") from error
    if stored.duplicate:
        response.status_code = 200
    return stored
