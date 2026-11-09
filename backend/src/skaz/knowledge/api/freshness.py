"""0.4.0 freshness routes. Unwired services answer 503 not_ready."""

from __future__ import annotations

from typing import Annotated, cast

from fastapi import APIRouter, Depends, Path, Request

from ..freshness.protocols import FreshnessService
from .contract_routes import ERROR_RESPONSES, ContractRoute, service_for
from .schemas_explore_common import KbContinue
from .schemas_freshness import (
    KbDatedMaterials,
    KbLibraryDateQuery,
    KbLinkCheck,
    KbLinkCheckStart,
    KbMaterialPublication,
)

router = APIRouter(prefix="/kb", tags=["kb-freshness"], route_class=ContractRoute, responses=ERROR_RESPONSES)


def get_service(request: Request) -> FreshnessService:
    return cast(FreshnessService, service_for(request, "freshness"))


ServiceDep = Annotated[FreshnessService, Depends(get_service)]
EntityPath = Annotated[str, Path(min_length=1, max_length=128, pattern=r"^[a-zA-Z0-9_-]+$")]


@router.get("/materials/{material_id}/publication", response_model=KbMaterialPublication)
async def publication(material_id: EntityPath, service: ServiceDep) -> KbMaterialPublication:
    return await service.publication(material_id)


@router.post("/materials/by-publication", response_model=KbDatedMaterials)
async def filter_dates(body: KbLibraryDateQuery, service: ServiceDep) -> KbDatedMaterials:
    return await service.filter_dates(body)


@router.post("/freshness/link-checks", response_model=KbLinkCheck)
async def check_links(body: KbLinkCheckStart, service: ServiceDep) -> KbLinkCheck:
    return await service.check_links(body)


@router.get("/freshness/link-checks/{check_id}", response_model=KbLinkCheck)
async def link_check(check_id: EntityPath, service: ServiceDep) -> KbLinkCheck:
    return await service.link_check(check_id)


@router.post("/freshness/link-checks/{check_id}/pause", response_model=KbLinkCheck)
async def pause(check_id: EntityPath, service: ServiceDep) -> KbLinkCheck:
    return await service.pause(check_id)


@router.post("/freshness/link-checks/{check_id}/continue", response_model=KbLinkCheck)
async def resume(check_id: EntityPath, body: KbContinue, service: ServiceDep) -> KbLinkCheck:
    return await service.resume(check_id, body)
