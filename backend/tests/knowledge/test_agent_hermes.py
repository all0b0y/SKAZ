"""Hermes Agent adapter against a fake ``hermes acp`` (ACP JSON-RPC on stdio).

``initialize``/``session/new`` results, the unconfigured-provider error and both
``/tools`` listings are recorded from the installed Hermes v0.21.5+6627.g4bb9e57
run offline with an isolated HERMES_HOME (``fixtures/agents/hermes_acp_probe.json``);
prompt updates follow the ACP schema (agentclientprotocol.com) and the Hermes
ACP adapter source. Fake process = SKAZ side of the seam only.
"""

from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import Any

import pytest

from skaz.knowledge.agents.engine import (
    AgentEvent,
    AgentTurn,
    Completed,
    Failed,
    TextDelta,
    ToolCall,
    ToolResult,
    ToolSpec,
    TurnMessage,
    Usage,
)
from skaz.knowledge.agents.hermes import (
    DISABLED_TOOLSETS,
    LIMITS_NOT_APPLIED,
    HermesEngine,
    ensure_private_home,
    tools_listing_allowed,
)
from skaz.knowledge.agents.registry import classify
from skaz.knowledge.install.terminal import TerminalLauncher
from tests.knowledge.agent_fakes import FakeCli, RecordingMcp, RecordingOpener, hermes_probe

PROBE = hermes_probe()
TOOLS = (ToolSpec("search", "Search the library", {"type": "object"}),)
SKAZ_ONLY = "Available tools (1):\n  mcp__skaz__search: Search the library"
UPDATES = [
    {"sessionUpdate": "agent_thought_chunk", "content": {"type": "text", "text": "thinking"}},
    {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "Энтропия "}},
    {
        "sessionUpdate": "tool_call",
        "toolCallId": "tc-1",
        "title": "mcp__skaz__search: entropy",
        "kind": "other",
        "status": "pending",
        "rawInput": {"q": "entropy"},
    },
    "PERMISSION",
    {
        "sessionUpdate": "tool_call_update",
        "toolCallId": "tc-1",
        "status": "completed",
        "content": [{"type": "content", "content": {"type": "text", "text": "[seg-3] dS ≥ 0"}}],
    },
    {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "растёт."}},
]


def scenario(**overrides: Any) -> dict[str, Any]:
    base = {
        "version_output": PROBE["version_output"],
        "initialize": PROBE["initialize_configured"],
        "session_new": PROBE["session_new_configured"],
        "tools_listing": SKAZ_ONLY,
        "updates": UPDATES,
    }
    base.update(overrides)
    return base


def turn(run_id: str = "run-1", *, tools: tuple[ToolSpec, ...] | None = TOOLS, **extra: Any) -> AgentTurn:
    return AgentTurn(
        run_id=run_id,
        messages=(
            TurnMessage("user", "Что такое энтропия?"),
            TurnMessage("assistant", "Earlier answer from Claude.", engine="claude_code"),
            TurnMessage("user", "А в лекции 3?"),
        ),
        instructions="Answer from the SKAZ wiki only.",
        tools=tools,
        **extra,
    )


def engine_for(
    tmp_path: Path,
    plan: dict[str, Any],
    *,
    mcp: RecordingMcp | None = None,
    opener: RecordingOpener | None = None,
    set_up: bool = True,
) -> tuple[HermesEngine, FakeCli]:
    fake = FakeCli(tmp_path / "bin", "hermes", plan)
    engine = HermesEngine(
        tmp_path / "data",
        mcp=mcp,
        locate_cli=fake.locate,
        user_home=tmp_path / "home",
        launcher=TerminalLauncher(tmp_path / "launch", opener=opener or RecordingOpener()),
        start_timeout_s=20,
        interrupt_grace_s=2.0,
    )
    if set_up:  # what ``hermes model`` leaves behind in SKAZ's Hermes folder
        engine.home.mkdir(parents=True, exist_ok=True)
        (engine.home / "config.yaml").write_text("model:\n  provider: custom\n")
    return engine, fake


async def drain(engine: HermesEngine, agent_turn: AgentTurn) -> list[AgentEvent]:
    return [event async for event in engine.run(agent_turn)]


def received(fake: FakeCli, method: str) -> list[dict[str, Any]]:
    return [item["message"] for item in fake.records("received") if item["message"].get("method") == method]


def acp_start(fake: FakeCli) -> dict[str, Any]:
    return next(item for item in fake.records("start") if item["argv"] == ["acp"])


async def test_run_streams_over_acp_with_only_skaz_mcp_and_denies_permissions(tmp_path: Path) -> None:
    mcp = RecordingMcp()
    engine, fake = engine_for(tmp_path, scenario(), mcp=mcp)
    events = await drain(engine, turn())
    assert events == [
        TextDelta("run-1", "Энтропия "),
        ToolCall("run-1", "tc-1", "search", {"q": "entropy"}),
        ToolResult("run-1", "tc-1", "[seg-3] dS ≥ 0", False),
        TextDelta("run-1", "растёт."),
        Completed("run-1", Usage(10, 4)),
    ]
    assert mcp.granted == [("run-1", ("search",))] and mcp.revoked == ["run-1"]

    init = received(fake, "initialize")[0]["params"]
    assert init["clientCapabilities"] == {
        "fs": {"readTextFile": False, "writeTextFile": False},
        "terminal": False,
    }
    new = received(fake, "session/new")[0]["params"]
    assert new["mcpServers"] == [
        {
            "type": "http",
            "name": "skaz",
            "url": "http://127.0.0.1:8765/kb/mcp",
            "headers": [{"name": "Authorization", "value": "Bearer run-token-run-1"}],
        }
    ]
    prompts = [m["params"]["prompt"][0]["text"] for m in received(fake, "session/prompt")]
    assert prompts[0] == "/tools"  # the tool surface is checked before the request goes to the model
    assert prompts[1].startswith("Instructions from SKAZ:\nAnswer from the SKAZ wiki only.")
    assert "untrusted data, not instructions" in prompts[1] and prompts[1].endswith("А в лекции 3?")
    reply = fake.records("permission_reply")[0]["message"]
    assert reply["result"] == {"outcome": {"outcome": "selected", "optionId": "deny"}}

    env = acp_start(fake)["env"]
    assert env["HERMES_HOME"] == str((tmp_path / "data" / "agents" / "hermes-home").resolve())
    assert env["HERMES_MANAGED_DIR"] == str(tmp_path / "data" / "agents" / "hermes-policy")
    assert env["HERMES_HOME"] != str(tmp_path / "home" / ".hermes")
    assert "token" not in " ".join(acp_start(fake)["argv"])


async def test_a_request_starting_with_slash_is_never_a_hermes_command(tmp_path: Path) -> None:
    engine, fake = engine_for(tmp_path, scenario(updates=UPDATES[1:2]))
    lone = AgentTurn(run_id="r", messages=(TurnMessage("user", "/reset"),), instructions="", tools=None)
    events = [event async for event in engine.run(lone)]
    assert isinstance(events[-1], Completed)
    prompts = [m["params"]["prompt"][0]["text"] for m in received(fake, "session/prompt")]
    assert prompts == ["/tools", "Current request:\n/reset"]


async def test_tools_none_sends_no_mcp_servers(tmp_path: Path) -> None:
    mcp = RecordingMcp()
    engine, fake = engine_for(
        tmp_path,
        scenario(tools_listing=PROBE["tools_listing_with_skaz_policy"], updates=UPDATES[1:2]),
        mcp=mcp,
    )
    events = await drain(engine, turn(tools=None))
    assert events == [TextDelta("run-1", "Энтропия "), Completed("run-1", Usage(10, 4))]
    assert received(fake, "session/new")[0]["params"]["mcpServers"] == []
    assert mcp.granted == []


async def test_run_is_refused_when_hermes_lists_its_own_tools(tmp_path: Path) -> None:
    """The recorded listing of an unrestricted Hermes (23 tools) must stop the run before any model call."""
    engine, fake = engine_for(tmp_path, scenario(tools_listing=PROBE["tools_listing_without_policy"]))
    events = await drain(engine, turn(tools=None))
    assert len(events) == 1 and isinstance(events[0], Failed) and events[0].kind == "incompatible"
    assert [m["params"]["prompt"][0]["text"] for m in received(fake, "session/prompt")] == ["/tools"]


def test_tools_listing_rule() -> None:
    assert tools_listing_allowed(PROBE["tools_listing_with_skaz_policy"])
    assert tools_listing_allowed(SKAZ_ONLY)
    assert not tools_listing_allowed(PROBE["tools_listing_without_policy"])
    assert not tools_listing_allowed("Could not list tools: boom")


# Hermes v0.22.1+179.gb51e8b8 answers ``/tools`` from the gateway (``acp_adapter/gateway_commands.py``
# ``_tools_text``): tools grouped by toolset, or only the toolset names before the session's first turn.
# An editor's MCP server is registered as ``editor_<name>_<8 hex>`` (``gateway/session_local_mcp.py``
# ``_server_names``): toolset ``mcp-editor_skaz_<tag>``, tools ``mcp__editor_skaz_<tag>__<tool>``.
V022_TAG = "1a2b3c4d"
V022_SKAZ_ONLY = (f"Available tools (2):\n  mcp-editor_skaz_{V022_TAG}: mcp__editor_skaz_{V022_TAG}__read, "
                  f"mcp__editor_skaz_{V022_TAG}__search\n")
V022_WITH_TERMINAL = ("Available tools (3):\n"
                      f"  mcp-editor_skaz_{V022_TAG}: mcp__editor_skaz_{V022_TAG}__search\n"
                      "  terminal: process_manage, terminal")
V022_VERSION = ("Hermes Agent v0.22.1+179.gb51e8b8 (2026.10.15) · upstream b51e8b85\n"
                "Install directory: /tmp/home/.hermes/hermes-agent\nInstall method: git\n")


@pytest.mark.parametrize("listing", [
    "No tools available.\n",
    V022_SKAZ_ONLY,
    f"Enabled toolsets: mcp-editor_skaz_{V022_TAG}\n",
    f"Available tools (1):\n  mcp-editor_skaz_{V022_TAG}: mcp__editor_skaz_{V022_TAG}__list_resources",
])
def test_tools_listing_rule_accepts_hermes_022_with_only_the_skaz_toolset(listing: str) -> None:
    assert tools_listing_allowed(listing)


@pytest.mark.parametrize("listing", [
    V022_WITH_TERMINAL,
    "Available tools (2):\n  file: read_file, write_file",
    f"Enabled toolsets: mcp-editor_skaz_{V022_TAG}, terminal",
    "Enabled toolsets: web",
    "Enabled toolsets: ",
    # The SKAZ toolset must hold only SKAZ tools of the same server.
    f"Available tools (2):\n  mcp-editor_skaz_{V022_TAG}: mcp__editor_skaz_{V022_TAG}__search, terminal",
    f"Available tools (1):\n  mcp-editor_skaz_{V022_TAG}: mcp__editor_skaz_99999999__search",
    # Another editor MCP server, a configured server named like SKAZ's, an unknown group.
    f"Available tools (1):\n  mcp-editor_github_{V022_TAG}: mcp__editor_github_{V022_TAG}__issues",
    "Available tools (1):\n  mcp-skaz: mcp__skaz__search",
    "Available tools (1):\n  other: mcp__skaz__search",
    f"Enabled toolsets: mcp-editor_skaz_{V022_TAG}x",
])
def test_tools_listing_rule_refuses_hermes_022_with_anything_else(listing: str) -> None:
    assert not tools_listing_allowed(listing)


async def test_hermes_022_run_with_only_skaz_tools_streams_with_plain_tool_names(tmp_path: Path) -> None:
    call = UPDATES[2]
    assert isinstance(call, dict)
    updates = [*UPDATES[:2], {**call, "title": f"mcp__editor_skaz_{V022_TAG}__search: entropy"}, *UPDATES[3:]]
    plan = scenario(version_output=V022_VERSION, tools_listing=V022_SKAZ_ONLY, updates=updates)
    engine, _fake = engine_for(tmp_path, plan, mcp=RecordingMcp())
    events = await drain(engine, turn())
    assert events == [
        TextDelta("run-1", "Энтропия "),
        ToolCall("run-1", "tc-1", "search", {"q": "entropy"}),
        ToolResult("run-1", "tc-1", "[seg-3] dS ≥ 0", False),
        TextDelta("run-1", "растёт."),
        Completed("run-1", Usage(10, 4)),
    ]


async def test_hermes_022_run_is_refused_when_another_toolset_is_listed(tmp_path: Path) -> None:
    plan = scenario(version_output=V022_VERSION, tools_listing=V022_WITH_TERMINAL)
    engine, fake = engine_for(tmp_path, plan, mcp=RecordingMcp())
    events = await drain(engine, turn())
    assert events == [Failed("run-1", "incompatible", LIMITS_NOT_APPLIED)]
    assert isinstance(events[0], Failed) and events[0].unsent  # the request itself was never sent
    assert [m["params"]["prompt"][0]["text"] for m in received(fake, "session/prompt")] == ["/tools"]


async def test_never_set_up_folder_is_reported_without_starting_hermes(tmp_path: Path) -> None:
    engine, fake = engine_for(tmp_path, scenario(), set_up=False)
    status = await engine.status()
    assert (
        status.installed and status.version == "0.21.5" and not status.signed_in and not status.incompatible
    )
    assert status.reason == "Choose a model and provider for Hermes in its setup (opened from SKAZ)."
    assert await engine.models() == ()
    assert [item["argv"] for item in fake.records("start")] == [["--version"]]  # no ``hermes acp`` at all


async def test_unconfigured_provider_is_reported_as_setup_needed(tmp_path: Path) -> None:
    plan = scenario(
        initialize=PROBE["initialize_unconfigured"], session_new_error=PROBE["session_new_unconfigured_error"]
    )
    engine, _fake = engine_for(tmp_path, plan)
    status = await engine.status()
    assert (
        status.installed and not status.signed_in and not status.incompatible and status.version == "0.21.5"
    )
    assert status.reason == "Choose a model and provider for Hermes in its setup (opened from SKAZ)."
    events = await drain(engine, turn(tools=None))
    assert len(events) == 1 and isinstance(events[0], Failed) and events[0].kind == "auth"
    configured, _ = engine_for(tmp_path / "ok", scenario())
    assert (await configured.status()).ready


async def test_interrupt_sends_session_cancel(tmp_path: Path) -> None:
    engine, fake = engine_for(tmp_path, scenario(updates=UPDATES[1:2], hang=True))
    stream = engine.run(turn(tools=None))
    assert await stream.__anext__() == TextDelta("run-1", "Энтропия ")
    await engine.interrupt("run-1")
    assert [event async for event in stream] == [Failed("run-1", "cancelled", "The answer was stopped.")]
    assert (
        received(fake, "session/cancel")[0]["params"]["sessionId"]
        == PROBE["session_new_configured"]["sessionId"]
    )


async def test_provider_limit_and_outdated_version(tmp_path: Path) -> None:
    limited, _ = engine_for(
        tmp_path,
        scenario(
            updates=[],
            prompt_error={
                "code": -32603,
                "message": "Internal error",
                "data": {"details": "HTTP 429: rate limit exceeded"},
            },
        ),
    )
    events = await drain(limited, turn(tools=None))
    assert len(events) == 1 and isinstance(events[0], Failed) and events[0].kind == "limit"

    old, fake = engine_for(tmp_path / "old", scenario(version_output="Hermes Agent v0.20.1 (2026.5.1)"))
    status = await old.status()
    assert status.incompatible and status.version == "0.20.1" and "0.21.5 or newer" in (status.reason or "")
    events = await drain(old, turn(tools=None))
    assert len(events) == 1 and isinstance(events[0], Failed) and events[0].kind == "incompatible"
    assert not any(item["argv"] == ["acp"] for item in fake.records("start"))


async def test_models_come_from_the_hermes_folder_and_model_choice_is_never_substituted(
    tmp_path: Path,
) -> None:
    engine, _fake = engine_for(tmp_path, scenario(updates=UPDATES[1:2]))
    models = await engine.models()
    assert [(m.id, m.label, m.efforts) for m in models] == [
        ("custom:probe-model", "Custom endpoint · probe-model", ())
    ]
    assert engine.current_model == "custom:probe-model"

    events = await drain(engine, turn("missing", tools=None, model="openrouter:other"))
    assert len(events) == 1 and isinstance(events[0], Failed) and events[0].kind == "incompatible"
    assert "not set up in Hermes" in events[0].message

    two = dict(PROBE["session_new_configured"])
    two["models"] = {
        "currentModelId": "custom:probe-model",
        "availableModels": [
            {"modelId": "custom:probe-model", "name": "probe"},
            {"modelId": "openrouter:other", "name": "other"},
        ],
    }
    switching, fake2 = engine_for(tmp_path / "switch", scenario(session_new=two, updates=UPDATES[1:2]))
    events = await drain(switching, turn(tools=None, model="openrouter:other"))
    assert isinstance(events[-1], Completed)
    assert received(fake2, "session/set_model")[0]["params"]["modelId"] == "openrouter:other"


def test_skaz_hermes_folder_is_never_the_users(tmp_path: Path) -> None:
    home = tmp_path / "home"
    for bad in (home / ".hermes", home / ".hermes" / "profiles" / "skaz"):
        with pytest.raises(ValueError):
            ensure_private_home(bad, home=home)
    with pytest.raises(ValueError):
        HermesEngine(home / ".hermes" / "x", user_home=home)  # <data_dir>/agents/hermes-home inside ~/.hermes
    engine = HermesEngine(tmp_path / "data", user_home=home)
    assert engine.home == (tmp_path / "data" / "agents" / "hermes-home").resolve()
    real = HermesEngine(tmp_path / "data2")  # the real home directory as the reference
    assert real.home != (Path.home() / ".hermes").resolve()
    assert Path.home() / ".hermes" not in real.home.parents


def test_policy_pins_no_builtin_toolsets_no_memory_no_skills(tmp_path: Path) -> None:
    engine = HermesEngine(tmp_path / "data", user_home=tmp_path / "home")
    engine.prepare()
    policy = json.loads((engine.policy_dir / "config.yaml").read_text())
    assert policy["platform_toolsets"] == {"acp": ["no_mcp"]}
    for toolset in (
        "terminal",
        "file",
        "web",
        "browser",
        "code_execution",
        "delegation",
        "memory",
        "skills",
        "session_search",
        "cronjob",
        "computer_use",
    ):
        assert toolset in policy["agent"]["disabled_toolsets"] and toolset in DISABLED_TOOLSETS
    # Toolsets new in Hermes 0.22 (``toolsets.py`` TOOLSETS), disabled as well; and no coding posture,
    # whose ``focus`` mode would replace ``platform_toolsets.acp`` (``gateway/session_policy.py``).
    for toolset in ("coding", "project", "catalog", "connections", "debugging", "search", "video",
                    "video_gen", "x_search", "onboarding", "bot_room", "desktop_ui"):
        assert toolset in policy["agent"]["disabled_toolsets"], toolset
    assert policy["agent"]["coding_context"] == "off"
    assert policy["memory"] == {"memory_enabled": False, "user_profile_enabled": False}
    # 0.3.1 P: a wiki tool / a question waits for the user. Hermes 0.22.1 reads the MCP per-call
    # deadline from ``timeouts.mcp.tool_call`` (``tools/mcp_tool_common.py`` ``_resolve_tool_timeout``),
    # clamped to 365 days (``agent/deadline.py:57``); ``agent.clarify_timeout <= 0`` = no limit.
    assert policy["timeouts"] == {"mcp": {"tool_call": 31_536_000}}
    assert policy["agent"]["clarify_timeout"] == 0
    assert policy["skills"]["project_discovery"] is False
    assert (
        engine.home.is_dir() and not (engine.home / "config.yaml").exists()
    )  # the user's choices stay theirs
    assert not engine.set_up()


async def test_setup_opens_hermes_model_for_skaz_folder(tmp_path: Path) -> None:
    opener = RecordingOpener()
    engine, fake = engine_for(tmp_path, scenario(), opener=opener)
    await engine.login()
    text = Path(opener.calls[0][3]).read_text()
    assert f"{fake.binary} model" in text
    assert f"export HERMES_HOME={engine.home}" in text and "HERMES_MANAGED_DIR=" in text
    assert "sudo" not in text and fake.records() == []


async def test_parallel_runs_use_separate_processes(tmp_path: Path) -> None:
    engine, fake = engine_for(tmp_path, scenario(updates=UPDATES[1:2]))
    results = await asyncio.gather(drain(engine, turn("a", tools=None)), drain(engine, turn("b", tools=None)))
    assert all(isinstance(events[-1], Completed) for events in results)
    assert len([item for item in fake.records("start") if item["argv"] == ["acp"]]) == 2


# -- B18: Hermes 0.22's confirmation of a guarded model switch -------------------------------------
# ``acp_adapter/gateway_server.py`` ``_model_confirmer``: while ``session/set_model`` is in flight the
# gateway asks ``session/request_permission`` with a ``model-confirm-<12 hex>`` tool call of kind
# ``other``, ``rawInput`` = {model, provider, guards} (the switch's resolved target) and the options
# ``allow_once`` ("Switch anyway") / ``deny``; only ``allow_once`` applies the switch.

PICKED = "anthropic:claude-sonnet-5-5"


def model_confirmation(model: str = "claude-sonnet-5-5", provider: str | None = "anthropic", *,
                       call_id: str = "model-confirm-0123456789ab", kind: str = "other",
                       **raw: Any) -> dict[str, Any]:
    return {
        "toolCall": {
            "sessionUpdate": "tool_call_update",
            "toolCallId": call_id,
            "title": f"Model Selection Warning: {model}",
            "kind": kind,
            "status": "pending",
            "content": [{"type": "content", "content": {"type": "text", "text": "This model costs more."}}],
            "rawInput": {"model": model, "provider": provider, "guards": ["cost"], **raw},
        },
        "options": [
            {"optionId": "allow_once", "kind": "allow_once", "name": "Switch anyway"},
            {"optionId": "deny", "kind": "reject_once", "name": "Cancel"},
        ],
    }


def tool_permission(title: str = "rm -rf ~", kind: str = "execute") -> dict[str, Any]:
    return {
        "toolCall": {"toolCallId": "perm-1", "title": title, "kind": kind, "status": "pending",
                     "rawInput": {"command": title}},
        "options": [
            {"optionId": "allow_once", "kind": "allow_once", "name": "Allow once"},
            {"optionId": "allow_always", "kind": "allow_always", "name": "Allow always"},
            {"optionId": "deny", "kind": "reject_once", "name": "Deny"},
        ],
    }


def switching_engine(tmp_path: Path, asked: list[dict[str, Any]]) -> tuple[HermesEngine, FakeCli]:
    new = dict(PROBE["session_new_configured"])
    new["models"] = {
        "currentModelId": "custom:probe-model",
        "availableModels": [
            {"modelId": "custom:probe-model", "name": "probe"},
            {"modelId": PICKED, "name": "claude-sonnet-5-5"},
        ],
    }
    plan = scenario(version_output=V022_VERSION, session_new=new, updates=UPDATES[1:2],
                    set_model_permissions=asked)
    return engine_for(tmp_path, plan)


def answers(fake: FakeCli) -> list[Any]:
    return [item["message"]["result"]["outcome"] for item in fake.records("set_model_permission_reply")]


async def test_the_model_switch_confirmation_for_the_picked_model_is_approved(tmp_path: Path) -> None:
    engine, fake = switching_engine(tmp_path, [model_confirmation()])
    events = await drain(engine, turn(tools=None, model=PICKED))
    assert isinstance(events[-1], Completed), events
    assert answers(fake) == [{"outcome": "selected", "optionId": "allow_once"}]
    assert received(fake, "session/set_model")[0]["params"]["modelId"] == PICKED


@pytest.mark.parametrize(
    "asked",
    [
        model_confirmation("claude-opus-5-5"),  # another model than the one picked in SKAZ
        model_confirmation("claude-sonnet-5-5", "openrouter"),  # the same name on another provider
        model_confirmation("claude-sonnet-5-5", None),  # no provider: not the id SKAZ asked for
        model_confirmation(call_id="perm-1"),  # not Hermes' model confirmation
        model_confirmation(kind="execute"),
        model_confirmation(command="rm -rf ~"),  # anything more than a model choice in the request
        tool_permission(),  # a command
        tool_permission("Write ~/.zshrc", "edit"),  # a file
        tool_permission("mcp__editor_skaz_1a2b3c4d__search", "other"),  # a tool
    ],
)
async def test_every_other_permission_during_the_model_switch_is_rejected(
    tmp_path: Path, asked: dict[str, Any],
) -> None:
    engine, fake = switching_engine(tmp_path, [asked])
    events = await drain(engine, turn(tools=None, model=PICKED))
    assert events == [Failed("run-1", "incompatible", "Hermes could not switch to this model.")]
    assert answers(fake) == [{"outcome": "selected", "optionId": "deny"}]
    assert [m["params"]["prompt"][0]["text"] for m in received(fake, "session/prompt")] == []


async def test_a_tool_request_next_to_the_confirmation_is_still_rejected(tmp_path: Path) -> None:
    engine, fake = switching_engine(tmp_path, [tool_permission(), model_confirmation()])
    events = await drain(engine, turn(tools=None, model=PICKED))
    assert isinstance(events[0], Failed)
    assert answers(fake) == [{"outcome": "selected", "optionId": "deny"},
                             {"outcome": "selected", "optionId": "allow_once"}]


async def test_a_model_confirmation_outside_the_switch_is_rejected(tmp_path: Path) -> None:
    """The approval exists only while SKAZ's own ``session/set_model`` is in flight."""
    updates = ["PERMISSION_MODEL", *UPDATES[1:2]]
    plan = scenario(version_output=V022_VERSION, updates=updates,
                    model_permission=model_confirmation("probe-model", "custom"))
    engine, fake = engine_for(tmp_path, plan)
    events = await drain(engine, turn(tools=None, model="custom:probe-model"))
    assert isinstance(events[-1], Completed)
    assert fake.records("permission_reply")[0]["message"]["result"] == {
        "outcome": {"outcome": "selected", "optionId": "deny"}}


async def test_the_gateway_of_skaz_folder_is_registered_after_a_run(tmp_path: Path) -> None:
    """Hermes 0.22 leaves its gateway running after ``hermes acp`` ends; SKAZ registers it (B18)."""
    from skaz.knowledge.processes import CHILDREN
    from tests.knowledge.agent_fakes import FakeGateway

    engine, _fake = engine_for(tmp_path, scenario(version_output=V022_VERSION, updates=UPDATES[1:2]))
    user = FakeGateway(tmp_path / "fakes", tmp_path / "home" / ".hermes")
    ours = FakeGateway(tmp_path / "fakes", engine.home)
    try:
        assert ours.pid not in CHILDREN.running()
        events = await drain(engine, turn(tools=None))
        assert isinstance(events[-1], Completed)
        assert ours.pid in CHILDREN.running() and user.pid not in CHILDREN.running()
    finally:
        if engine._gateway is not None:
            CHILDREN.discard(engine._gateway)
        ours.close()
        user.close()


async def test_a_status_check_never_runs_the_repair_hermes_asks_for_it_offers_repair(
    tmp_path: Path, caplog: pytest.LogCaptureFixture,
) -> None:
    """Decision 11: ``hermes pm repair`` builds a whole dependency environment (uv, ~1 GB) in SKAZ's
    Hermes folder. A status check (window focus, Settings, the agent picker) never starts it: the
    card offers Repair, which the user starts and sees in the task log."""
    engine, fake = engine_for(tmp_path, scenario(needs_repair=True))
    caplog.set_level(logging.WARNING)
    status = await engine.status()
    assert status.repairable and not status.incompatible and status.version is None
    assert "Repair" in (status.reason or "") and "Reinstall" not in (status.reason or "")
    assert classify(status) == ("unavailable", "repair")
    assert "no dependency environment is committed" in caplog.text
    # Asked again on the next check (it may be repaired meanwhile), and still never repaired by itself.
    await engine.status()
    assert fake.records("repair") == []
    assert sum(1 for item in fake.records("start") if item["argv"] == ["--version"]) == 2


async def test_a_status_check_does_not_start_hermes_while_its_repair_is_unfinished(tmp_path: Path) -> None:
    """A repair that was stopped (SKAZ quit) leaves ``installs/<key>/.repair-incomplete``; Hermes then
    restarts the whole repair at the boot of ANY command, ``--version`` included
    (``hermes_bootstrap.py`` → ``_early_recovery.recover_if_needed``), so SKAZ doesn't run one."""
    engine, fake = engine_for(tmp_path, scenario())
    marker = engine.home / "installs" / "0123456789abcdef" / ".repair-incomplete"
    marker.parent.mkdir(parents=True)
    marker.write_text('{"attempts": 1}', encoding="utf-8")
    status = await engine.status()
    assert status.repairable and classify(status) == ("unavailable", "repair")
    assert fake.records("start") == []
    # The run path refuses the same way instead of starting Hermes.
    events = await drain(engine, turn(tools=None))
    assert isinstance(events[-1], Failed) and fake.records("start") == []


async def test_an_unreadable_version_is_not_remembered_and_never_means_outdated(tmp_path: Path) -> None:
    engine, fake = engine_for(tmp_path, scenario(version_output="something else"))
    status = await engine.status()
    assert not status.incompatible and not status.repairable and status.version is None
    assert classify(status) == ("unavailable", "check")
    before = sum(1 for item in fake.records("start") if item["argv"] == ["--version"])
    await engine.status()
    assert sum(1 for item in fake.records("start") if item["argv"] == ["--version"]) == before + 1
