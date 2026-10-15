"""``/kb/agents``: the three agent engines — status, models, default, install/update, sign-in."""
from __future__ import annotations

from typing import Annotated, cast

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from ...gateways.codex_connection import MIN_CODEX_VERSION
from ..agents.claude_code import MIN_CLAUDE_VERSION
from ..agents.engine import EngineId
from ..agents.hermes import MIN_HERMES_VERSION
from ..agents.hub import AgentsHub
from ..agents.registry import AgentView, EngineUnavailable
from ..errors import KnowledgeError
from ..install.recipes import Recipe
from ..install.system import dotted
from ..install.tasks import InstallTask
from .schemas_agents import (
    KbAgent,
    KbAgentDefault,
    KbAgentFirstRun,
    KbAgentInstallInfo,
    KbAgentLogin,
    KbAgentLoginResult,
    KbAgentModel,
    KbAgents,
    KbEngineId,
    KbInstallLine,
    KbInstallStart,
    KbInstallTask,
)

router = APIRouter(prefix="/kb/agents", tags=["kb"])
MIN_VERSIONS: dict[EngineId, str] = {
    "codex": dotted(MIN_CODEX_VERSION), "claude_code": dotted(MIN_CLAUDE_VERSION),
    "hermes": dotted(MIN_HERMES_VERSION),
}
MAX_WAIT_S = 25.0


def get_hub(request: Request) -> AgentsHub:
    return cast(AgentsHub, request.app.state.runtime.kb_agents)


HubDep = Annotated[AgentsHub, Depends(get_hub)]


def _http(error: KnowledgeError) -> HTTPException:
    return HTTPException(status_code=error.status_code, detail=error.message)


def _install_info(recipe: Recipe) -> KbAgentInstallInfo:
    return KbAgentInstallInfo(docs_url=recipe.docs_url, manual_command=recipe.manual_command,
                              checked_on=recipe.checked_on)


def agent_view(hub: AgentsHub, view: AgentView) -> KbAgent:
    status = view.status
    running = hub.installs.running_for(view.engine)
    state, action = hub.state(view)
    first = view.first_run
    return KbAgent(
        id=view.engine, name=view.name, state=state, installed=status.installed, version=status.version,
        min_version=MIN_VERSIONS[view.engine], signed_in=status.signed_in, incompatible=status.incompatible,
        reason=first.note if state == "preparing" and first is not None else status.reason, action=action,
        first_run=(KbAgentFirstRun(required_bytes=first.required_bytes, prepared=first.prepared,
                                   note=first.note) if first is not None else None),
        models=[KbAgentModel(id=m.id, label=m.label, efforts=list(m.efforts), default_effort=m.default_effort)
                for m in view.models],
        current_model=view.current_model, install=_install_info(hub.installs.recipes[view.engine]),
        install_task=running.id if running else None, checked_at=view.checked_at,
    )


def task_view(task: InstallTask, after: int) -> KbInstallTask:
    lines = task.after(after)
    cursor = lines[-1].seq if lines else max(after, 0)
    return KbInstallTask(
        id=task.id, engine=task.engine, action=task.action, state=task.state,
        lines=[KbInstallLine(seq=line.seq, text=line.text, at=line.at) for line in lines], cursor=cursor,
        dropped=task.dropped, reason=task.reason, version=task.version, install=_install_info(task.recipe),
        started_at=task.started_at, finished_at=task.finished_at,
    )


@router.get("")
async def list_agents(hub: HubDep) -> KbAgents:
    views = await hub.registry.views()
    return KbAgents(agents=[agent_view(hub, view) for view in views], default=hub.registry.default())


@router.put("/default")
async def set_default_agent(body: KbAgentDefault, hub: HubDep) -> KbAgents:
    hub.registry.set_default(body.engine)
    return await list_agents(hub)


@router.post("/{engine}/check")
async def check_agent(engine: KbEngineId, hub: HubDep) -> KbAgent:
    return agent_view(hub, await hub.registry.view(engine, refresh=True))


@router.post("/{engine}/install", status_code=202)
async def install_agent(engine: KbEngineId, hub: HubDep, body: KbInstallStart | None = None) -> KbInstallTask:
    try:
        task = hub.installs.start(engine, body.action if body else "install")
    except KnowledgeError as error:
        raise _http(error) from error
    hub.registry.forget(engine)
    return task_view(task, 0)


@router.get("/install/{task_id}")
async def install_progress(task_id: str, hub: HubDep, after: Annotated[int, Query(ge=0)] = 0,
                           wait: Annotated[float, Query(ge=0, le=MAX_WAIT_S)] = 0) -> KbInstallTask:
    try:
        task = hub.installs.get(task_id)
    except KnowledgeError as error:
        raise _http(error) from error
    await task.wait_change(after, wait)
    return task_view(task, after)


@router.post("/install/{task_id}/cancel")
async def cancel_install(task_id: str, hub: HubDep) -> KbInstallTask:
    try:
        task = await hub.installs.cancel(task_id)
    except KnowledgeError as error:
        raise _http(error) from error
    return task_view(task, 0)


@router.post("/{engine}/login")
async def login_agent(engine: KbEngineId, hub: HubDep,
                      body: KbAgentLogin | None = None) -> KbAgentLoginResult:
    try:
        outcome = await hub.registry.login(engine, consent=bool(body and body.consent))
    except EngineUnavailable as error:
        raise _http(error) from error
    return KbAgentLoginResult(engine=outcome.engine, method=outcome.method, url=outcome.url,
                              message=outcome.message)


@router.post("/codex/logout")
async def logout_codex(hub: HubDep) -> KbAgent:
    """Sign out of Codex in SKAZ's own Codex profile (Codex's ``account/logout``); the agent re-checked.

    Only Codex: its sign-in lives in SKAZ's ``CODEX_HOME``. Claude Code and Hermes keep theirs in
    their own apps, which SKAZ never touches.
    """
    try:
        view = await hub.registry.logout("codex")
    except EngineUnavailable as error:
        raise _http(error) from error
    return agent_view(hub, view)
