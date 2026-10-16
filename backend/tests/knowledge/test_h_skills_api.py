"""``/kb/settings/skills`` (0.3.1 H3): the Humanizer switch and its status per agent.

Agents are fakes at the external seam (no real codex/claude/hermes process).
"""
from __future__ import annotations

from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest

from skaz.app import create_app
from skaz.config import AppConfig
from skaz.knowledge.agents.engine import EngineStatus
from skaz.knowledge.agents.fake import FakeEngine
from skaz.knowledge.agents.hub import build_agents_hub
from skaz.knowledge.agents.registry import AgentView
from skaz.knowledge.skills.settings import enabled_skills
from skaz.knowledge.skills.status import engine_status
from skaz.secrets import MemorySecretStore
from tests.conftest import TOKEN
from tests.knowledge.test_agent_install import FakeExecutor


@pytest.fixture
def app(kb_config: AppConfig, tmp_path: Path) -> Iterator[Any]:
    application = create_app(kb_config, secret_store=MemorySecretStore(), http_client=httpx.AsyncClient(
        transport=httpx.MockTransport(lambda request: httpx.Response(599))))
    runtime = application.state.runtime
    runtime.kb_agents = build_agents_hub(
        tmp_path / "agents-data",
        settings=runtime.kb.settings,
        codex=None,  # type: ignore[arg-type]
        engines={
            "codex": FakeEngine("codex", status=EngineStatus("codex", installed=False,
                                                             reason="Codex is not installed.")),
            "claude_code": FakeEngine("claude_code"),
            "hermes": FakeEngine("hermes", status=EngineStatus("hermes", installed=True, version="0.1",
                                                               incompatible=True, reason="Too old.")),
        },
        executor=FakeExecutor([([], 0)]),
    )
    yield application
    runtime.close()


@pytest.fixture
async def api(app: Any) -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8765",
                                 headers={"Authorization": f"Bearer {TOKEN}"}) as client:
        yield client


async def test_humanizer_is_on_by_default_with_a_status_per_agent(api: httpx.AsyncClient) -> None:
    response = await api.get("/kb/settings/skills")
    assert response.status_code == 200
    assert response.json() == {"skills": [{
        "id": "humanizer", "name": "Humanizer", "version": "3.1.0", "license": "MIT",
        "source_url": "https://github.com/blader/humanizer", "enabled": True,
        "engines": [
            {"engine": "codex", "state": "not_loaded", "reason": "Codex is not installed."},
            {"engine": "claude_code", "state": "loaded", "reason": None},
            {"engine": "hermes", "state": "not_loaded",
             "reason": "This Hermes Agent version isn't supported. Update it."},
        ],
    }]}


async def test_turning_humanizer_off_is_stored_and_every_agent_reads_off(api: httpx.AsyncClient,
                                                                         app: Any) -> None:
    response = await api.put("/kb/settings/skills/humanizer", json={"enabled": False})
    assert response.status_code == 200
    skill = response.json()["skills"][0]
    assert skill["enabled"] is False
    assert [(e["engine"], e["state"], e["reason"]) for e in skill["engines"]] == [
        ("codex", "off", None), ("claude_code", "off", None), ("hermes", "off", None)]
    kb = app.state.runtime.kb
    assert kb.settings.get("humanizer_enabled") is False
    assert enabled_skills(kb.settings) == ()
    again = (await api.get("/kb/settings/skills")).json()["skills"][0]
    assert again["enabled"] is False

    back = (await api.put("/kb/settings/skills/humanizer", json={"enabled": True})).json()["skills"][0]
    assert back["enabled"] is True
    assert [skill.id for skill in enabled_skills(kb.settings)] == ["humanizer"]


async def test_unknown_skills_and_odd_bodies_are_refused(api: httpx.AsyncClient, app: Any) -> None:
    assert (await api.put("/kb/settings/skills/personal", json={"enabled": False})).status_code == 404
    assert (await api.put("/kb/settings/skills/..", json={"enabled": False})).status_code in (404, 422)
    assert (await api.put("/kb/settings/skills/humanizer", json={"enabled": False, "path": "/x"})
            ).status_code == 422
    assert (await api.put("/kb/settings/skills/humanizer", json={})).status_code == 422
    assert (await api.put("/kb/settings/skills/humanizer", json={"enabled": "no"})).status_code == 422
    assert app.state.runtime.kb.settings.get("humanizer_enabled") is None  # nothing was written


async def test_the_switch_needs_the_token(app: Any) -> None:
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                 base_url="http://127.0.0.1:8765") as client:
        assert (await client.get("/kb/settings/skills")).status_code == 401
        assert (await client.put("/kb/settings/skills/humanizer", json={"enabled": False})).status_code == 401


def test_each_agent_state_reads_as_a_plain_skill_status() -> None:
    def view(state: Any, action: Any = None) -> AgentView:
        return AgentView("hermes", "Hermes Agent", EngineStatus("hermes", installed=True), state, action,
                         (), None, "2026-10-17T00:00:00+00:00")

    cases = [
        (view("ready"), ("loaded", None)),
        (view("signed_out", "login"), ("loaded", None)),
        (view("not_installed", "install"), ("not_loaded", "Hermes Agent is not installed.")),
        (view("outdated", "update"), ("not_loaded", "This Hermes Agent version isn't supported. Update it.")),
        (view("preparing"), ("not_loaded", "Hermes Agent is being checked.")),
        (view("unavailable", "first_check"), ("not_loaded", "Hermes Agent needs its one-time check first.")),
        (view("unavailable", "check"), ("not_loaded", "SKAZ couldn't check Hermes Agent.")),
    ]
    for given, expected in cases:
        status = engine_status(True, given)
        assert (status.state, status.reason) == expected, given.state
        assert (engine_status(False, given).state, engine_status(False, given).reason) == ("off", None)
