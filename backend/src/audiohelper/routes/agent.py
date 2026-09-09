"""Questions about the recording and session notes."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from .. import repository as repo
from ..agent import ask as ask_service
from ..agent import notes as notes_service
from ..gateways import ProviderError, ProviderNotConfigured
from ..gateways.chat import ProviderTimeout
from ..schemas import AskRequest, AskResponse, Note, NotesRequest
from .deps import RuntimeDep

router = APIRouter(prefix="/sessions")


def _require_session(runtime: RuntimeDep, session_id: str) -> None:
    if repo.get_session(runtime.db, session_id) is None:
        raise HTTPException(status_code=404, detail=f"Session '{session_id}' does not exist.")


def _provider_failure(error: Exception) -> HTTPException:
    if isinstance(error, ProviderTimeout):
        return HTTPException(status_code=504, detail=str(error))
    if isinstance(error, ProviderNotConfigured):
        return HTTPException(status_code=400, detail=str(error))
    return HTTPException(status_code=502, detail=str(error))


@router.post("/{session_id}/ask")
async def ask(session_id: str, payload: AskRequest, runtime: RuntimeDep) -> AskResponse:
    _require_session(runtime, session_id)
    if not payload.question.strip():
        raise HTTPException(status_code=422, detail="question must not be empty.")
    try:
        return await ask_service.answer(runtime, session_id, payload)
    except (ProviderNotConfigured, ProviderError) as error:
        raise _provider_failure(error) from error


@router.post("/{session_id}/notes")
async def write_notes(session_id: str, payload: NotesRequest, runtime: RuntimeDep) -> Note:
    _require_session(runtime, session_id)
    try:
        return await notes_service.write(runtime, session_id, payload.language)
    except notes_service.NothingToSummarise as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except (ProviderNotConfigured, ProviderError) as error:
        raise _provider_failure(error) from error
