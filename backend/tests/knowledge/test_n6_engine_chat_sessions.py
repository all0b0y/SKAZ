"""N6 batch B5: the live-session path of ``ChatService`` with the real Hermes, OpenCode and Claude Code
engines over their stand-in CLIs (N6-CONTRACT §3, §8).

For each engine: two answers → the second continues the same agent session with only the new message;
a SKAZ tool added later (``chats.live.stale``: the tool set a session started with differs) → exactly one
seeded new session, and the old one is deleted through the normal path (``ChatService.delete_sessions`` →
the engine's ``delete_session``: ``hermes sessions delete`` / ``opencode session delete`` + the kept run
config / ``claude project purge`` of the session folder). The stand-ins prove what SKAZ opens, sends,
keeps and deletes — never a real agent's memory.
"""
from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import httpx
import pytest

from skaz.knowledge.agents.tools import ListFoldersArgs, SkazTool
from skaz.knowledge.chats.service import ChatService
from tests.knowledge import test_agent_hermes as h
from tests.knowledge import test_agent_opencode as o
from tests.knowledge.agent_fakes import RecordingMcp
from tests.knowledge.chat_support import Agents, connect, finished, install
from tests.knowledge.test_chats_api import Env
from tests.knowledge.test_n6_claude_sessions import FakeClaude
from tests.knowledge.test_n6_claude_sessions import engine_for as claude_engine_for

Fixture = AsyncIterator[tuple[Env, Any, Any]]
FIRST, SECOND, THIRD = "Первый вопрос", "Второй вопрос", "Третий вопрос"
EXTRA = SkazTool("skaz_n6_extra", "A tool a later SKAZ adds.", ListFoldersArgs,
                 lambda _kb, _args: {"folders": []})
TEXT_ONLY = [{"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "Ответ."}}]


async def _env(kb_app: Any, kb_client: httpx.AsyncClient, engine_id: str, engine: Any) -> Env:
    runtime = kb_app.state.runtime
    agents = Agents()
    agents.engines[engine_id] = engine  # type: ignore[index]  # the real engine over its stand-in CLI
    install(runtime, agents)
    library = await connect(kb_client, runtime)
    return Env(kb_client, runtime, runtime.kb_chats, agents, library)


async def _deletions(chats: ChatService) -> None:
    await finished(chats)
    for _ in range(50):
        task = chats._deleting
        if task is None or task.done():
            break
        await asyncio.wait_for(asyncio.shield(task), 10)
    assert await chats.delete_sessions() == 0  # nothing left queued


def _session(env: Env, chat_id: str) -> str | None:
    with env.runtime.kb.db.read() as connection:
        row = connection.execute("SELECT session_id FROM agent_sessions WHERE chat_id = ?",
                                 (chat_id,)).fetchone()
    return None if row is None else str(row[0])


async def _ask(env: Env, chat_id: str, question: str) -> None:
    answer = await env.answered(chat_id, question)
    assert answer["state"] == "done", answer


def _add_tool(env: Env) -> None:
    env.runtime.kb_tools.add((EXTRA,))


# -- Hermes ------------------------------------------------------------------------------------------


@pytest.fixture
async def hermes(kb_app: Any, kb_client: httpx.AsyncClient, tmp_path: Path) -> Fixture:
    engine, fake = h.engine_for(tmp_path / "hermes", h.scenario(updates=TEXT_ONLY), mcp=RecordingMcp())
    engine.mark_checked()
    made = await _env(kb_app, kb_client, "hermes", engine)
    yield made, engine, fake
    await made.chats.close()


def _hermes_new_session(fake: Any, session_id: str) -> None:
    """The next ``session/new`` of the stand-in Hermes answers ``session_id`` (each run is a new process)."""
    plan = json.loads(fake.scenario_path.read_text(encoding="utf-8"))
    plan["session_new"] = {**plan["session_new"], "sessionId": session_id}
    fake.scenario_path.write_text(json.dumps(plan), encoding="utf-8")


def _hermes_chat_news(fake: Any) -> list[dict[str, Any]]:
    """``session/new`` of chat answers (with SKAZ's MCP server), not of the status check."""
    return [item for item in h.received(fake, "session/new") if item["params"]["mcpServers"]]


async def test_hermes_chat_continues_its_session_and_a_new_tool_reseeds_once(
        hermes: tuple[Env, Any, Any]) -> None:
    env, engine, fake = hermes
    # SKAZ's status check opens (and forgets) an ACP session too: run it first under its own id.
    _hermes_new_session(fake, "hermes-status-probe")
    assert (await env.runtime.kb_agents.registry.view("hermes", refresh=True)).state == "ready"
    chat = await env.chat(engine="hermes")
    _hermes_new_session(fake, "hermes-chat-1")
    await _ask(env, chat["id"], FIRST)
    await _ask(env, chat["id"], SECOND)
    assert len(_hermes_chat_news(fake)) == 1
    (load,) = h.received(fake, "session/load")
    assert load["params"]["sessionId"] == "hermes-chat-1"
    prompted = [item["params"]["prompt"][0]["text"] for item in h.received(fake, "session/prompt")
                if item["params"]["prompt"][0]["text"] != "/tools"]
    assert FIRST in prompted[0] and prompted[1].endswith(SECOND) and FIRST not in prompted[1]
    assert _session(env, chat["id"]) == "hermes-chat-1"
    assert not any(item["args"][1:2] == ["hermes-chat-1"] for item in fake.records("sessions"))  # kept

    _add_tool(env)
    _hermes_new_session(fake, "hermes-chat-2")
    await _ask(env, chat["id"], THIRD)
    assert len(_hermes_chat_news(fake)) == 2 and len(h.received(fake, "session/load")) == 1
    reseed = [item["params"]["prompt"][0]["text"] for item in h.received(fake, "session/prompt")
              if item["params"]["prompt"][0]["text"] != "/tools"][-1]
    assert FIRST in reseed and SECOND in reseed and THIRD in reseed  # the seed carries the history
    assert _session(env, chat["id"]) == "hermes-chat-2"
    await _deletions(env.chats)
    deleted = [item["args"][1] for item in fake.records("sessions") if item["args"][:1] == ["delete"]]
    assert deleted.count("hermes-chat-1") == 1 and "hermes-chat-2" not in deleted
    assert engine.chat_sessions() == ["hermes-chat-2"]


# -- OpenCode ----------------------------------------------------------------------------------------


@pytest.fixture
async def opencode(kb_app: Any, kb_client: httpx.AsyncClient, tmp_path: Path) -> Fixture:
    engine, fake = o.engine_for(tmp_path / "opencode", o.scenario(updates=TEXT_ONLY), mcp=RecordingMcp())
    made = await _env(kb_app, kb_client, "opencode", engine)
    yield made, engine, fake
    await made.chats.close()


def _opencode_calls(fake: Any, *methods: str) -> list[dict[str, Any]]:
    return [item["message"] for item in fake.records("received") if item["message"].get("method") in methods]


def _opencode_new_session(fake: Any, session_id: str) -> None:
    plan = json.loads(fake.scenario_path.read_text(encoding="utf-8"))
    plan["session_new"] = {**plan["session_new"], "sessionId": session_id}
    fake.scenario_path.write_text(json.dumps(plan), encoding="utf-8")


async def test_opencode_chat_continues_its_session_and_a_new_tool_reseeds_once(
        opencode: tuple[Env, Any, Any]) -> None:
    env, engine, fake = opencode
    _opencode_new_session(fake, "ses_chat1")
    chat = await env.chat(engine="opencode", model=o.SONNET)
    await _ask(env, chat["id"], FIRST)
    await _ask(env, chat["id"], SECOND)
    assert len(_opencode_calls(fake, "session/new")) == 1
    reopened = _opencode_calls(fake, "session/load", "session/resume")
    assert [item["params"]["sessionId"] for item in reopened] == ["ses_chat1"]
    prompted = [item["params"]["prompt"][0]["text"] for item in _opencode_calls(fake, "session/prompt")]
    assert FIRST in prompted[0] and prompted[1].endswith(SECOND) and FIRST not in prompted[1]
    assert _session(env, chat["id"]) == "ses_chat1"
    kept = engine.sessions_dir / "ses_chat1.json"
    assert kept.is_file()  # the instructions the session started with, for its later answers

    _add_tool(env)
    _opencode_new_session(fake, "ses_chat2")
    await _ask(env, chat["id"], THIRD)
    assert len(_opencode_calls(fake, "session/new")) == 2
    assert _session(env, chat["id"]) == "ses_chat2"
    await _deletions(env.chats)
    deleted = [item["argv"] for item in fake.records("start") if item["argv"][:2] == ["session", "delete"]]
    assert deleted == [["session", "delete", "ses_chat1"]]
    assert not kept.exists() and (engine.sessions_dir / "ses_chat2.json").is_file()


# -- Claude Code -------------------------------------------------------------------------------------


@pytest.fixture
async def claude(kb_app: Any, kb_client: httpx.AsyncClient, tmp_path: Path) -> Fixture:
    fake = FakeClaude(tmp_path / "claude-bin", {"answer": "Ответ."})
    engine = claude_engine_for(tmp_path / "claude", fake, mcp=RecordingMcp())
    assert engine.config_dir is not None
    engine.config_dir.mkdir(parents=True, exist_ok=True)
    (engine.config_dir / ".signed-in").write_text("")
    made = await _env(kb_app, kb_client, "claude_code", engine)
    yield made, engine, fake
    await made.chats.close()


async def test_claude_code_chat_continues_its_session_and_a_new_tool_reseeds_once(
        claude: tuple[Env, Any, Any]) -> None:
    env, engine, fake = claude
    chat = await env.chat(engine="claude_code")
    await _ask(env, chat["id"], FIRST)
    await _ask(env, chat["id"], SECOND)
    first, second = fake.runs()
    started = first["argv"][first["argv"].index("--session-id") + 1]
    assert "--resume" not in first["argv"]
    assert second["argv"][second["argv"].index("--resume") + 1] == started
    sent = [json.loads(item["line"])["message"]["content"] for item in fake.records("stdin")]
    assert FIRST in sent[0] and sent[1].endswith(SECOND) and FIRST not in sent[1]
    assert _session(env, chat["id"]) == started
    old_folder, old_prompt = engine.folder.session_dir(started), engine.folder.prompt_file(started)
    assert old_folder.is_dir() and old_prompt.is_file()  # the instructions the session started with

    _add_tool(env)
    await _ask(env, chat["id"], THIRD)
    third = fake.runs()[-1]
    assert "--resume" not in third["argv"]
    renewed = third["argv"][third["argv"].index("--session-id") + 1]
    assert renewed != started and _session(env, chat["id"]) == renewed
    assert len(fake.runs()) == 3  # one reseed, no retry
    await _deletions(env.chats)
    purged = [item["argv"] for item in fake.records("start") if item["argv"][:2] == ["project", "purge"]]
    assert purged == [["project", "purge", str(old_folder), "--yes"]]
    assert not old_folder.exists() and not old_prompt.exists() and not engine.folder.leftovers(started)
    assert engine.folder.session_dir(renewed).is_dir() and engine.folder.prompt_file(renewed).is_file()
