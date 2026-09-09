"""Session lifecycle, audio ingestion and stored-audio playback."""

from __future__ import annotations

import logging
import shutil
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import Response

from .. import repository as repo
from ..audio import InvalidAudio
from ..gateways import ProviderError, ProviderNotConfigured
from ..ingestion import ChunkConflict, QueueFull
from ..schemas import (
    AudioResponse,
    CreateSessionRequest,
    DeleteResponse,
    PatchSessionRequest,
    Session,
    SessionDetail,
    SessionsResponse,
)
from .deps import RuntimeDep

router = APIRouter(prefix="/sessions")
logger = logging.getLogger(__name__)


def _require_session(runtime: RuntimeDep, session_id: str) -> Session:
    session = repo.get_session(runtime.db, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail=f"Session '{session_id}' does not exist.")
    return session


@router.get("")
async def list_sessions(runtime: RuntimeDep) -> SessionsResponse:
    return SessionsResponse(sessions=repo.list_sessions(runtime.db))


@router.post("")
async def create_session(payload: CreateSessionRequest, runtime: RuntimeDep) -> Session:
    return repo.create_session(runtime.db, payload.title.strip() or "Untitled session")


@router.get("/{session_id}")
async def read_session(session_id: str, runtime: RuntimeDep) -> SessionDetail:
    session = _require_session(runtime, session_id)
    return SessionDetail(
        session=session,
        segments=repo.list_segments(runtime.db, session_id),
        messages=repo.list_messages(runtime.db, session_id),
        notes=repo.latest_note(runtime.db, session_id),
    )


@router.patch("/{session_id}")
async def patch_session(session_id: str, payload: PatchSessionRequest, runtime: RuntimeDep) -> Session:
    _require_session(runtime, session_id)
    if payload.status in ("stopped", "paused"):
        # Stopping waits for the tail: in-flight chunks finish and failed ones are retried.
        for problem in await runtime.ingestion.flush(session_id):
            logger.warning("Flush of session %s left work undone: %s", session_id, problem)
    updated = repo.update_session(runtime.db, session_id, status=payload.status, title=payload.title)
    if updated is None:
        raise HTTPException(status_code=404, detail=f"Session '{session_id}' does not exist.")
    return updated


@router.delete("/{session_id}")
async def delete_session(session_id: str, runtime: RuntimeDep) -> DeleteResponse:
    _require_session(runtime, session_id)
    repo.delete_session(runtime.db, session_id)
    shutil.rmtree(runtime.config.audio_dir / session_id, ignore_errors=True)
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
    _require_session(runtime, session_id)
    if end_ms <= start_ms:
        raise HTTPException(status_code=422, detail="end_ms must be greater than start_ms.")
    body = await request.body()
    if len(body) > runtime.config.max_chunk_bytes:
        raise HTTPException(status_code=413, detail="Audio chunk is larger than the accepted limit.")
    try:
        return await runtime.ingestion.ingest(session_id, sequence, start_ms, end_ms, body)
    except InvalidAudio as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except ChunkConflict as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except QueueFull as error:
        raise HTTPException(status_code=429, detail=str(error)) from error
    except ProviderNotConfigured as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except ProviderError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error


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
