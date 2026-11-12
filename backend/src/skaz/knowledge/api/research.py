"""0.4.0 research routes. Unwired services answer 503 not_ready."""

from __future__ import annotations

from typing import Annotated, cast

from fastapi import APIRouter, Depends, Path, Query, Request

from ..research.protocols import ResearchService
from .contract_routes import ERROR_RESPONSES, ContractRoute, service_for
from .schemas_explore_common import KbContinue
from .schemas_research import (
    KbExploreRead,
    KbExploreSnapshot,
    KbResearchCreate,
    KbResearchDecide,
    KbResearchGrant,
    KbResearchPermission,
    KbResearchProposal,
    KbResearchTask,
    KbResearchTasks,
)

router = APIRouter(prefix="/kb", tags=["kb-research"], route_class=ContractRoute, responses=ERROR_RESPONSES)


def get_service(request: Request) -> ResearchService:
    return cast(ResearchService, service_for(request, "research"))


ServiceDep = Annotated[ResearchService, Depends(get_service)]
EntityPath = Annotated[str, Path(min_length=1, max_length=128, pattern=r"^[a-zA-Z0-9_-]+$")]


@router.post("/research/proposals", response_model=KbResearchProposal)
async def propose(body: KbResearchCreate, service: ServiceDep) -> KbResearchProposal:
    """EX2: the card of "+ New research task" — title and proposed topics; nothing starts."""
    return await service.propose(body)


@router.post("/research/tasks", response_model=KbResearchTask)
async def create(body: KbResearchCreate, service: ServiceDep) -> KbResearchTask:
    return await service.create(body)


@router.get("/research/tasks", response_model=KbResearchTasks)
async def tasks(
    service: ServiceDep, cursor: str | None = None, limit: Annotated[int, Query(ge=1, le=100)] = 30
) -> KbResearchTasks:
    return await service.tasks(cursor=cursor, limit=limit)


@router.get("/research/tasks/{task_id}", response_model=KbResearchTask)
async def task(task_id: EntityPath, service: ServiceDep) -> KbResearchTask:
    return await service.task(task_id)


@router.post("/research/tasks/{task_id}/pause", response_model=KbResearchTask)
async def pause(task_id: EntityPath, service: ServiceDep) -> KbResearchTask:
    return await service.pause(task_id)


@router.post("/research/tasks/{task_id}/continue", response_model=KbResearchTask)
async def resume(task_id: EntityPath, body: KbContinue, service: ServiceDep) -> KbResearchTask:
    return await service.resume(task_id, body)


@router.post("/research/tasks/{task_id}/cancel", response_model=KbResearchTask)
async def cancel(task_id: EntityPath, service: ServiceDep) -> KbResearchTask:
    return await service.cancel(task_id)


@router.post("/research/permissions/{request_id}/decide", response_model=KbResearchPermission)
async def decide(request_id: EntityPath, body: KbResearchDecide, service: ServiceDep) -> KbResearchPermission:
    return await service.decide(request_id, body)


@router.get("/chats/{chat_id}/research-grant", response_model=KbResearchGrant)
async def grant(chat_id: EntityPath, service: ServiceDep) -> KbResearchGrant:
    return await service.grant(chat_id)


@router.delete("/chats/{chat_id}/research-grant", response_model=KbResearchGrant)
async def revoke_grant(chat_id: EntityPath, service: ServiceDep) -> KbResearchGrant:
    return await service.revoke_grant(chat_id)


@router.post("/explore/read", response_model=KbExploreSnapshot)
async def read(body: KbExploreRead, service: ServiceDep) -> KbExploreSnapshot:
    return await service.read(body)
