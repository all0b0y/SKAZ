"""``/kb/agents/updates`` and ``/kb/agents/{engine}/update…`` (U1): check, offer, update, skip, roll back.

Kept beside ``agents.py`` in the same ``/kb/agents`` style; no path here can be taken for one of
its ``/{engine}/…`` routes (``updates`` is not an engine, and the global routes have their own
second segment).
"""
from __future__ import annotations

from typing import Annotated, cast

from fastapi import APIRouter, Depends, HTTPException, Request

from ..agents.hub import AgentsHub
from ..agents.updates import AgentUpdates, UpdatesView
from ..errors import KnowledgeError
from .schemas_agent_updates import (
    KbAgentUpdate,
    KbAgentUpdateFailure,
    KbAgentUpdates,
    KbAgentUpdateSettings,
    KbAgentUpdateSkip,
)
from .schemas_agents import KbEngineId

router = APIRouter(prefix="/kb/agents", tags=["kb"])


def get_updates(request: Request) -> AgentUpdates:
    hub = cast(AgentsHub, request.app.state.runtime.kb_agents)
    if hub.updates is None:
        raise HTTPException(status_code=503, detail="Agent updates are not available.")
    return hub.updates


UpdatesDep = Annotated[AgentUpdates, Depends(get_updates)]


def updates_view(view: UpdatesView) -> KbAgentUpdates:
    return KbAgentUpdates(
        auto=view.auto, checking=view.checking, checked_at=view.checked_at, next_check_at=view.next_check_at,
        unseen=view.unseen,
        agents=[KbAgentUpdate(
            engine=agent.engine, name=agent.name, channel=agent.channel, installed=agent.installed,
            latest=agent.latest, available=agent.available, unseen=agent.unseen, skipped=agent.skipped,
            busy=agent.busy, phase=agent.phase, action=agent.action, task_id=agent.task_id, note=agent.note,
            services_note=agent.services_note, checked_at=agent.checked_at, waiting=list(agent.waiting),
            failure=KbAgentUpdateFailure(
                reason=agent.failure.reason, command=agent.failure.command, output=list(agent.failure.output),
                previous=agent.failure.previous, rollback=agent.failure.rollback,
                docs_url=agent.failure.docs_url) if agent.failure is not None else None,
        ) for agent in view.agents],
    )


def _http(error: KnowledgeError) -> HTTPException:
    return HTTPException(status_code=error.status_code, detail=error.message)


@router.get("/updates")
async def agent_updates(updates: UpdatesDep) -> KbAgentUpdates:
    """What the last checks found per agent; reads only SKAZ's own record (no request goes out)."""
    return updates_view(await updates.view())


@router.put("/updates/settings")
async def set_agent_update_settings(body: KbAgentUpdateSettings, updates: UpdatesDep) -> KbAgentUpdates:
    return updates_view(await updates.set_auto(body.auto))


@router.post("/updates/check-now")
async def check_agent_updates(updates: UpdatesDep) -> KbAgentUpdates:
    """**Check for updates**: every installed agent's channel now (only versions are asked for)."""
    return updates_view(await updates.check())


@router.post("/updates/seen")
async def seen_agent_updates(updates: UpdatesDep) -> KbAgentUpdates:
    """The offers were shown in Settings: the dot goes away until a newer version appears."""
    return updates_view(await updates.mark_seen())


@router.post("/{engine}/update", status_code=202)
async def update_agent(engine: KbEngineId, updates: UpdatesDep) -> KbAgentUpdates:
    """Update to the offered version with the agent's own command (after its current work if busy)."""
    try:
        return updates_view(await updates.update(engine))
    except KnowledgeError as error:
        raise _http(error) from error


@router.post("/{engine}/update/cancel")
async def cancel_agent_update(engine: KbEngineId, updates: UpdatesDep) -> KbAgentUpdates:
    return updates_view(await updates.cancel(engine))


@router.post("/{engine}/update/skip")
async def skip_agent_update(engine: KbEngineId, body: KbAgentUpdateSkip,
                            updates: UpdatesDep) -> KbAgentUpdates:
    try:
        return updates_view(await updates.skip(engine, body.version))
    except KnowledgeError as error:
        raise _http(error) from error


@router.post("/{engine}/update/rollback", status_code=202)
async def roll_back_agent(engine: KbEngineId, updates: UpdatesDep) -> KbAgentUpdates:
    """Back to the version before a failed update (OpenCode, Claude Code: their own command can)."""
    try:
        return updates_view(await updates.rollback(engine))
    except KnowledgeError as error:
        raise _http(error) from error
