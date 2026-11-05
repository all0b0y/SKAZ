"""Actual tool results through the public chat API; scripted engines, not model-quality acceptance."""
from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Mapping
from types import SimpleNamespace
from typing import Any

import pytest

import skaz.knowledge.chats.service as chat_service_module
from skaz.knowledge.agents.engine import (
    AgentEvent,
    AgentTurn,
    Completed,
    EngineId,
    Failed,
    ToolCall,
    ToolResult,
)
from skaz.knowledge.chats.model import Message, ToolPart
from skaz.knowledge.chats.resolve import Resolver
from tests.knowledge.chat_support import chips, finished, text

from .test_chats_api import Env
from .test_chats_api import env as env_fixture  # noqa: F401


@pytest.fixture
def env(env_fixture: Env) -> Env:  # noqa: F811
    return env_fixture


@pytest.mark.parametrize("engine", ["codex", "claude_code", "hermes", "opencode"])
@pytest.mark.parametrize("is_error", [False, True])
async def test_a_tool_result_is_saved_and_exposed_without_its_raw_output(
        env: Env, engine: EngineId, is_error: bool) -> None:
    env.agents.scripts[engine] = lambda _turn: [
        ToolCall("", "read-1", "skaz_search", {"q": "entropy"}),
        ToolResult("", "read-1", "PRIVATE_TOOL_OUTPUT", is_error=is_error),
        *text("Here is the answer."),
    ]
    chat = await env.chat(engine=engine)
    message = await env.answered(chat["id"], "Find entropy")
    part = chips(message, "tool")[0]
    assert part["status"] == ("error" if is_error else "done")
    assert part["call_id"] == "read-1"
    assert part["started_at"] and part["duration_ms"] >= 0
    assert "PRIVATE_TOOL_OUTPUT" not in json.dumps(part)
    assert chips(await env.message(chat["id"], message["id"]), "tool") == [part]


@pytest.mark.parametrize(("terminal", "expected"), [
    (Completed(""), "unknown"),
    (Failed("", "network", "Connection lost"), "unknown"),
    (Failed("", "cancelled", "Stopped"), "stopped"),
])
async def test_answer_end_does_not_invent_a_missing_tool_result(
        env: Env, terminal: AgentEvent, expected: str) -> None:
    env.agents.scripts["codex"] = lambda _turn: [
        ToolCall("", "resolved", "skaz_search", {}),
        ToolCall("", "pending", "skaz_read_material", {"material_id": env.library.lecture}),
        ToolResult("", "resolved", "{}"),
        *text("The agent kept writing."),
        terminal,
    ]
    chat = await env.chat()
    message = await env.answered(chat["id"], "Check the outcomes")
    resolved, pending = chips(message, "tool")
    assert resolved["status"] == "done"
    assert pending["status"] == expected
    assert pending["target"] is None  # an unconfirmed read is not evidence the source was looked at
    assert (pending["duration_ms"] is not None) == (expected == "stopped")


async def test_a_recovered_checkpoint_has_unknown_not_running_or_invented_time(env: Env) -> None:
    chat = await env.chat()
    part = ToolPart("skaz_read_material", "Read", ("material", env.library.lecture),
                    call_id="call-before-crash", status="running",
                    started_at="2026-10-31T10:00:00Z")
    message = Message(id="msg-before-crash", chat_id=chat["id"], seq=0, role="assistant", state="streaming",
                      created_at="2026-10-31T10:00:00Z", parts=(part,))
    env.chats.repo.add_messages([message], {})
    assert env.chats.repo.interrupt_streaming() == 1
    restored = await env.message(chat["id"], message.id)
    assert restored["state"] == "interrupted"
    actual = chips(restored, "tool")[0]
    assert actual["status"] == "unknown"
    assert actual["target"] is None
    assert actual["duration_ms"] is None


async def test_a_tool_result_is_durable_before_the_answer_ends(
        env: Env, monkeypatch: pytest.MonkeyPatch) -> None:
    reached, release = asyncio.Event(), asyncio.Event()
    env.chats._checkpoint_s = 60

    async def stream(turn: AgentTurn) -> AsyncIterator[AgentEvent]:
        yield ToolCall(turn.run_id, "call-1", "skaz_search", {})
        yield ToolResult(turn.run_id, "call-1", "PRIVATE_TOOL_OUTPUT")
        reached.set()
        await release.wait()
        yield Completed(turn.run_id)

    monkeypatch.setattr(env.agents.engines["codex"], "run", stream)
    chat = await env.chat()
    sent = await env.ask(chat["id"], "Check checkpoint durability")
    try:
        await asyncio.wait_for(reached.wait(), 5)
        stored = env.chats.repo.message(chat["id"], sent["assistant"]["id"])
        assert stored is not None and stored.state == "streaming"
        parts = [p for p in stored.parts if isinstance(p, ToolPart)]
        assert len(parts) == 1
        part = parts[0]
        assert part.status == "done"
        assert part.duration_ms is not None
        events = (await env.client.get(f"/kb/chats/{chat['id']}/events",
                                       params={"after": chat["cursor"]})).json()["events"]
        updates = [e for e in events if e["type"] == "part_update" and e["part"]["type"] == "tool"]
        assert len(updates) == 1 and updates[0]["message_id"] == stored.id
        assert updates[0]["part"]["call_id"] == "call-1" and updates[0]["part"]["status"] == "done"
        assert "PRIVATE_TOOL_OUTPUT" not in json.dumps(events)
    finally:
        release.set()
        await finished(env.chats)


async def test_duplicate_starts_and_results_do_not_steal_a_call_identity(env: Env) -> None:
    env.agents.scripts["codex"] = lambda _turn: [
        ToolCall("", "same-id", "skaz_search", {}),
        ToolCall("", "same-id", "skaz_search", {}),
        ToolResult("", "unmatched", "{}", is_error=True),
        ToolResult("", "same-id", "{}"),
        ToolResult("", "same-id", "late duplicate", is_error=True),
    ]
    chat = await env.chat()
    message = await env.answered(chat["id"], "Test redelivery")
    parts = chips(message, "tool")
    assert len(parts) == 1
    assert parts[0]["call_id"] == "same-id" and parts[0]["status"] == "done"


async def test_empty_call_ids_are_not_invented_or_used_to_match_unrelated_results(env: Env) -> None:
    env.agents.scripts["codex"] = lambda _turn: [
        ToolCall("", "", "skaz_read_material", {"material_id": env.library.lecture}),
        ToolCall("", "", "skaz_wiki_index", {}),
        ToolResult("", "", "{}"),
    ]
    chat = await env.chat()
    parts = chips(await env.answered(chat["id"], "Missing identities"), "tool")
    assert len(parts) == 2
    for part in parts:
        assert part["call_id"] is None and part["status"] == "unknown"
        assert part["target"] is None
        assert part["started_at"] is None and part["duration_ms"] is None


async def test_foreign_run_events_cannot_create_or_complete_calls_of_this_answer(
        env: Env, monkeypatch: pytest.MonkeyPatch) -> None:
    async def stream(turn: AgentTurn) -> AsyncIterator[AgentEvent]:
        yield ToolCall("older-run", "ghost", "skaz_wiki_index", {})
        yield ToolCall(turn.run_id, "local", "skaz_search", {})
        yield ToolResult("older-run", "local", "stale failure", is_error=True)
        yield ToolResult(turn.run_id, "local", "{}")
        yield Completed(turn.run_id)

    monkeypatch.setattr(env.agents.engines["codex"], "run", stream)
    chat = await env.chat()
    parts = chips(await env.answered(chat["id"], "Reject late events"), "tool")
    assert len(parts) == 1
    assert parts[0]["call_id"] == "local" and parts[0]["status"] == "done"


async def test_tool_clock_starts_at_the_event_not_after_async_label_resolution(
        env: Env, monkeypatch: pytest.MonkeyPatch) -> None:
    now = [10.0]
    monkeypatch.setattr(chat_service_module, "time", SimpleNamespace(monotonic=lambda: now[0]))
    monkeypatch.setattr(chat_service_module, "utc_now", lambda: f"2026-10-31T10:00:{int(now[0]):02d}Z")
    original = Resolver.tool

    def slow_label(resolver: Resolver, name: str, arguments: Mapping[str, Any]) -> ToolPart:
        part = original(resolver, name, arguments)
        now[0] = 20.0
        return part

    async def stream(turn: AgentTurn) -> AsyncIterator[AgentEvent]:
        yield ToolCall(turn.run_id, "timed", "skaz_search", {})
        now[0] = 25.0
        yield ToolResult(turn.run_id, "timed", "{}")
        yield Completed(turn.run_id)

    monkeypatch.setattr(Resolver, "tool", slow_label)
    monkeypatch.setattr(env.agents.engines["codex"], "run", stream)
    chat = await env.chat()
    part = chips(await env.answered(chat["id"], "Measure the observed interval"), "tool")[0]
    assert part["started_at"] == "2026-10-31T10:00:10Z"
    assert part["duration_ms"] == 15_000
