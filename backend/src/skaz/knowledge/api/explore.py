"""0.4.0 explore routes. Unwired services answer 503 not_ready."""

from __future__ import annotations

from typing import Annotated, cast

from fastapi import APIRouter, Depends, Path, Query, Request

from ..explore.protocols import ExploreService
from .contract_routes import ERROR_RESPONSES, ContractRoute, service_for
from .schemas_explore import (
    KbExploreStart,
    KbExploring,
    KbExploringList,
    KbFinding,
    KbFindingImport,
    KbFindingImported,
    KbFindings,
    KbFunnelRun,
    KbFunnelStart,
)
from .schemas_explore_common import KbContinue, KbJobs

router = APIRouter(prefix="/kb", tags=["kb-explore"], route_class=ContractRoute, responses=ERROR_RESPONSES)


def get_service(request: Request) -> ExploreService:
    return cast(ExploreService, service_for(request, "explore"))


ServiceDep = Annotated[ExploreService, Depends(get_service)]
EntityPath = Annotated[str, Path(min_length=1, max_length=128, pattern=r"^[a-zA-Z0-9_-]+$")]


@router.post("/explore/runs", response_model=KbFunnelRun)
async def start(body: KbFunnelStart, service: ServiceDep) -> KbFunnelRun:
    return await service.start(body)


@router.get("/explore/runs/{run_id}", response_model=KbFunnelRun)
async def run(run_id: EntityPath, service: ServiceDep) -> KbFunnelRun:
    return await service.run(run_id)


@router.post("/explore/runs/{run_id}/pause", response_model=KbFunnelRun)
async def pause(run_id: EntityPath, service: ServiceDep) -> KbFunnelRun:
    return await service.pause(run_id)


@router.post("/explore/runs/{run_id}/continue", response_model=KbFunnelRun)
async def resume(run_id: EntityPath, body: KbContinue, service: ServiceDep) -> KbFunnelRun:
    return await service.resume(run_id, body)


@router.post("/explore/runs/{run_id}/cancel", response_model=KbFunnelRun)
async def cancel(run_id: EntityPath, service: ServiceDep) -> KbFunnelRun:
    return await service.cancel(run_id)


@router.get("/explore/jobs", response_model=KbJobs)
async def jobs(service: ServiceDep, active: bool = True) -> KbJobs:
    return await service.jobs(active=active)


@router.get("/explore/findings", response_model=KbFindings)
async def findings(
    service: ServiceDep,
    area_id: str | None = None,
    task_id: str | None = None,
    include_covered: bool = False,
    cursor: str | None = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 30,
) -> KbFindings:
    return await service.findings(
        area_id=area_id, task_id=task_id, include_covered=include_covered, cursor=cursor, limit=limit
    )


@router.get("/explore/findings/{finding_id}", response_model=KbFinding)
async def finding(finding_id: EntityPath, service: ServiceDep) -> KbFinding:
    return await service.finding(finding_id)


@router.post("/explore/findings/{finding_id}/explore", response_model=KbExploring)
async def explore(finding_id: EntityPath, body: KbExploreStart, service: ServiceDep) -> KbExploring:
    return await service.explore(finding_id, body)


@router.post("/explore/findings/{finding_id}/wiki", response_model=KbFindingImported)
async def add_to_wiki(
    finding_id: EntityPath, body: KbFindingImport, service: ServiceDep
) -> KbFindingImported:
    return await service.add_to_wiki(finding_id, body)


@router.get("/explore/exploring", response_model=KbExploringList)
async def exploring(service: ServiceDep) -> KbExploringList:
    return await service.exploring()
