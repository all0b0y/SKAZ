"""Session lifecycle, audio ingestion and stored-audio playback."""

from __future__ import annotations

import logging
import shutil
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse, Response

from .. import repository as repo
from ..audio import InvalidAudio
from ..gateways import ProviderError, ProviderNotConfigured
from ..ingestion import ChunkConflict, QueueFull
from ..live_asr import LiveDraftBusy, LiveDraftConflict, LiveDraftMissing, LiveDraftTooLarge
from ..live_fragments import LiveFragmentConflict, LiveFragmentMissing
from ..live_scheduler import LiveSchedulerBusy, LiveSchedulerConflict, LiveSchedulerUnavailable
from ..live_store import LiveConflict
from ..native_io import disk_call, drain_on_cancel
from ..schemas import (
    AsrPreviewRequest,
    AsrPreviewResponse,
    AudioManifestChunk,
    AudioManifestResponse,
    AudioResponse,
    CreateSessionRequest,
    DeleteResponse,
    EditLiveAsrFragmentRequest,
    AcceptLiveAsrFragmentRequest,
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
    StoredAudioResponse,
)
from ..window_asr import (
    PreviewBusy,
    PreviewDecodeFailed,
    PreviewSourceConflict,
    PreviewSourceMissing,
    PreviewStale,
    PreviewTooLarge,
)
from .deps import RuntimeDep

router = APIRouter(prefix="/sessions")
logger = logging.getLogger(__name__)


@router.get("/{session_id}/live")
async def read_native_live(session_id: str, runtime: RuntimeDep) -> dict[str, Any]:
    await disk_call(_require_session, runtime, session_id)
    try:
        snapshot = await disk_call(runtime.live_store.snapshot, session_id)
        stream = runtime.native_streams.get(session_id)
        snapshot["transcription"] = stream.state if stream is not None else "inactive"
        return snapshot
    except LiveConflict as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


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


def _audio_is_available(path: str) -> bool:
    try:
        return Path(path).is_file()
    except OSError:
        return False


@router.get("")
def list_sessions(runtime: RuntimeDep) -> SessionsResponse:
    return SessionsResponse(sessions=repo.list_sessions(runtime.db))


@router.post("")
def create_session(payload: CreateSessionRequest, runtime: RuntimeDep) -> Session:
    return repo.create_session(
        runtime.db, payload.title.strip() or "Untitled session", mode=payload.mode
    )


def _guard_contextual_writer(runtime: RuntimeDep, session: Session) -> None:
    # Empty legacy sessions remain available to the explicit backend-only live
    # API for its established tests/diagnostics. Persisted provenance, not the
    # immutable compatibility mode, decides whether an opposite writer owns finals.
    try:
        repo.assert_final_writer_available(runtime.db, session.id, "contextual")
    except repo.FinalWriterConflict as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@router.get("/{session_id}")
def read_session(session_id: str, runtime: RuntimeDep) -> SessionDetail:
    session = _require_session(runtime, session_id)
    return SessionDetail(
        session=session,
        segments=repo.list_segments(runtime.db, session_id),
        messages=repo.list_messages(runtime.db, session_id),
        notes=repo.latest_note(runtime.db, session_id),
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
    if (
        session.mode != "contextual_local"
        and payload.status in ("stopped", "paused")
        and payload.flush_transcription
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
    return updated


@router.delete("/{session_id}")
async def delete_session(session_id: str, runtime: RuntimeDep) -> DeleteResponse:
    async def remove() -> None:
        await runtime.stop_native(session_id)
        try:
            await disk_call(_require_session, runtime, session_id)
            await disk_call(repo.delete_session, runtime.db, session_id)
            await disk_call(shutil.rmtree, runtime.config.audio_dir / session_id, ignore_errors=True)
        finally:
            runtime.native_closing.discard(session_id)

    await drain_on_cancel(remove())
    return DeleteResponse(deleted=True)


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
                "Contextual local sessions accept persistence-only audio and scheduler advance, "
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
        raise HTTPException(status_code=500, detail="Audio could not be stored locally.") from error


@router.post("/{session_id}/audio/store", status_code=201)
async def store_audio(
    session_id: str,
    request: Request,
    response: Response,
    runtime: RuntimeDep,
    sequence: int = Query(ge=0),
    start_ms: int = Query(ge=0),
    end_ms: int = Query(ge=0),
) -> StoredAudioResponse:
    _require_session(runtime, session_id)
    body = await _read_audio_body(request, runtime, start_ms=start_ms, end_ms=end_ms)
    try:
        stored = await runtime.ingestion.store(session_id, sequence, start_ms, end_ms, body)
    except InvalidAudio as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except ChunkConflict as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except OSError as error:
        raise HTTPException(status_code=500, detail="Audio could not be stored locally.") from error
    if stored.duplicate:
        response.status_code = 200
    return stored


@router.get("/{session_id}/audio")
async def read_audio_manifest(
    session_id: str,
    runtime: RuntimeDep,
    after_sequence: int | None = Query(default=None, ge=0),
    limit: int = Query(default=100, ge=1, le=200),
) -> AudioManifestResponse:
    _require_session(runtime, session_id)
    page = repo.chunk_manifest_page(
        runtime.db, session_id, after_sequence=after_sequence, limit=limit + 1
    )
    has_more = len(page) > limit
    visible = page[:limit]
    return AudioManifestResponse(
        chunks=[
            AudioManifestChunk(
                sequence=chunk.sequence,
                start_ms=chunk.start_ms,
                end_ms=chunk.end_ms,
                status=chunk.status,
                available=_audio_is_available(chunk.path),
                segment_ids=chunk.segment_ids,
            )
            for chunk in visible
        ],
        next_after_sequence=visible[-1].sequence if has_more else None,
    )


@router.get("/{session_id}/audio/{sequence}")
async def read_audio(session_id: str, sequence: int, runtime: RuntimeDep) -> Response:
    _require_session(runtime, session_id)
    chunk = repo.get_chunk(runtime.db, session_id, sequence)
    if chunk is None:
        raise HTTPException(status_code=404, detail=f"No audio stored for sequence {sequence}.")
    path = Path(chunk.path)
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"Audio file for sequence {sequence} is missing on disk.")
    return Response(
        content=path.read_bytes(),
        media_type="audio/wav",
        headers={"Content-Disposition": f'inline; filename="{session_id}-{sequence:06d}.wav"'},
    )
