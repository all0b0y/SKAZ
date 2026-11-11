"""0.4.0 science routes. Unwired services answer 503 not_ready."""

from __future__ import annotations

from collections.abc import Awaitable
from typing import Annotated, TypeVar, cast

from fastapi import APIRouter, Depends, Path, Query, Request

from ..science.errors import stop_failure
from ..science.protocols import ScienceService, ScienceStop
from .contract_routes import ERROR_RESPONSES, ContractRoute, service_for
from .schemas_science import (
    KbOpenAlexKeyUpdate,
    KbScienceJournal,
    KbScienceResults,
    KbScienceSearch,
    KbScienceSettings,
    KbScienceSettingsUpdate,
    KbScienceText,
    KbScienceWork,
)

T = TypeVar("T")

router = APIRouter(prefix="/kb", tags=["kb-science"], route_class=ContractRoute, responses=ERROR_RESPONSES)


def get_service(request: Request) -> ScienceService:
    return cast(ScienceService, service_for(request, "science"))


ServiceDep = Annotated[ScienceService, Depends(get_service)]
EntityPath = Annotated[str, Path(min_length=1, max_length=128, pattern=r"^[a-zA-Z0-9_-]+$")]


async def _honest(call: Awaitable[T]) -> T:
    """A science stop becomes its contract code: 403 consent, 429 the OpenAlex day limit, else 502."""
    try:
        return await call
    except ScienceStop as stop:
        raise stop_failure(stop) from stop


@router.get("/settings/science", response_model=KbScienceSettings)
async def settings(service: ServiceDep) -> KbScienceSettings:
    return await service.settings()


@router.put("/settings/science", response_model=KbScienceSettings)
async def update_settings(body: KbScienceSettingsUpdate, service: ServiceDep) -> KbScienceSettings:
    return await service.update_settings(body)


@router.put("/settings/science/openalex-key", response_model=KbScienceSettings)
async def set_key(body: KbOpenAlexKeyUpdate, service: ServiceDep) -> KbScienceSettings:
    return await service.set_key(body)


@router.post("/science/search", response_model=KbScienceResults)
async def search(body: KbScienceSearch, service: ServiceDep) -> KbScienceResults:
    return await _honest(service.search(body))


@router.get("/science/works/{work_id}", response_model=KbScienceWork)
async def work(work_id: EntityPath, service: ServiceDep) -> KbScienceWork:
    return await _honest(service.work(work_id))


@router.post("/science/works/{work_id}/text", response_model=KbScienceText)
async def read_text(work_id: EntityPath, service: ServiceDep) -> KbScienceText:
    return await _honest(service.read_text(work_id))


@router.get("/science/journal", response_model=KbScienceJournal)
async def journal(
    service: ServiceDep, cursor: str | None = None, limit: Annotated[int, Query(ge=1, le=100)] = 50
) -> KbScienceJournal:
    return await service.journal(cursor=cursor, limit=limit)


@router.post("/settings/science/full-text-hint/dismiss", response_model=KbScienceSettings)
async def dismiss_hint(service: ServiceDep) -> KbScienceSettings:
    return await service.dismiss_hint()
