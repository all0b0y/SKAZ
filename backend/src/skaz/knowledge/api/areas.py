"""0.4.0 areas routes. Unwired services answer 503 not_ready."""

from __future__ import annotations

from typing import Annotated, cast

from fastapi import APIRouter, Depends, Path, Query, Request

from ..areas.protocols import AreasService
from .contract_routes import ERROR_RESPONSES, ContractRoute, service_for
from .schemas_areas import (
    KbArea,
    KbAreaCreate,
    KbAreaMap,
    KbAreaMaterials,
    KbAreaUpdate,
    KbReadMark,
    KbReadMarkUpdate,
    KbSignals,
)
from .schemas_explore_common import KbAcknowledged

router = APIRouter(prefix="/kb", tags=["kb-areas"], route_class=ContractRoute, responses=ERROR_RESPONSES)


def get_service(request: Request) -> AreasService:
    return cast(AreasService, service_for(request, "areas"))


ServiceDep = Annotated[AreasService, Depends(get_service)]
EntityPath = Annotated[str, Path(min_length=1, max_length=128, pattern=r"^[a-zA-Z0-9_-]+$")]


@router.get("/explore/map", response_model=KbAreaMap)
async def map(service: ServiceDep, parent_id: str | None = None, include_hidden: bool = False) -> KbAreaMap:
    return await service.map(parent_id=parent_id, include_hidden=include_hidden)


@router.post("/explore/areas", response_model=KbArea)
async def create(body: KbAreaCreate, service: ServiceDep) -> KbArea:
    return await service.create(body)


@router.patch("/explore/areas/{area_id}", response_model=KbArea)
async def update(area_id: EntityPath, body: KbAreaUpdate, service: ServiceDep) -> KbArea:
    return await service.update(area_id, body)


@router.delete("/explore/areas/{area_id}", response_model=KbAcknowledged)
async def delete(area_id: EntityPath, service: ServiceDep) -> KbAcknowledged:
    return await service.delete(area_id)


@router.post("/explore/areas/{area_id}/opened", response_model=KbAcknowledged)
async def opened(area_id: EntityPath, service: ServiceDep) -> KbAcknowledged:
    return await service.opened(area_id)


@router.get("/explore/areas/{area_id}/materials", response_model=KbAreaMaterials)
async def materials(
    area_id: EntityPath,
    service: ServiceDep,
    cursor: str | None = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 30,
) -> KbAreaMaterials:
    return await service.materials(area_id, cursor=cursor, limit=limit)


@router.get("/materials/{material_id}/read-mark", response_model=KbReadMark)
async def read_mark(material_id: EntityPath, service: ServiceDep) -> KbReadMark:
    return await service.read_mark(material_id)


@router.put("/materials/{material_id}/read-mark", response_model=KbReadMark)
async def set_read_mark(material_id: EntityPath, body: KbReadMarkUpdate, service: ServiceDep) -> KbReadMark:
    return await service.set_read_mark(material_id, body)


@router.delete("/materials/{material_id}/read-mark", response_model=KbReadMark)
async def remove_read_mark(material_id: EntityPath, service: ServiceDep) -> KbReadMark:
    return await service.remove_read_mark(material_id)


@router.put("/explore/findings/{finding_id}/read-mark", response_model=KbReadMark)
async def set_finding_mark(finding_id: EntityPath, body: KbReadMarkUpdate, service: ServiceDep) -> KbReadMark:
    return await service.set_finding_mark(finding_id, body)


@router.delete("/explore/findings/{finding_id}/read-mark", response_model=KbReadMark)
async def remove_finding_mark(finding_id: EntityPath, service: ServiceDep) -> KbReadMark:
    return await service.remove_finding_mark(finding_id)


@router.get("/explore/signals", response_model=KbSignals)
async def signals(
    service: ServiceDep, cursor: str | None = None, limit: Annotated[int, Query(ge=1, le=100)] = 50
) -> KbSignals:
    return await service.signals(cursor=cursor, limit=limit)
