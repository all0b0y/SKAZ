"""0.4.0 explore routes. Unwired services answer 503 not_ready."""

from __future__ import annotations

from typing import Annotated, cast

from fastapi import APIRouter, Depends, Path, Query, Request

from ..explore.protocols import ExploreService
from .contract_routes import ERROR_RESPONSES, ContractRoute, service_for
from .schemas_explore import (
    KbCandidateOutcome,
    KbDiscussion,
    KbExploreStart,
    KbExploring,
    KbExploringList,
    KbFinding,
    KbFindingImport,
    KbFindingImported,
    KbFindings,
    KbFindingsShow,
    KbFindingsSort,
    KbFindingsType,
    KbFunnelCandidate,
    KbFunnelCandidates,
    KbFunnelRun,
    KbFunnelStart,
    KbSearch,
    KbSearches,
    KbSearchPlan,
    KbSearchPlanRequest,
    KbSearchRename,
)
from .schemas_explore_common import KbAcknowledged, KbContinue, KbJobs

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
    run_id: str | None = None,
    show: KbFindingsShow = "active",
    free_only: bool = False,
    year_from: Annotated[int | None, Query(ge=1, le=9999)] = None,
    year_to: Annotated[int | None, Query(ge=1, le=9999)] = None,
    types: Annotated[list[KbFindingsType] | None, Query()] = None,
    sort: KbFindingsSort = "for_you",
) -> KbFindings:
    """EX3: with ``run_id`` — one search's findings, filtered and sorted (Show, Free only, Year, Type)."""
    return await service.findings(
        area_id=area_id,
        task_id=task_id,
        include_covered=include_covered,
        cursor=cursor,
        limit=limit,
        run_id=run_id,
        show=show,
        free_only=free_only,
        year_from=year_from,
        year_to=year_to,
        types=types or (),
        sort=sort,
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


# -- EX2: "Will search" plan and the funnel on view ----------------------------------------------------

#: A candidate is a science work id (OpenAlex ``W…``, arXiv ``2502.13897``, a DOI-derived id).
CandidatePath = Annotated[str, Path(min_length=1, max_length=200)]


@router.post("/explore/plan", response_model=KbSearchPlan)
async def plan(body: KbSearchPlanRequest, service: ServiceDep) -> KbSearchPlan:
    """What a run would send (shown before it starts); nothing leaves the machine here."""
    return await service.plan(body)


@router.get("/explore/runs/{run_id}/candidates", response_model=KbFunnelCandidates)
async def candidates(
    run_id: EntityPath,
    service: ServiceDep,
    outcome: KbCandidateOutcome | None = None,
    cursor: str | None = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 30,
) -> KbFunnelCandidates:
    return await service.candidates(run_id, outcome=outcome, cursor=cursor, limit=limit)


@router.post("/explore/runs/{run_id}/candidates/{candidate_id}/fits", response_model=KbFunnelCandidate)
async def mark_fits(
    run_id: EntityPath, candidate_id: CandidatePath, service: ServiceDep
) -> KbFunnelCandidate:
    """"It fits": a dropped work goes on (the paid novelty check still waits for a click)."""
    return await service.mark_fits(run_id, candidate_id)


# -- EX3 (Explore v2): searches in the side list, what the user does with a finding ---------------------


@router.get("/explore/searches", response_model=KbSearches)
async def searches(service: ServiceDep) -> KbSearches:
    return await service.searches()


@router.put("/explore/searches/{run_id}/name", response_model=KbSearch)
async def rename_search(run_id: EntityPath, body: KbSearchRename, service: ServiceDep) -> KbSearch:
    return await service.rename_search(run_id, body)


@router.delete("/explore/searches/{run_id}", response_model=KbAcknowledged)
async def delete_search(run_id: EntityPath, service: ServiceDep) -> KbAcknowledged:
    """The search and its findings go; papers already added stay in Materials."""
    return await service.delete_search(run_id)


@router.post("/explore/findings/{finding_id}/seen", response_model=KbFinding)
async def mark_seen(finding_id: EntityPath, service: ServiceDep) -> KbFinding:
    return await service.mark_seen(finding_id)


@router.post("/explore/findings/{finding_id}/dismiss", response_model=KbFinding)
async def dismiss(finding_id: EntityPath, service: ServiceDep) -> KbFinding:
    """«Not for me»: hidden here and never offered again by a later search."""
    return await service.dismiss(finding_id)


@router.post("/explore/findings/{finding_id}/restore", response_model=KbFinding)
async def restore(finding_id: EntityPath, service: ServiceDep) -> KbFinding:
    return await service.restore(finding_id)


@router.post("/explore/findings/{finding_id}/materials", response_model=KbFindingImported)
async def add_to_materials(finding_id: EntityPath, service: ServiceDep) -> KbFindingImported:
    """The paper goes to the «From Explore» folder, not to the wiki."""
    return await service.add_to_materials(finding_id)


@router.post("/explore/findings/{finding_id}/discuss", response_model=KbDiscussion)
async def discuss(finding_id: EntityPath, service: ServiceDep) -> KbDiscussion:
    """An ordinary chat on the paper's card; nothing is downloaded."""
    return await service.discuss(finding_id)
