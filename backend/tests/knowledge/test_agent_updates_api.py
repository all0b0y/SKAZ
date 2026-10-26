"""U1 routes: ``/kb/agents/updates`` and ``/kb/agents/{engine}/update…`` on fakes (no real command runs)."""
from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import httpx
import pytest

from skaz.knowledge.agents.engine import EngineId, EngineStatus
from skaz.knowledge.agents.fake import FakeEngine
from skaz.knowledge.agents.hub import build_agents_hub
from skaz.knowledge.agents.updates import AgentUpdates
from skaz.knowledge.install.system import Located
from tests.knowledge.test_agent_install import FakeExecutor


@pytest.fixture
def updates_app(kb_app: Any, tmp_path: Path) -> Any:
    home = tmp_path / "home"
    real = home / ".local/lib/node_modules/@openai/codex/bin/codex.js"
    real.parent.mkdir(parents=True)
    real.write_text("")
    codex = home / ".local/bin/codex"
    codex.parent.mkdir(parents=True)
    codex.symlink_to(real)
    engines: dict[EngineId, Any] = {
        "codex": FakeEngine("codex", status=EngineStatus("codex", installed=True, version="0.160.0",
                                                         signed_in=True)),
        "claude_code": FakeEngine("claude_code", status=EngineStatus("claude_code", installed=False)),
        "hermes": FakeEngine("hermes", status=EngineStatus("hermes", installed=False)),
    }
    executor = FakeExecutor([(["changed 1 package"], 0)])

    def located(name: str) -> Located | None:
        return Located(codex, "/usr/bin:/bin") if name in ("codex", "codex.js") else None

    hub = build_agents_hub(tmp_path / "data", settings=kb_app.state.runtime.kb.settings,
                           codex=None,  # type: ignore[arg-type]
                           engines=engines, executor=executor, locate_cli=located, user_home=home)
    asked: list[str] = []

    async def fetch(url: str) -> str:
        asked.append(url)
        return '{"version": "0.164.0"}'

    assert hub.updates is not None
    hub.updates = AgentUpdates(hub.registry, hub.installs, hub.updates.gate, home=home,
                               locate=located,
                               fetch=fetch)
    kb_app.state.runtime.kb_agents = hub
    return hub, engines, executor, asked


async def test_check_offer_seen_skip_and_settings(updates_app: Any, kb_client: httpx.AsyncClient) -> None:
    _hub, _engines, _executor, asked = updates_app
    first = (await kb_client.get("/kb/agents/updates")).json()
    assert first["auto"] is True and first["checked_at"] is None and asked == []  # reading asks nothing
    checked = (await kb_client.post("/kb/agents/updates/check-now")).json()
    codex = next(agent for agent in checked["agents"] if agent["engine"] == "codex")
    assert codex | {"checked_at": "-"} == {
        "engine": "codex", "name": "Codex", "channel": "npm", "installed": "0.160.0", "latest": "0.164.0",
        "available": True, "unseen": True, "skipped": None, "busy": False, "phase": "idle", "action": None,
        "task_id": None, "note": "Updates Codex for this whole Mac, including Terminal.",
        "services_note": None, "failure": None, "checked_at": "-", "waiting": [],
    }
    assert checked["unseen"] is True and asked == ["https://registry.npmjs.org/@openai/codex/latest"]
    seen = (await kb_client.post("/kb/agents/updates/seen")).json()
    assert seen["unseen"] is False
    skipped = (await kb_client.post("/kb/agents/codex/update/skip", json={"version": "0.164.0"})).json()
    assert not next(a for a in skipped["agents"] if a["engine"] == "codex")["available"]
    off = (await kb_client.put("/kb/agents/updates/settings", json={"auto": False})).json()
    assert off["auto"] is False and off["next_check_at"] is None
    refused = await kb_client.post("/kb/agents/codex/update")
    assert refused.status_code == 409 and "no newer Codex" in refused.json()["detail"]


async def test_update_runs_through_the_install_task(updates_app: Any, kb_client: httpx.AsyncClient) -> None:
    _hub, _engines, executor, _asked = updates_app
    await kb_client.post("/kb/agents/updates/check-now")
    started = await kb_client.post("/kb/agents/codex/update")
    assert started.status_code == 202
    codex = next(agent for agent in started.json()["agents"] if agent["engine"] == "codex")
    assert codex["phase"] == "updating"
    for _ in range(200):
        view = (await kb_client.get("/kb/agents/updates")).json()
        codex = next(agent for agent in view["agents"] if agent["engine"] == "codex")
        if codex["phase"] == "idle":
            break
        if codex["task_id"]:
            task = (await kb_client.get(f"/kb/agents/install/{codex['task_id']}")).json()
            assert task["action"] == "upgrade"
        await asyncio.sleep(0.01)
    assert executor.started[0]["argv"][1:] == ["update"]
    # The fake left the version as it was: SKAZ says so instead of claiming an update.
    assert codex["failure"]["reason"] == "Codex wasn't updated: it is still 0.160.0."
    assert codex["failure"]["command"] == "npm install -g @openai/codex@latest"


async def test_update_routes_validate_the_engine_and_the_body(updates_app: Any,
                                                              kb_client: httpx.AsyncClient) -> None:
    assert (await kb_client.post("/kb/agents/gemini/update")).status_code == 422
    assert (await kb_client.post("/kb/agents/codex/update/skip", json={})).status_code == 422
    not_a_version = await kb_client.post("/kb/agents/codex/update/skip", json={"version": "latest"})
    assert not_a_version.status_code == 409
    assert (await kb_client.post("/kb/agents/codex/update/rollback")).status_code == 409
    assert (await kb_client.post("/kb/agents/codex/update/cancel")).status_code == 200


async def test_update_routes_require_the_token(kb_app: Any) -> None:
    transport = httpx.ASGITransport(app=kb_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8765") as anon:
        for method, path in (("GET", "/kb/agents/updates"), ("PUT", "/kb/agents/updates/settings"),
                             ("POST", "/kb/agents/updates/check-now"), ("POST", "/kb/agents/updates/seen"),
                             ("POST", "/kb/agents/codex/update"), ("POST", "/kb/agents/codex/update/cancel"),
                             ("POST", "/kb/agents/codex/update/skip"),
                             ("POST", "/kb/agents/codex/update/rollback")):
            assert (await anon.request(method, path)).status_code == 401, path


def test_the_runtime_has_agent_updates_and_starts_no_request(kb_app: Any) -> None:
    hub = kb_app.state.runtime.kb_agents
    assert hub.updates is not None
    assert hub.updates._loop is None  # the schedule starts with the app's lifespan (hub.start), not here
