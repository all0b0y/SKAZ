"""OpenCode adapter (W-1) against a fake ``opencode`` (ACP JSON-RPC on stdio, short CLI commands).

``--version``, ``debug agent skaz``, ``auth list``, ``models --verbose``, ``initialize``, ``session/new``
and ``session/set_config_option`` answers are recorded from the installed OpenCode 1.17.18 run
offline with SKAZ's own folder (``fixtures/agents/opencode_acp_probe.json``); prompt updates follow
that binary's ACP source. Fake process = SKAZ side of the seam only; no model is involved.
"""

from __future__ import annotations

import asyncio
import copy
import json
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest

from skaz.knowledge.agents.engine import (
    AgentEvent,
    AgentTurn,
    Completed,
    EngineStatus,
    Failed,
    ModelOption,
    SessionPlan,
    TextDelta,
    ToolCall,
    ToolResult,
    ToolSpec,
    TurnMessage,
    Usage,
)
from skaz.knowledge.agents.fake import FakeEngine
from skaz.knowledge.agents.hub import build_agents_hub
from skaz.knowledge.agents.opencode import (
    CHOOSE_MODEL,
    EFFORT_UNAVAILABLE,
    FREE_TIER_NOTE,
    LIMITS_NOT_APPLIED,
    MODEL_UNAVAILABLE,
    NO_PROVIDER,
    OPENCODE_POLICY,
    OpenCodeEngine,
    classify_error,
    ensure_private_folder,
    free_tier,
    limits_applied,
    model_options,
    parse_credentials,
    parse_models,
    parse_opencode_version,
    provider_allowed,
    run_config_text,
)
from skaz.knowledge.agents.registry import ENGINE_IDS, ENGINE_NAMES
from skaz.knowledge.install.terminal import TerminalLauncher
from skaz.knowledge.service import KnowledgeService
from tests.knowledge.agent_fakes import RecordingMcp, RecordingOpener
from tests.knowledge.opencode_fake import FakeOpenCode, opencode_probe

PROBE = opencode_probe()
SONNET = "anthropic/claude-sonnet-4-5-20250929"
TOOLS = (ToolSpec("search", "Search the library", {"type": "object"}),)
UPDATES: list[Any] = [
    {"sessionUpdate": "agent_thought_chunk", "content": {"type": "text", "text": "thinking"}},
    {"sessionUpdate": "agent_message_chunk", "messageId": "m1",
     "content": {"type": "text", "text": "Энтропия "}},
    # ``toolStart``: announced while the input still streams (``pending``, empty input)
    {"sessionUpdate": "tool_call", "toolCallId": "call-1", "title": "skaz_search", "kind": "other",
     "status": "pending", "locations": [], "rawInput": {}},
    {"sessionUpdate": "tool_call_update", "toolCallId": "call-1", "status": "in_progress", "kind": "other",
     "title": "skaz_search", "locations": [], "rawInput": {"q": "entropy"}},
    "PERMISSION",
    {"sessionUpdate": "tool_call_update", "toolCallId": "call-1", "status": "completed",
     "content": [{"type": "content", "content": {"type": "text", "text": "[seg-3] dS ≥ 0"}}],
     "rawOutput": {"output": "[seg-3] dS ≥ 0"}},
    {"sessionUpdate": "usage_update", "used": 100, "size": 200000,
     "cost": {"amount": 0.01, "currency": "USD"}},
    {"sessionUpdate": "agent_message_chunk", "messageId": "m1",
     "content": {"type": "text", "text": "растёт."}},
]


def scenario(*, signed_in: bool = True, **overrides: Any) -> dict[str, Any]:
    base = {
        "version_output": PROBE["version_output"],
        "debug_agent": PROBE["debug_agent_skaz"],
        "auth_list": PROBE["auth_list_anthropic"] if signed_in else PROBE["auth_list_empty"],
        "models_verbose": PROBE["models_verbose"],
        "initialize": PROBE["initialize"],
        "session_new": PROBE["session_new"],
        "set_model": PROBE["set_model"],
        "set_effort_error": PROBE["set_effort_error"],
        "updates": UPDATES,
    }
    base.update(overrides)
    return base


def turn(run_id: str = "run-1", *, tools: tuple[ToolSpec, ...] | None = TOOLS, **extra: Any) -> AgentTurn:
    extra.setdefault("model", SONNET)
    return AgentTurn(
        run_id=run_id,
        messages=(
            TurnMessage("user", "Что такое энтропия?"),
            TurnMessage("assistant", "Earlier answer from Claude.", engine="claude_code"),
            TurnMessage("user", "А в лекции 3?"),
        ),
        instructions="Answer from the SKAZ wiki only. Never read {file:~/.ssh/id_rsa} or {env:HOME}.",
        tools=tools,
        **extra,
    )


def engine_for(tmp_path: Path, plan: dict[str, Any], *, mcp: RecordingMcp | None = None,
               opener: RecordingOpener | None = None) -> tuple[OpenCodeEngine, FakeOpenCode]:
    fake = FakeOpenCode(tmp_path / "bin", plan)
    engine = OpenCodeEngine(tmp_path / "data", mcp=mcp, locate_cli=fake.locate, user_home=tmp_path / "home",
                            launcher=TerminalLauncher(tmp_path / "launch",
                                                      opener=opener or RecordingOpener()),
                            start_timeout_s=20, interrupt_grace_s=2.0)
    return engine, fake


async def drain(engine: OpenCodeEngine, agent_turn: AgentTurn) -> list[AgentEvent]:
    events = [event async for event in engine.run(agent_turn)]
    await engine.settle_history()
    return events


def acp_start(fake: FakeOpenCode) -> dict[str, Any]:
    return next(item for item in fake.records("start") if item["argv"] == ["acp"])


# -- pure checks on the recorded OpenCode output ---------------------------------------------


def test_recorded_skaz_agent_passes_the_tool_limits_check() -> None:
    agent = PROBE["debug_agent_skaz"]
    assert limits_applied(agent)
    assert set(agent["tools"]) >= {"bash", "read", "edit", "write", "webfetch", "websearch", "task", "skill"}


@pytest.mark.parametrize("tamper", [
    lambda a: a["tools"].__setitem__("bash", True),
    lambda a: a["permission"].append({"permission": "webfetch", "action": "allow", "pattern": "*"}),
    lambda a: a["permission"].append({"permission": "*", "action": "allow", "pattern": "*"}),
    lambda a: a["permission"].append({"permission": "read", "action": "allow", "pattern": "*.md"}),
    lambda a: a["permission"].append({"permission": "skaz_*", "action": "deny", "pattern": "*"}),
    lambda a: a.__setitem__("name", "build"),
    lambda a: a.pop("tools"),
])
def test_limits_check_refuses_any_loosened_agent(tamper: Any) -> None:
    agent = copy.deepcopy(PROBE["debug_agent_skaz"])
    tamper(agent)
    assert not limits_applied(agent)


def test_credentials_are_read_from_auth_list_names_only() -> None:
    assert parse_credentials(PROBE["auth_list_anthropic"]) == ("Anthropic",)
    assert parse_credentials(PROBE["auth_list_empty"]) == ()
    with_env = (PROBE["auth_list_anthropic"]
                + "\n┌  Environment\n│\n●  OpenAI \x1b[90mOPENAI_API_KEY\n└  1 environment variable\n")
    assert parse_credentials(with_env) == ("Anthropic",)


def test_catalogue_has_efforts_and_never_the_free_provider_without_a_sign_in() -> None:
    models = parse_models(PROBE["models_verbose"])
    assert {f"{m['providerID']}/{m['id']}" for m in models} == {
        SONNET, "anthropic/claude-haiku-4-5", "opencode/big-pickle"}
    options = model_options(models, ("Anthropic",))
    assert [option.id for option in options] == ["anthropic/claude-haiku-4-5", SONNET]
    sonnet = next(option for option in options if option.id == SONNET)
    assert sonnet == ModelOption(SONNET, "Claude Sonnet 4.5", ("high", "max"))
    # OpenCode's free tier (its own provider at zero cost) refuses any client but the OpenCode app,
    # so SKAZ never offers it, signed in or not.
    signed_in = model_options(models, ("Anthropic", "OpenCode"))
    assert "opencode/big-pickle" not in {option.id for option in signed_in}


def test_free_tier_is_only_opencodes_own_zero_cost_models() -> None:
    def model(provider: str, model_id: str, cost: dict[str, Any] | None) -> dict[str, Any]:
        return {"id": model_id, "providerID": provider, "name": model_id, "cost": cost}

    models = [model("opencode", "beam-free", {"input": 0, "output": 0}),
              model("opencode", "gpt-6-luna", {"input": 0.1, "output": 0.5}),
              model("opencode", "nemotron-3-ultra-free", None),
              model("ollama", "llama", {"input": 0, "output": 0})]
    assert [o.id for o in model_options(models, ("OpenCode",))] == ["opencode/gpt-6-luna", "ollama/llama"]


def test_free_tier_refusal_is_explained() -> None:
    text = ("Internal error: OpenCode's free tier can only be used from within OpenCode. Download it at "
            "https://opencode.ai and keep building. {'service': 'session', 'errorName': 'APIError'}")
    assert classify_error(text, -32603) == ("other", FREE_TIER_NOTE)
    assert "OpenCode app" in FREE_TIER_NOTE


def test_run_config_escapes_config_substitutions() -> None:
    text = run_config_text("Use {file:~/.ssh/id_rsa} and {env:HOME}.")
    assert "{file:" not in text and "{env:" not in text
    assert json.loads(text) == {"agent": {"skaz": {"prompt": "Use {file:~/.ssh/id_rsa} and {env:HOME}."}}}


def test_folder_is_never_the_users_own_opencode(tmp_path: Path) -> None:
    home = tmp_path / "home"
    for own in (home / ".config" / "opencode", home / ".local" / "share" / "opencode", home / ".opencode"):
        with pytest.raises(ValueError):
            ensure_private_folder(own / "x", home=home)
    with pytest.raises(ValueError):
        ensure_private_folder(home / ".config", home=home)
    assert ensure_private_folder(tmp_path / "data" / "agents" / "opencode", home=home)


def test_policy_denies_everything_but_skaz_tools_and_disables_other_agents() -> None:
    assert OPENCODE_POLICY["permission"] == {"*": "deny"}
    skaz = OPENCODE_POLICY["agent"]["skaz"]
    assert skaz["permission"] == {"*": "deny", "skaz_*": "allow"} and skaz["mode"] == "primary"
    for name in ("build", "plan", "general", "explore", "title", "summary"):
        assert OPENCODE_POLICY["agent"][name] == {"disable": True}
    assert OPENCODE_POLICY["mcp"] == {} and OPENCODE_POLICY["plugin"] == []
    assert OPENCODE_POLICY["experimental"]["mcp_timeout"] == 2_147_483_647


# -- status, models, sign-in ----------------------------------------------------------------


async def test_status_is_ready_only_with_a_credential_in_skaz_folder(
        tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-should-never-reach-opencode")
    monkeypatch.setenv("OPENCODE_ENABLE_EXA", "1")
    engine, fake = engine_for(tmp_path, scenario())
    status = await engine.status()
    assert status == EngineStatus("opencode", installed=True, version="1.17.18", signed_in=True)
    starts = fake.records("start")
    assert [item["argv"] for item in starts] == [["--version"], ["debug", "agent", "skaz"], ["auth", "list"]]
    root = (tmp_path / "data" / "agents" / "opencode").resolve()
    for item in starts:
        env = item["env"]
        assert env["HOME"] == str(root / "home") and env["TMPDIR"] == str(root / "tmp")
        assert env["XDG_CONFIG_HOME"] == str(root / "config") and env["XDG_DATA_HOME"] == str(root / "data")
        assert env["XDG_CACHE_HOME"] == str(root / "cache") and env["XDG_STATE_HOME"] == str(root / "state")
        assert env["OPENCODE_DISABLE_PROJECT_CONFIG"] == "1" and env["OPENCODE_DISABLE_CLAUDE_CODE"] == "1"
        assert env["OPENCODE_DISABLE_EXTERNAL_SKILLS"] == "1" and env["OPENCODE_DISABLE_AUTOUPDATE"] == "1"
        assert json.loads(env["OPENCODE_PERMISSION"]) == {"*": "deny"}
        assert "ANTHROPIC_API_KEY" not in env and "OPENCODE_ENABLE_EXA" not in env
    policy = json.loads((root / "config" / "opencode" / "opencode.json").read_text())
    assert policy == OPENCODE_POLICY
    await engine.status()  # version and limits are remembered per binary; sign-in is asked again
    assert [item["argv"] for item in fake.records("start")][3:] == [["auth", "list"]]


async def test_status_states(tmp_path: Path) -> None:
    missing = OpenCodeEngine(tmp_path / "d0", locate_cli=lambda name: None, user_home=tmp_path / "home")
    assert (await missing.status()).reason == "OpenCode is not installed."
    signed_out, _ = engine_for(tmp_path / "a", scenario(signed_in=False))
    assert await signed_out.status() == EngineStatus("opencode", installed=True, version="1.17.18",
                                                     reason=NO_PROVIDER)
    old, _ = engine_for(tmp_path / "b", scenario(version_output="1.16.2"))
    status = await old.status()
    assert status.incompatible and status.version == "1.16.2" and "1.17.18" in (status.reason or "")
    loose = copy.deepcopy(PROBE["debug_agent_skaz"])
    loose["tools"]["websearch"] = True
    unsafe, _ = engine_for(tmp_path / "c", scenario(debug_agent=loose))
    status = await unsafe.status()
    assert status.incompatible and status.reason == LIMITS_NOT_APPLIED


async def test_models_are_opencodes_catalogue_for_signed_in_providers(tmp_path: Path) -> None:
    engine, _ = engine_for(tmp_path, scenario())
    models = await engine.models()
    assert [model.id for model in models] == ["anthropic/claude-haiku-4-5", SONNET]
    assert models[1].efforts == ("high", "max")
    signed_out, _ = engine_for(tmp_path / "out", scenario(signed_in=False))
    assert await signed_out.models() == ()


async def test_login_opens_opencode_auth_login_for_skaz_folder(tmp_path: Path) -> None:
    opener = RecordingOpener()
    engine, fake = engine_for(tmp_path, scenario(), opener=opener)
    await engine.login()
    script = Path(opener.calls[0][-1]).read_text()
    assert f"{fake.binary}" in script and "auth login" in script
    root = (tmp_path / "data" / "agents" / "opencode").resolve()
    assert str(root / "data") in script and str(root / "config") in script and str(root / "home") in script


# -- runs -----------------------------------------------------------------------------------


async def test_run_streams_over_acp_with_only_skaz_mcp_and_refuses_permissions(tmp_path: Path) -> None:
    mcp = RecordingMcp()
    engine, fake = engine_for(tmp_path, scenario(), mcp=mcp)
    events = await drain(engine, turn(effort="max"))
    assert events == [
        TextDelta("run-1", "Энтропия "),
        ToolCall("run-1", "call-1", "search", {"q": "entropy"}),
        ToolResult("run-1", "call-1", "[seg-3] dS ≥ 0", False),
        TextDelta("run-1", "растёт."),
        Completed("run-1", Usage(12, 5, cached_input_tokens=0, cache_write_tokens=0, reasoning_tokens=0)),
    ]
    initialize = fake.received("initialize")[0]["params"]
    assert initialize["clientCapabilities"] == {"fs": {"readTextFile": False, "writeTextFile": False},
                                                "terminal": False}
    new = fake.received("session/new")[0]["params"]
    assert new["mcpServers"] == [{"type": "http", "name": "skaz", "url": "http://127.0.0.1:8765/kb/mcp",
                                  "headers": [{"name": "Authorization", "value": "Bearer run-token-run-1"}]}]
    assert [m["params"] for m in fake.received("session/set_config_option")] == [
        {"sessionId": PROBE["session_new"]["sessionId"], "configId": "model", "value": SONNET},
        {"sessionId": PROBE["session_new"]["sessionId"], "configId": "effort", "value": "max"},
    ]
    prompt = fake.received("session/prompt")[0]["params"]["prompt"][0]["text"]
    assert "Earlier answer from Claude." in prompt and prompt.endswith("Current request:\nА в лекции 3?")
    assert "Answer from the SKAZ wiki only" not in prompt  # instructions go to the agent prompt
    start = acp_start(fake)
    config = json.loads(start["run_config"])
    assert config["agent"]["skaz"]["prompt"] == turn().instructions
    assert "{file:" not in start["run_config"] and "{env:" not in start["run_config"]
    reply = fake.records("permission_reply")[0]["message"]
    assert reply["result"] == {"outcome": {"outcome": "selected", "optionId": "reject"}}
    assert mcp.granted == [("run-1", ("search",))] and mcp.revoked == ["run-1"]
    deleted = fake.records("session_delete")
    assert [item["id"] for item in deleted] == [PROBE["session_new"]["sessionId"]]
    assert engine.pending_history() == []
    assert not any(engine.runs_dir.iterdir())


async def test_run_never_uses_another_model_or_effort(tmp_path: Path) -> None:
    engine, fake = engine_for(tmp_path, scenario(), mcp=RecordingMcp())
    unknown = await drain(engine, turn(model="anthropic/claude-nope"))
    assert unknown[-1] == Failed("run-1", "incompatible", MODEL_UNAVAILABLE)
    free = await drain(engine, turn("run-2", model="opencode/big-pickle"))
    assert free[-1] == Failed("run-2", "incompatible", MODEL_UNAVAILABLE)
    # OpenCode's own default is a free model of its own provider: never used silently
    default = await drain(engine, turn("run-3", model=None))
    assert default[-1] == Failed("run-3", "incompatible", CHOOSE_MODEL)
    effort = await drain(engine, turn("run-4", effort="xhigh"))
    assert effort[-1] == Failed("run-4", "incompatible", EFFORT_UNAVAILABLE)
    assert fake.received("session/prompt") == []


async def test_a_free_tier_model_is_refused_before_anything_is_sent(tmp_path: Path) -> None:
    # Signed in to OpenCode itself: its free models are listed by OpenCode but only work in its app.
    signed = PROBE["auth_list_anthropic"].replace("Anthropic", "OpenCode") + PROBE["auth_list_anthropic"]
    engine, fake = engine_for(tmp_path, scenario(auth_list=signed), mcp=RecordingMcp())
    free = await drain(engine, turn(model="opencode/big-pickle"))
    assert free[-1] == Failed("run-1", "other", FREE_TIER_NOTE)
    assert fake.received("session/prompt") == []


async def test_run_without_sign_in_or_limits_starts_nothing(tmp_path: Path) -> None:
    engine, fake = engine_for(tmp_path, scenario(signed_in=False), mcp=RecordingMcp())
    assert (await drain(engine, turn()))[-1] == Failed("run-1", "auth", NO_PROVIDER)
    loose = copy.deepcopy(PROBE["debug_agent_skaz"])
    loose["permission"].append({"permission": "bash", "action": "allow", "pattern": "*"})
    unsafe, unsafe_fake = engine_for(tmp_path / "u", scenario(debug_agent=loose), mcp=RecordingMcp())
    assert (await drain(unsafe, turn()))[-1] == Failed("run-1", "incompatible", LIMITS_NOT_APPLIED)
    assert not [s for s in fake.records("start") + unsafe_fake.records("start") if s["argv"] == ["acp"]]


async def test_a_tool_outside_skaz_stops_the_run(tmp_path: Path) -> None:
    bash = {"sessionUpdate": "tool_call", "toolCallId": "call-x", "title": "ls ~", "kind": "execute",
            "status": "pending", "locations": [], "rawInput": {"command": "ls ~"}}
    engine, fake = engine_for(tmp_path, scenario(updates=[bash], hang=True), mcp=RecordingMcp())
    events = await asyncio.wait_for(drain(engine, turn()), 20)
    assert events == [Failed("run-1", "incompatible", LIMITS_NOT_APPLIED)]
    assert fake.received("session/cancel")


async def test_interrupt_cancels_the_session(tmp_path: Path) -> None:
    chunk = {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "Начало"}}
    engine, fake = engine_for(tmp_path, scenario(updates=[chunk], hang=True), mcp=RecordingMcp())
    stream = engine.run(turn())
    first = await stream.__anext__()
    assert first == TextDelta("run-1", "Начало")
    await engine.interrupt("run-1")
    rest = [event async for event in stream]
    assert rest == [Failed("run-1", "cancelled", "The answer was stopped.")]
    assert fake.received("session/cancel")[0]["params"] == {"sessionId": PROBE["session_new"]["sessionId"]}


async def test_slash_request_is_never_an_opencode_command(tmp_path: Path) -> None:
    engine, fake = engine_for(tmp_path, scenario(updates=[]))
    slash = AgentTurn("run-1", (TurnMessage("user", "/init"),), "x", None, model=SONNET)
    assert isinstance((await drain(engine, slash))[-1], Completed)
    text = fake.received("session/prompt")[0]["params"]["prompt"][0]["text"]
    assert not text.startswith("/") and text.endswith("/init")


async def test_provider_errors_are_classified(tmp_path: Path) -> None:
    error = {"code": -32000, "message": "Authentication required", "data": {"providerId": "anthropic"}}
    engine, _ = engine_for(tmp_path, scenario(updates=[], prompt_error=error))
    failed = (await drain(engine, turn(tools=None)))[-1]
    assert isinstance(failed, Failed) and failed.kind == "auth"
    limit = {"code": -32603, "message": "Internal error", "data": {"details": "429 rate limit exceeded"}}
    engine, _ = engine_for(tmp_path / "l", scenario(updates=[], prompt_error=limit))
    failed = (await drain(engine, turn(tools=None)))[-1]
    assert isinstance(failed, Failed) and failed.kind == "limit"


async def test_undeleted_sessions_are_retried_at_start(tmp_path: Path) -> None:
    engine, _fake = engine_for(tmp_path, scenario(updates=[], delete_exit=1))
    await drain(engine, turn(tools=None))
    assert engine.pending_history() == [PROBE["session_new"]["sessionId"]]
    again, _ = engine_for(tmp_path, scenario(updates=[]))
    assert again.sweep_at_start()
    await again.settle_history()
    assert again.pending_history() == []


# -- registry and hub ---------------------------------------------------------------------


def test_opencode_is_a_registered_agent() -> None:
    assert ENGINE_IDS == ("codex", "claude_code", "hermes", "opencode")
    assert ENGINE_NAMES["opencode"] == "OpenCode"


async def test_hub_lists_opencode_and_signs_in_through_opencode(
        service: KnowledgeService, tmp_path: Path) -> None:
    engine, _fake = engine_for(tmp_path, scenario(signed_in=False))
    hub = build_agents_hub(tmp_path / "data", settings=service.settings, codex=None,  # type: ignore[arg-type]
                           engines={"codex": FakeEngine("codex"), "claude_code": FakeEngine("claude_code"),
                                    "hermes": FakeEngine("hermes"), "opencode": engine},
                           locate_cli=lambda name: None, user_home=tmp_path / "home")
    view = await hub.registry.view("opencode")
    assert view.name == "OpenCode" and view.state == "signed_out" and view.action == "login"
    outcome = await hub.registry.login("opencode")
    assert outcome.method == "terminal" and "sign in to a model provider" in outcome.message


async def test_hub_without_an_opencode_double_shows_it_not_installed(
        service: KnowledgeService, tmp_path: Path) -> None:
    hub = build_agents_hub(tmp_path / "data", settings=service.settings, codex=None,  # type: ignore[arg-type]
                           engines={"codex": FakeEngine("codex"), "claude_code": FakeEngine("claude_code"),
                                    "hermes": FakeEngine("hermes")},
                           locate_cli=lambda name: None, user_home=tmp_path / "home")
    view = await hub.registry.view("opencode")
    assert view.state == "not_installed" and view.action == "install"


def test_picker_groups_opencode_models_by_their_provider() -> None:
    from skaz.knowledge.agents.model_prefs import display

    shown = display("opencode", ModelOption(SONNET, "Claude Sonnet 4.5", ("high", "max")), "OpenCode")
    assert (shown.provider, shown.provider_label) == ("anthropic", "Anthropic")
    assert shown.name == "Claude Sonnet 4.5"
    twin = display("opencode", ModelOption("openrouter/x/sonnet", "Claude Sonnet 4.5 · openrouter"),
                   "OpenCode")
    assert (twin.provider, twin.name) == ("openrouter", "Claude Sonnet 4.5")


# -- v2.3.0 shapes supplied by the offline binary probe in the F5 brief ---------------------

V2_AGENT: dict[str, Any] = {
    "id": "skaz", "name": "skaz", "mode": "primary", "hidden": False,
    "permissions": [
        {"action": "*", "resource": "*", "effect": "allow"},
        {"action": "read", "resource": "*.env", "effect": "ask"},
        {"action": "*", "resource": "*", "effect": "deny"},
        {"action": "skaz_*", "resource": "*", "effect": "allow"},
        {"action": "browser", "resource": "*", "effect": "deny"},
        {"action": "skill", "resource": "browser", "effect": "deny"},
    ],
}
V2_CREDENTIALS = [
    {"id": "openrouter", "name": "OpenRouter", "connections": [
        {"type": "credential", "id": "cred_fake", "label": "API key", "method": "key"}]},
    {"id": "opencode", "name": "OpenCode", "connections": [{"type": "env"}]},
]
V2_ID = "openrouter/google/gemini-4-hydrogen"
V2_MODEL: dict[str, Any] = {
    "id": "google/gemini-4-hydrogen", "modelID": "google/gemini-4-hydrogen",
    "providerID": "openrouter", "name": "Gemini 4 Hydrogen", "enabled": True,
    "variants": [{"id": effort, "settings": {"reasoning": {"effort": effort}}}
                 for effort in ("low", "medium", "high", "xhigh")],
    "cost": [{"input": 1.5, "output": 7.5, "cache": {"read": 0.075, "write": 0.083333}}],
}


def v2_scenario(**overrides: Any) -> dict[str, Any]:
    plan: dict[str, Any] = json.loads(json.dumps(scenario()).replace(SONNET, V2_ID))
    updates = copy.deepcopy(UPDATES)
    for update in updates:
        if isinstance(update, dict) and update.get("title") == "skaz_search":
            update.update(name="skaz_search", title="Search the SKAZ library")
    plan.update(version_output="opencode v2.3.0", debug_agents=[
        {"id": "compaction", "name": "Compaction", "mode": "primary", "hidden": True},
        copy.deepcopy(V2_AGENT),
    ], auth_list=json.dumps(V2_CREDENTIALS),
        model_list={"location": {"directory": "/isolated"}, "data": [copy.deepcopy(V2_MODEL)]},
        updates=updates)
    plan.update(overrides)
    return plan


@pytest.mark.parametrize(("text", "expected"), [
    ("opencode v2.3.0\n", (2, 3, 0)), ("opencode v2.0.0", (2, 0, 0)),
    ("1.17.18\n", (1, 17, 18)), ("v1.17.19", (1, 17, 19)), ("unreadable", None),
])
def test_v2_version_prefix_and_v1_versions(text: str, expected: tuple[int, int, int] | None) -> None:
    assert parse_opencode_version(text) == expected


def test_v2_limits_accept_trailing_browser_and_scoped_skill_denials() -> None:
    assert limits_applied(V2_AGENT)


@pytest.mark.parametrize("rule", [
    {"action": "read", "resource": "*", "effect": "allow"},
    {"action": "skill", "resource": "browser", "effect": "allow"},
    {"action": "skill", "resource": "browser", "effect": "ask"},
    {"action": "execute", "resource": "*", "effect": "allow"},
    {"action": "unrelated_server_tool", "resource": "*", "effect": "allow"},
    {"action": "*", "resource": "*", "effect": "allow"},
    {"action": "skaz_*", "resource": "*", "effect": "deny"},
])
def test_v2_limits_refuse_loosened_permissions(rule: dict[str, str]) -> None:
    agent = copy.deepcopy(V2_AGENT)
    agent["permissions"].append(rule)
    assert not limits_applied(agent)


@pytest.mark.parametrize("effect", ["allow", "ask"])
def test_v2_scoped_deny_does_not_hide_a_previous_scoped_grant(effect: str) -> None:
    agent = copy.deepcopy(V2_AGENT)
    agent["permissions"].extend([
        {"action": "skill", "resource": "other", "effect": effect},
        {"action": "skill", "resource": "browser", "effect": "deny"},
    ])
    assert not limits_applied(agent)


def test_v2_credentials_ignore_environment_connections_and_use_provider_ids() -> None:
    assert parse_credentials(json.dumps(V2_CREDENTIALS)) == ("openrouter",)
    assert parse_credentials("Provider    Connection    Source\nOpenRouter  API key  stored\n"
                             "OpenCode    API key  environment\n") == ("OpenRouter",)
    assert parse_credentials('[{"id": "opencode", "connections": [{"type": "credential"}]}]') == (
        "opencode",)
    assert provider_allowed("opencode/paid", ("opencode",))
    assert provider_allowed("opencode/paid", ("OpenCode",))
    assert not provider_allowed("opencode/paid", ("openrouter",))


@pytest.mark.parametrize("text", ["[]", "[invalid", '[null, 2, {"id": "x", "connections": [null]}]'])
def test_v2_malformed_or_empty_credentials_are_not_a_sign_in(text: str) -> None:
    assert parse_credentials(text) == ()


@pytest.mark.parametrize("wrapped", [True, False])
def test_v2_model_catalogue_has_list_variants_and_ignores_disabled_models(wrapped: bool) -> None:
    models = [V2_MODEL, {**V2_MODEL, "id": "disabled", "enabled": False}, {"id": "incomplete"}]
    parsed = parse_models(json.dumps({"location": {}, "data": models} if wrapped else models))
    assert parsed == [V2_MODEL]
    assert model_options(parsed, ("openrouter",)) == (
        ModelOption(V2_ID, "Gemini 4 Hydrogen", ("low", "medium", "high", "xhigh")),)


def test_v2_model_variants_ignore_default_and_malformed_entries() -> None:
    model = {**V2_MODEL, "variants": [{"id": "default"}, {"id": "high"}, None, {"id": 3}, {}]}
    assert model_options([model], ("openrouter",))[0].efforts == ("high",)


@pytest.mark.parametrize(("provider", "model_id", "cost", "expected"), [
    ("opencode", "free", [{"input": 0, "output": 0}], True),
    ("opencode", "paid", [{"input": 1, "output": 0}], False),
    ("opencode", "mixed", [{"input": 0, "output": 0}, {"input": 1, "output": 1}], False),
    ("opencode", "unknown", [], False), ("opencode", "unknown", [None], False),
    ("opencode", "model-free", [], True),
    ("ollama", "free", [{"input": 0, "output": 0}], False),
])
def test_v2_free_tier_cost_lists(provider: str, model_id: str, cost: Any, expected: bool) -> None:
    assert free_tier({"providerID": provider, "id": model_id, "cost": cost}) is expected


async def test_v2_status_models_and_run_use_standalone_and_direct_mcp(tmp_path: Path) -> None:
    mcp = RecordingMcp()
    engine, fake = engine_for(tmp_path, v2_scenario(), mcp=mcp)
    assert await engine.status() == EngineStatus("opencode", installed=True, version="2.3.0", signed_in=True)
    assert await engine.models() == (
        ModelOption(V2_ID, "Gemini 4 Hydrogen", ("low", "medium", "high", "xhigh")),)
    events = await drain(engine, turn(model=V2_ID, effort="high"))
    assert isinstance(events[-1], Completed)
    assert [event for event in events if isinstance(event, ToolCall)] == [
        ToolCall("run-1", "call-1", "search", {"q": "entropy"})]
    assert any(isinstance(event, ToolResult) for event in events)
    args = [item["argv"] for item in fake.records("start")]
    assert args[:3] == [["--version"], ["debug", "agents", "--standalone"],
                        ["auth", "list", "--format", "json", "--standalone"]]
    assert ["api", "model.list", "--standalone"] in args
    assert ["session", "delete", PROBE["session_new"]["sessionId"], "--standalone"] in args
    config = json.loads(acp_start(fake)["run_config"])
    assert config["mcp"] == {"skaz": {"type": "remote", "url": "http://127.0.0.1:8765/kb/mcp",
                                      "headers": {"Authorization": "Bearer run-token-run-1"},
                                      "oauth": False, "codemode": False}}
    assert config["agent"]["skaz"]["prompt"] == turn().instructions
    assert "{file:" not in acp_start(fake)["run_config"] and "{env:" not in acp_start(fake)["run_config"]
    assert json.loads(engine.policy_file.read_text()) == OPENCODE_POLICY
    assert mcp.revoked == ["run-1"] and not engine.pending_history()


@pytest.mark.parametrize("extra", [
    {"id": "build", "name": "Build", "mode": "primary", "hidden": False},
    {"id": "general", "name": "General", "mode": "subagent"},
    {"id": "other", "name": "Other", "mode": "primary", "hidden": False},
])
async def test_v2_refuses_other_visible_agents(tmp_path: Path, extra: dict[str, Any]) -> None:
    engine, fake = engine_for(tmp_path, v2_scenario(debug_agents=[V2_AGENT, extra]), mcp=RecordingMcp())
    assert (await engine.status()).reason == LIMITS_NOT_APPLIED
    assert (await drain(engine, turn(model=V2_ID)))[-1] == Failed("run-1", "incompatible", LIMITS_NOT_APPLIED)
    assert not fake.received("session/prompt")


@pytest.mark.parametrize("agents", [[], [V2_AGENT, V2_AGENT], [None], {"skaz": V2_AGENT}])
async def test_v2_requires_one_resolved_skaz_agent(tmp_path: Path, agents: Any) -> None:
    engine, _ = engine_for(tmp_path, v2_scenario(debug_agents=agents))
    assert (await engine.status()).reason == LIMITS_NOT_APPLIED


async def test_v2_env_only_provider_is_signed_out(tmp_path: Path) -> None:
    engine, fake = engine_for(tmp_path, v2_scenario(auth_list=json.dumps(V2_CREDENTIALS[1:])))
    assert (await engine.status()).reason == NO_PROVIDER
    assert await engine.models() == ()
    assert (await drain(engine, turn(model=V2_ID, tools=None)))[-1] == Failed("run-1", "auth", NO_PROVIDER)
    assert not fake.received("session/new")


async def test_v2_logout_uses_each_stored_provider_id_once(tmp_path: Path) -> None:
    signed = [*V2_CREDENTIALS, {"id": "opencode", "name": "OpenCode", "connections": [
        {"type": "credential"}]}]
    engine, fake = engine_for(tmp_path, v2_scenario(auth_list=json.dumps(signed)))
    await engine.logout()
    assert [item["argv"] for item in fake.records("start") if item["argv"][:2] == ["auth", "logout"]] == [
        ["auth", "logout", "openrouter", "--standalone"], ["auth", "logout", "opencode", "--standalone"]]
    assert await engine.credentials() == ()


async def test_v2_login_uses_standalone(tmp_path: Path) -> None:
    opener = RecordingOpener()
    engine, _ = engine_for(tmp_path, v2_scenario(), opener=opener)
    await engine.login()
    assert "auth login --standalone" in Path(opener.calls[0][3]).read_text()


@pytest.mark.parametrize("sweep", [False, True])
async def test_v2_session_delete_detects_version_before_first_status(tmp_path: Path, sweep: bool) -> None:
    engine, fake = engine_for(tmp_path, v2_scenario())
    if sweep:
        engine.prepare()
        engine.history_file.write_text(json.dumps({"sessions": {"ses_old": 0}}))
        assert engine.sweep_at_start()
        await engine.settle_history()
    else:
        await engine.delete_session("ses_old")
    assert ["session", "delete", "ses_old", "--standalone"] in [s["argv"] for s in fake.records("start")]
    assert not engine.pending_history()


async def test_v2_continue_refreshes_mcp_access_and_preserves_start_instructions(tmp_path: Path) -> None:
    engine, fake = engine_for(tmp_path, v2_scenario(), mcp=RecordingMcp())
    first = turn(model=V2_ID, session=SessionPlan("start"))
    assert isinstance((await drain(engine, first))[-1], Completed)
    session_id = PROBE["session_new"]["sessionId"]
    kept = (engine.sessions_dir / f"{session_id}.json").read_text()
    assert "run-token" not in kept
    again = replace(turn("run-2", model=V2_ID, session=SessionPlan("continue", session_id)),
                    instructions="Changed later instructions.")
    assert isinstance((await drain(engine, again))[-1], Completed)
    starts = [item for item in fake.records("start") if item["argv"] == ["acp"]]
    config = json.loads(starts[-1]["run_config"])
    assert config["mcp"]["skaz"]["codemode"] is False
    assert config["mcp"]["skaz"]["headers"]["Authorization"] == "Bearer run-token-run-2"
    assert config["agent"]["skaz"]["prompt"] == first.instructions
    assert fake.received("session/resume")[-1]["params"]["mcpServers"][0]["headers"][0]["value"] == (
        "Bearer run-token-run-2")
    await engine.delete_session(session_id)


async def test_v2_tool_technical_name_takes_precedence_over_title(tmp_path: Path) -> None:
    update = {"sessionUpdate": "tool_call", "toolCallId": "outside", "name": "execute",
              "title": "skaz_search", "status": "in_progress", "rawInput": {"code": "x"}}
    engine, fake = engine_for(tmp_path, v2_scenario(updates=[update], hang=True), mcp=RecordingMcp())
    assert await drain(engine, turn(model=V2_ID)) == [Failed("run-1", "incompatible", LIMITS_NOT_APPLIED)]
    assert fake.received("session/cancel")


async def test_v2_run_without_tools_needs_no_mcp_config(tmp_path: Path) -> None:
    engine, fake = engine_for(tmp_path, v2_scenario(updates=[]))
    assert isinstance((await drain(engine, turn(model=V2_ID, tools=None)))[-1], Completed)
    assert "mcp" not in json.loads(acp_start(fake)["run_config"])
    assert fake.received("session/new")[0]["params"]["mcpServers"] == []


async def test_v2_free_tier_is_refused_from_api_catalogue_before_acp(tmp_path: Path) -> None:
    signed = [{"id": "opencode", "name": "OpenCode", "connections": [{"type": "credential"}]}]
    free = {**V2_MODEL, "providerID": "opencode", "id": "zero-cost", "cost": [{"input": 0, "output": 0}]}
    engine, fake = engine_for(tmp_path, v2_scenario(auth_list=json.dumps(signed),
                                                  model_list={"data": [free]}))
    assert await drain(engine, turn(model="opencode/zero-cost", tools=None)) == [
        Failed("run-1", "other", FREE_TIER_NOTE)]
    assert not fake.received("initialize")
