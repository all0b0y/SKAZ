"""Explicit query-only search consent; authenticated local UI, not a model tool."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import Field, SecretStr

from ..codex_schemas import StrictModel
from ..native_io import disk_call
from .deps import RuntimeDep

router = APIRouter(prefix="/web-search")


class SearchSettings(StrictModel):
    enabled: bool
    api_key: SecretStr | None = None


class SearchDecision(StrictModel):
    chat_id: str = Field(min_length=1, max_length=128)
    query: str = Field(min_length=1, max_length=400)
    approved: bool


@router.get("/settings")
async def settings(runtime: RuntimeDep) -> dict[str, Any]:
    return await disk_call(runtime.web_search.view)


@router.put("/settings")
async def configure(payload: SearchSettings, runtime: RuntimeDep) -> dict[str, Any]:
    try:
        return await runtime.web_search.configure(
            enabled=payload.enabled,
            key=payload.api_key.get_secret_value() if payload.api_key is not None else None,
        )
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e)) from None
    except (OSError, RuntimeError):
        raise HTTPException(status_code=503, detail="Could not save search settings") from None


@router.get("/pending")
async def pending(runtime: RuntimeDep) -> dict[str, Any]:
    # Only pending approvals; does not start a request or publish credentials.
    return {"requests": runtime.web_search.pending()}


@router.post("/requests/{identity}/decision")
async def decide(identity: str, payload: SearchDecision, runtime: RuntimeDep) -> dict[str, bool]:
    try:
        runtime.web_search.decide(identity, payload.chat_id, payload.query, payload.approved)
        return {"accepted": True}
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e)) from None
