"""Engine registry (statuses, default engine, no silent substitution) and the ``/kb/agents`` API."""

from __future__ import annotations

import asyncio
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import httpx
import pytest

from skaz.knowledge.agents.engine import EngineId, EngineStatus, Failed, ModelOption, collect
from skaz.knowledge.agents.fake import FakeEngine
from skaz.knowledge.agents.hub import AgentsHub, build_agents_hub
from skaz.knowledge.agents.registry import (
    DEFAULT_ENGINE_KEY,
    CodexStatusEngine,
    EngineUnavailable,
    classify,
)
from skaz.knowledge.service import KnowledgeService
from tests.knowledge.test_agent_install import HANG, FakeExecutor
from tests.knowledge.test_agents import turn as sample_turn


class LoginEngine(FakeEngine):
    def __init__(self, engine_id: EngineId, **kwargs: Any) -> None:
        super().__init__(engine_id, **kwargs)
        self.logins = 0

    async def login(self) -> None:
        self.logins += 1


class FakeCodexConnection:
    def __init__(self, view: dict[str, Any]) -> None:
        self.view = view
        self.consents: list[bool] = []

    async def check(self) -> dict[str, Any]:
        return dict(self.view)

    async def login(self, consent: bool) -> str:
        self.consents.append(consent)
        if not consent:
            raise ValueError("Subscription privacy consent is required")
        return "https://auth.openai.com/authorize?x=1"


def statuses() -> dict[EngineId, LoginEngine]:
    return {
        "codex": LoginEngine("codex", models=[ModelOption("gpt-5.5", "GPT-5.5", ("low", "high"), "high")]),
        "claude_code": LoginEngine(
            "claude_code",
            status=EngineStatus(
                "claude_code",
                installed=True,
                version="2.1.281",
                reason="Sign in to Claude Code to use it in SKAZ.",
            ),
        ),
        "hermes": LoginEngine(
            "hermes", status=EngineStatus("hermes", installed=False, reason="Hermes Agent is not installed.")
        ),
    }


def hub_for(
    service: KnowledgeService,
    tmp_path: Path,
    executor: FakeExecutor | None = None,
    engines: dict[EngineId, Any] | None = None,
) -> AgentsHub:
    return build_agents_hub(
        tmp_path / "data",
        settings=service.settings,
        codex=None,  # type: ignore[arg-type]
        engines=engines or statuses(),
        executor=executor or FakeExecutor([([], 0)]),
        locate_cli=lambda name: None,
        user_home=tmp_path / "home",
    )


async def test_default_engine_is_codex_until_changed_and_persists(
    service: KnowledgeService, tmp_path: Path
) -> None:
    registry = hub_for(service, tmp_path).registry
    assert registry.default() == "codex"
    registry.set_default("hermes")
    assert service.settings.get(DEFAULT_ENGINE_KEY) == "hermes"
    assert hub_for(service, tmp_path / "again").registry.default() == "hermes"


async def test_require_never_substitutes_another_engine(service: KnowledgeService, tmp_path: Path) -> None:
    registry = hub_for(service, tmp_path).registry
    assert (await registry.require("codex")).id == "codex"
    with pytest.raises(EngineUnavailable) as signed_out:
        await registry.require("claude_code")
    assert signed_out.value.action == "login" and signed_out.value.engine == "claude_code"
    assert signed_out.value.message == "Sign in to Claude Code to use it in SKAZ."
    with pytest.raises(EngineUnavailable) as missing:
        await registry.require("hermes")
    assert missing.value.action == "install" and missing.value.status_code == 409


def test_states_and_actions() -> None:
    assert classify(EngineStatus("hermes", installed=False)) == ("not_installed", "install")
    assert classify(EngineStatus("hermes", installed=True, version="0.20.1", incompatible=True)) == (
        "outdated",
        "update",
    )
    assert classify(EngineStatus("hermes", installed=True, version="0.21.5")) == ("signed_out", "login")
    assert classify(EngineStatus("codex", installed=True)) == ("unavailable", "check")
    assert classify(EngineStatus("codex", installed=True, version="1", signed_in=True)) == ("ready", None)
    assert classify(EngineStatus("codex", installed=False), check_failed=True) == ("unavailable", "check")


async def test_a_failing_status_check_does_not_break_the_list(
    service: KnowledgeService, tmp_path: Path
) -> None:
    class Broken(LoginEngine):
        async def status(self) -> EngineStatus:
            raise RuntimeError("boom")

    engines: dict[EngineId, Any] = {**statuses(), "hermes": Broken("hermes")}
    views = await hub_for(service, tmp_path, engines=engines).registry.views()
    hermes = next(view for view in views if view.engine == "hermes")
    assert hermes.state == "unavailable" and hermes.action == "check"
    assert hermes.status.reason == "SKAZ couldn't check Hermes Agent. Try again."


async def test_codex_status_comes_from_the_existing_connection() -> None:
    connected = CodexStatusEngine(
        FakeCodexConnection(
            {  # type: ignore[arg-type]
                "status": "connected",
                "version": "codex-cli 0.150.0",
                "models": [{"id": "gpt-5.5", "label": "GPT-5.5", "efforts": ["low", "high"]}],
            }
        )
    )
    status = await connected.status()
    assert status.ready and status.version == "0.150.0"
    assert [(m.id, m.efforts) for m in await connected.models()] == [("gpt-5.5", ("low", "high"))]
    outdated = await CodexStatusEngine(
        FakeCodexConnection(
            {  # type: ignore[arg-type]
                "status": "incompatible",
                "version": "codex-cli 0.100.0",
                "error": "Codex 0.100.0 is outdated",
            }
        )
    ).status()
    assert outdated.incompatible and outdated.reason == "Codex 0.100.0 is outdated"
    missing = await CodexStatusEngine(FakeCodexConnection({"status": "missing"})).status()  # type: ignore[arg-type]
    assert not missing.installed
    result = await collect(connected.run(sample_turn("r")))
    assert isinstance(result.terminal, Failed) and result.terminal.kind == "other"


@pytest.fixture
def agents_client(kb_app: Any, tmp_path: Path) -> Any:
    executor = FakeExecutor([(["Installing...", "curl: (6) Could not resolve host: x"], 6), HANG])
    engines = statuses()
    kb_app.state.runtime.kb_agents = hub_for(kb_app.state.runtime.kb, tmp_path, executor, engines)
    return kb_app, engines, executor


async def test_agents_api(agents_client: Any, kb_client: httpx.AsyncClient) -> None:
    _app, engines, executor = agents_client
    listed = (await kb_client.get("/kb/agents")).json()
    assert listed["default"] == "codex"
    by_id = {agent["id"]: agent for agent in listed["agents"]}
    assert list(by_id) == ["codex", "claude_code", "hermes", "opencode"]
    assert by_id["codex"]["state"] == "ready" and by_id["codex"]["models"] == [
        {"id": "gpt-5.5", "label": "GPT-5.5", "efforts": ["low", "high"], "default_effort": "high",
         # 0.3.1 K2/K4: the picker's section, human name and visibility
         "provider": "codex", "provider_label": "Codex", "name": "GPT-5.5", "tag": None, "visible": True,
         "default_visible": True, "favorite": False}
    ]
    assert by_id["claude_code"] | {"checked_at": "-"} == {
        "id": "claude_code",
        "name": "Claude Code",
        "state": "signed_out",
        "installed": True,
        "version": "2.1.281",
        "min_version": "2.1.259",
        "signed_in": False,
        "incompatible": False,
        "reason": "Sign in to Claude Code to use it in SKAZ.",
        "action": "login",
        "models": [],
        "current_model": None,
        "install": {
            "docs_url": "https://code.claude.com/docs/en/setup",
            "manual_command": "curl -fsSL https://claude.ai/install.sh | bash",
            "checked_on": "2026-10-15",
        },
        "install_task": None,
        "checked_at": "-",
        "first_run": None,  # only Hermes prepares its own environment (B10, area S3)
        # 0.3.1 Q-A1: Claude Code's AskUserQuestion needs a permission channel SKAZ keeps closed.
        "questions": "skaz",
        "last_choice": None,  # models screen v2: nothing chosen in the message field yet
        # W-2: Claude Code search is held for approval; W-3b `through` names a separate searcher (none here)
        "web_search": {"available": True, "reason": None, "through": None},
        # 0.3.1 K2: shown in the picker; no models, so no provider sections
        "visible": True,
        "providers": [],
    }
    assert by_id["hermes"]["action"] == "install" and by_id["hermes"]["min_version"] == "0.21.5"

    changed = await kb_client.put("/kb/agents/default", json={"engine": "claude_code"})
    assert changed.status_code == 200 and changed.json()["default"] == "claude_code"
    assert (await kb_client.put("/kb/agents/default", json={"engine": "gemini"})).status_code == 422

    started = await kb_client.post("/kb/agents/hermes/install", json={"action": "install"})
    assert started.status_code == 202
    task = started.json()
    for _ in range(100):
        task = (
            await kb_client.get(f"/kb/agents/install/{task['id']}", params={"after": 0, "wait": 1})
        ).json()
        if task["state"] != "running":
            break
        await asyncio.sleep(0.01)
    assert task["state"] == "failed" and "internet connection" in task["reason"]
    assert [line["text"] for line in task["lines"]][1:] == [
        "Installing...",
        "curl: (6) Could not resolve host: x",
    ]
    newer = (await kb_client.get(f"/kb/agents/install/{task['id']}", params={"after": task["cursor"]})).json()
    assert newer["lines"] == [] and newer["cursor"] == task["cursor"]

    second = (await kb_client.post("/kb/agents/codex/install")).json()
    for _ in range(100):
        if executor.steps and len(executor.steps) == 2:
            break
        await asyncio.sleep(0.01)
    listed = (await kb_client.get("/kb/agents")).json()
    assert {a["id"]: a["install_task"] for a in listed["agents"]}["codex"] == second["id"]
    cancelled = await kb_client.post(f"/kb/agents/install/{second['id']}/cancel")
    assert cancelled.status_code == 200 and cancelled.json()["state"] == "cancelled"
    assert (await kb_client.get("/kb/agents/install/nope")).status_code == 404

    login = await kb_client.post("/kb/agents/claude_code/login", json={})
    assert login.status_code == 200 and login.json()["method"] == "terminal" and login.json()["url"] is None
    assert engines["claude_code"].logins == 1

    checked = await kb_client.post("/kb/agents/hermes/check")
    assert checked.status_code == 200 and checked.json()["state"] == "not_installed"
    assert (await kb_client.post("/kb/agents/gemini/check")).status_code == 422


async def test_codex_login_uses_the_existing_browser_flow(service: KnowledgeService, tmp_path: Path) -> None:
    connection = FakeCodexConnection({"status": "signed_out"})
    engines: dict[EngineId, Any] = {**statuses(), "codex": CodexStatusEngine(connection)}  # type: ignore[arg-type]
    registry = hub_for(service, tmp_path, engines=engines).registry
    outcome = await registry.login("codex", consent=True)
    assert outcome.method == "browser" and outcome.url == "https://auth.openai.com/authorize?x=1"
    with pytest.raises(EngineUnavailable) as refused:
        await registry.login("codex", consent=False)
    assert "consent" in refused.value.message


async def test_agents_routes_require_the_token(kb_app: Any) -> None:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=kb_app), base_url="http://127.0.0.1:8765"
    ) as anonymous:
        for method, path in (
            ("GET", "/kb/agents"),
            ("PUT", "/kb/agents/default"),
            ("POST", "/kb/agents/codex/install"),
            ("GET", "/kb/agents/install/x"),
            ("POST", "/kb/agents/install/x/cancel"),
            ("POST", "/kb/agents/codex/login"),
            ("POST", "/kb/agents/codex/check"),
        ):
            assert (await anonymous.request(method, path)).status_code == 401, path


def test_runtime_wires_real_engines_without_starting_anything(kb_app: Any, tmp_path: Path) -> None:
    hub: AgentsHub = kb_app.state.runtime.kb_agents
    engines: Sequence[Any] = [hub.registry.engine(engine) for engine in ("codex", "claude_code", "hermes")]
    # Codex is the real run-capable engine (A1), not the status-only placeholder.
    assert [type(engine).__name__ for engine in engines] == [
        "CodexEngine",
        "ClaudeCodeEngine",
        "HermesEngine",
    ]
    assert engines[0] is kb_app.state.runtime.kb_codex
    # Claude Code and Hermes reach SKAZ tools through per-run tokens of the same MCP server.
    assert engines[1].mcp is not None and engines[2].mcp is not None
    hermes = engines[2]
    assert hermes.home == (kb_app.state.runtime.config.data_dir / "agents" / "hermes-home").resolve()
    assert not hermes.home.exists()  # nothing is created or launched until asked
