"""Proactive assistant cards for one session (issue #10)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field, StrictBool

from .. import repository as repo
from ..native_io import disk_call
from ..proactive import ProactiveUnavailable
from .deps import RuntimeDep

router = APIRouter(prefix="/sessions")


class SessionSwitch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: StrictBool


class WebLookupRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    query: str = Field(min_length=1, max_length=400)


async def _origin(runtime: RuntimeDep, session_id: str) -> str:
    session = await disk_call(repo.get_session, runtime.db, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail=f"Session '{session_id}' does not exist.")
    return session.origin


@router.get("/{session_id}/proactive")
async def read_cards(session_id: str, runtime: RuntimeDep) -> dict[str, Any]:
    origin = await _origin(runtime, session_id)
    settings = await disk_call(runtime.settings_store.load)
    return runtime.proactive.view(session_id, settings, origin=origin)


@router.put("/{session_id}/proactive")
async def switch_session(session_id: str, payload: SessionSwitch, runtime: RuntimeDep) -> dict[str, Any]:
    """Turn the proactive assistant off (or back on) for this session only.

    Off stops every automatic model call for the session at once, including one
    that is already running; the cards already shown stay readable.
    """
    origin = await _origin(runtime, session_id)
    await runtime.proactive.set_session_enabled(session_id, payload.enabled)
    if payload.enabled:
        runtime.proactive.notify(session_id)
    settings = await disk_call(runtime.settings_store.load)
    return runtime.proactive.view(session_id, settings, origin=origin)


@router.post("/{session_id}/proactive/cards/{card_id}/web")
async def web_lookup(
    session_id: str, card_id: str, payload: WebLookupRequest, runtime: RuntimeDep,
) -> dict[str, Any]:
    """Prepare a web lookup for a card. The exact query still needs approval."""
    origin = await _origin(runtime, session_id)
    try:
        await runtime.proactive.request_web(session_id, card_id, payload.query)
    except ProactiveUnavailable as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    settings = await disk_call(runtime.settings_store.load)
    return runtime.proactive.view(session_id, settings, origin=origin)
