"""0.4.0 repeats routes. Unwired services answer 503 not_ready."""

from __future__ import annotations

from typing import Annotated, cast

from fastapi import APIRouter, Depends, Path, Request

from ..repeats.protocols import RepeatsService
from .contract_routes import ERROR_RESPONSES, ContractRoute, service_for
from .schemas_explore_common import KbContinue
from .schemas_repeats import (
    KbMaterialRepeats,
    KbRepeatCheck,
    KbRepeatCheckStart,
)

router = APIRouter(prefix="/kb", tags=["kb-repeats"], route_class=ContractRoute, responses=ERROR_RESPONSES)


def get_service(request: Request) -> RepeatsService:
    return cast(RepeatsService, service_for(request, "repeats"))


ServiceDep = Annotated[RepeatsService, Depends(get_service)]
EntityPath = Annotated[str, Path(min_length=1, max_length=128, pattern=r"^[a-zA-Z0-9_-]+$")]


@router.get("/materials/{material_id}/repeats", response_model=KbMaterialRepeats)
async def material(material_id: EntityPath, service: ServiceDep) -> KbMaterialRepeats:
    return await service.material(material_id)


@router.post("/explore/repeat-checks", response_model=KbRepeatCheck)
async def start(body: KbRepeatCheckStart, service: ServiceDep) -> KbRepeatCheck:
    return await service.start(body)


@router.get("/explore/repeat-checks/{check_id}", response_model=KbRepeatCheck)
async def check(check_id: EntityPath, service: ServiceDep) -> KbRepeatCheck:
    return await service.check(check_id)


@router.post("/explore/repeat-checks/{check_id}/pause", response_model=KbRepeatCheck)
async def pause(check_id: EntityPath, service: ServiceDep) -> KbRepeatCheck:
    return await service.pause(check_id)


@router.post("/explore/repeat-checks/{check_id}/continue", response_model=KbRepeatCheck)
async def resume(check_id: EntityPath, body: KbContinue, service: ServiceDep) -> KbRepeatCheck:
    return await service.resume(check_id, body)
