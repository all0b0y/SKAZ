"""0.4.0 maintenance routes. Unwired services answer 503 not_ready."""

from __future__ import annotations

from typing import Annotated, cast

from fastapi import APIRouter, Depends, Path, Request

from ..maintenance.protocols import MaintenanceService
from .contract_routes import ERROR_RESPONSES, ContractRoute, service_for
from .schemas_explore_common import KbContinue
from .schemas_maintenance import (
    KbFreshnessAction,
    KbFreshnessActionResult,
    KbFreshnessMarks,
    KbWeeklyCheck,
    KbWeeklySettings,
    KbWeeklySettingsUpdate,
)

router = APIRouter(
    prefix="/kb", tags=["kb-maintenance"], route_class=ContractRoute, responses=ERROR_RESPONSES
)


def get_service(request: Request) -> MaintenanceService:
    return cast(MaintenanceService, service_for(request, "maintenance"))


ServiceDep = Annotated[MaintenanceService, Depends(get_service)]
EntityPath = Annotated[str, Path(min_length=1, max_length=128, pattern=r"^[a-zA-Z0-9_-]+$")]


@router.get("/settings/weekly-check", response_model=KbWeeklySettings)
async def settings(service: ServiceDep) -> KbWeeklySettings:
    return await service.settings()


@router.put("/settings/weekly-check", response_model=KbWeeklySettings)
async def update_settings(body: KbWeeklySettingsUpdate, service: ServiceDep) -> KbWeeklySettings:
    return await service.update_settings(body)


@router.post("/freshness/weekly-checks", response_model=KbWeeklyCheck)
async def start(service: ServiceDep) -> KbWeeklyCheck:
    return await service.start()


@router.get("/freshness/weekly-checks/{check_id}", response_model=KbWeeklyCheck)
async def check(check_id: EntityPath, service: ServiceDep) -> KbWeeklyCheck:
    return await service.check(check_id)


@router.post("/freshness/weekly-checks/{check_id}/pause", response_model=KbWeeklyCheck)
async def pause(check_id: EntityPath, service: ServiceDep) -> KbWeeklyCheck:
    return await service.pause(check_id)


@router.post("/freshness/weekly-checks/{check_id}/continue", response_model=KbWeeklyCheck)
async def resume(check_id: EntityPath, body: KbContinue, service: ServiceDep) -> KbWeeklyCheck:
    return await service.resume(check_id, body)


@router.get("/materials/{material_id}/freshness", response_model=KbFreshnessMarks)
async def marks(material_id: EntityPath, service: ServiceDep) -> KbFreshnessMarks:
    return await service.marks(material_id)


@router.get("/wiki/pages/{page_id}/freshness", response_model=KbFreshnessMarks)
async def page_marks(page_id: EntityPath, service: ServiceDep) -> KbFreshnessMarks:
    return await service.page_marks(page_id)


@router.post("/freshness/marks/{mark_id}/act", response_model=KbFreshnessActionResult)
async def act(mark_id: EntityPath, body: KbFreshnessAction, service: ServiceDep) -> KbFreshnessActionResult:
    return await service.act(mark_id, body)
