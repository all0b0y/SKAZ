"""Run real SKAZ adapters with offline vendor executables and inspect their actual wire payload."""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

import pytest

from skaz.knowledge.agents.codex import CodexEngine
from skaz.knowledge.agents.engine import AgentTurn, Completed, EngineId, TurnMessage
from skaz.knowledge.skills import skill
from tests.knowledge import test_agent_claude_code as claude
from tests.knowledge import test_agent_hermes as hermes
from tests.knowledge import test_agent_opencode as opencode
from tests.knowledge.agent_fakes import RecordingMcp
from tests.knowledge.test_chats_api import Env
from tests.knowledge.test_chats_api import env as chat_fixture
from tests.knowledge.test_codex_engine import FakeConnection

env = chat_fixture


async def wire(turn: AgentTurn, engine_id: EngineId, env: Env, root: Path) -> tuple[str, set[str]]:
    # For all four, use the tool specs and instructions assembled by the real chat service.
    # Force a fresh protocol session for the wire observation (the fake CLI has no vendor history).
    turn = replace(
        turn, session=None, web=None, model=None, effort=None, messages=(TurnMessage("user", "case:stream"),)
    )
    root.mkdir()
    grant = RecordingMcp()
    if engine_id == "codex":
        connection = FakeConnection(root)
        engine = CodexEngine(connection, env.runtime.kb_tools, run_timeout_s=5)
        events = [event async for event in engine.run(turn)]
        assert isinstance(events[-1], Completed), events
        start = connection.received("thread/start")[0]["params"]
        return start["baseInstructions"], {tool["name"] for tool in start["dynamicTools"]}
    if engine_id == "claude_code":
        client, cli = claude.engine_for(root, {"stream": claude.SUCCESS}, mcp=grant)
        events = await claude.drain(client, turn)
        prompt = cli.records("system_prompt")[0]["text"]
    elif engine_id == "hermes":
        agent, acp = hermes.engine_for(root, hermes.scenario(), mcp=grant)
        events = await hermes.drain(agent, turn)
        prompt = json.dumps(hermes.received(acp, "session/prompt"), ensure_ascii=False)
    else:
        oc, fake = opencode.engine_for(root, opencode.scenario(), mcp=grant)
        events = await opencode.drain(oc, replace(turn, model=opencode.SONNET))
        prompt = json.loads(opencode.acp_start(fake)["run_config"])["agent"]["skaz"]["prompt"]
    assert isinstance(events[-1], Completed), events
    assert grant.revoked == [turn.run_id]
    return prompt, set(grant.granted[0][1])


@pytest.mark.parametrize("engine_id", ["codex", "claude_code", "hermes", "opencode"])
async def test_b2_real_adapter_tools_and_skill_boundary(
    env: Env, engine_id: EngineId, tmp_path: Path
) -> None:
    chat = await env.chat(engine=engine_id)
    await env.answered(chat["id"], "Explain the lecture.")
    on, tools_on = await wire(env.agents.engines[engine_id].turns[-1], engine_id, env, tmp_path / "on")
    r = await env.client.put("/kb/settings/skills/humanizer", json={"enabled": False})
    assert r.status_code == 200
    await env.answered(chat["id"], "Summarize it.")
    off, tools_off = await wire(env.agents.engines[engine_id].turns[-1], engine_id, env, tmp_path / "off")
    marker = "Signs of AI Writing".casefold()
    assert marker in skill("humanizer").text.casefold()
    assert marker in on.casefold() and marker not in off.casefold()
    assert tools_on == tools_off
    assert "skaz_mcp_propose" in tools_on, f"{engine_id}: no tool for a chat-originated MCP proposal"
