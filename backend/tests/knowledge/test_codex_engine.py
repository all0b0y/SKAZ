"""Codex on ``AgentEngine`` over an authored stand-in process (protocol handling, not model quality)."""
from __future__ import annotations

import asyncio
import json
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest

from skaz.gateways.codex_rpc import CodexRpc
from skaz.knowledge.agents.codex import (
    BASE_INSTRUCTIONS,
    KB_DISABLED_FEATURES,
    CodexEngine,
    classify,
    turn_input,
)
from skaz.knowledge.agents.engine import (
    AgentEngine,
    AgentEvent,
    AgentTurn,
    Completed,
    Failed,
    TextDelta,
    ToolCall,
    ToolResult,
    TurnMessage,
    collect,
)
from skaz.knowledge.agents.prompting import UNTRUSTED_HEADER
from skaz.knowledge.agents.tools import TOOL_NAMES, ToolRegistry
from skaz.knowledge.mcp import McpRunScope, McpServer
from skaz.knowledge.service import KnowledgeService

from .a1_library import seed

FIXTURE = Path(__file__).parent / "fixtures" / "codex_kb_server.py"
CONNECTED = {"status": "connected", "version": "codex-cli 0.160.0", "path": "/fixture/codex"}


class FakeConnection:
    """``CodexConnection`` stand-in: spawns the authored fixture instead of the real CLI."""

    def __init__(self, root: Path, view: dict[str, Any] | None = None) -> None:
        self.cwd = root
        self.binary: str | None = sys.executable
        self.view = dict(view or CONNECTED)
        self.log = root / "codex-log.jsonl"
        self.checks = 0
        self.spawned = 0

    async def check(self) -> dict[str, Any]:
        self.checks += 1
        return dict(self.view)

    def rpc(self, *, max_message_bytes: int = 1024 * 1024) -> CodexRpc:
        self.spawned += 1
        return CodexRpc((sys.executable, str(FIXTURE), str(self.log)), cwd=self.cwd, env={},
                        max_message_bytes=max_message_bytes)

    def received(self, method: str | None = None) -> list[dict[str, Any]]:
        if not self.log.exists():
            return []
        messages = [json.loads(line) for line in self.log.read_text(encoding="utf-8").splitlines()]
        return [m for m in messages if method is None or m.get("method") == method]


@pytest.fixture
def registry(ready: KnowledgeService) -> ToolRegistry:
    seed(ready)
    return ToolRegistry(ready)


@pytest.fixture
def connection(tmp_path: Path) -> FakeConnection:
    root = tmp_path / "codex"
    root.mkdir()
    return FakeConnection(root)


@pytest.fixture
def engine(connection: FakeConnection, registry: ToolRegistry) -> CodexEngine:
    return CodexEngine(connection, registry, run_timeout_s=10)


def ask(text: str, *, run_id: str = "run-1", tools: bool = True, registry: ToolRegistry | None = None,
        **extra: Any) -> AgentTurn:
    return AgentTurn(run_id=run_id, messages=(TurnMessage("user", text),), instructions="Answer briefly.",
                     tools=(registry.specs() if registry else ()) if tools else None, **extra)


async def test_streams_answer_text_only_and_reports_usage(engine: CodexEngine, connection: FakeConnection,
                                                         registry: ToolRegistry) -> None:
    assert isinstance(engine, AgentEngine)
    schema = {"type": "object", "properties": {"claims": {"type": "array"}}, "required": ["claims"]}
    result = await collect(engine.run(ask("case:stream", registry=registry, model="gpt-fixture", effort="low",
                                          response_schema=schema)))
    deltas = [event.text for event in result.events if isinstance(event, TextDelta)]
    assert deltas == ["Hello", " world", "\n\nSecond part"]
    assert result.text == "Hello world\n\nSecond part"
    assert "Thinking" not in result.text and "PRIVATE" not in result.text
    assert result.terminal == Completed("run-1", result.terminal.usage)  # type: ignore[union-attr]
    assert isinstance(result.terminal, Completed) and result.terminal.usage is not None
    assert (result.terminal.usage.input_tokens, result.terminal.usage.output_tokens) == (120, 30)

    started = connection.received("thread/start")[0]["params"]
    assert started["ephemeral"] is True and started["environments"] == []
    assert started["approvalPolicy"] == "never" and started["model"] == "gpt-fixture"
    assert started["config"]["web_search"] == "disabled"
    assert all(started["config"][f"features.{name}"] is False for name in KB_DISABLED_FEATURES)
    assert started["baseInstructions"].startswith(BASE_INSTRUCTIONS)
    assert started["baseInstructions"].endswith("Answer briefly.")
    turn = connection.received("turn/start")[0]["params"]
    assert turn["input"][0]["text"] == "case:stream"
    assert (turn["model"], turn["effort"], turn["outputSchema"]) == ("gpt-fixture", "low", schema)
    assert engine.active_runs() == set()


async def test_tool_call_runs_the_shared_registry_and_reports_events(engine: CodexEngine,
                                                                     connection: FakeConnection,
                                                                     registry: ToolRegistry) -> None:
    result = await collect(engine.run(ask("case:tool", registry=registry)))
    calls = [event for event in result.events if isinstance(event, ToolCall)]
    results = [event for event in result.events if isinstance(event, ToolResult)]
    assert calls == [ToolCall("run-1", "call-1", "skaz_list_folders", {})]
    assert len(results) == 1 and results[0].call_id == "call-1" and results[0].is_error is False
    assert results[0].output.startswith(UNTRUSTED_HEADER) and "Физика" in results[0].output
    assert result.text == "Tool answered: True" and isinstance(result.terminal, Completed)
    reply = next(m for m in connection.received() if m.get("id") == "tool-1" and "result" in m)
    assert reply["result"]["contentItems"][0]["text"] == results[0].output

    failed = await collect(engine.run(ask("case:tool_error", run_id="run-2", registry=registry)))
    error = next(event for event in failed.events if isinstance(event, ToolResult))
    assert error.is_error is True and error.output.startswith("Error: Material not found.")


async def test_registry_mcp_and_codex_offer_identical_tools(engine: CodexEngine,
                                                            registry: ToolRegistry) -> None:
    specs = registry.specs()
    dynamic = engine.dynamic_tools(specs)
    server = McpServer(registry)
    listed = server._tools(McpRunScope("run-1", frozenset(TOOL_NAMES)))  # the exact MCP tools/list payload
    assert [tool["name"] for tool in dynamic] == [tool["name"] for tool in listed] == list(TOOL_NAMES)
    for codex_tool, mcp_tool, spec in zip(dynamic, listed, specs, strict=True):
        assert codex_tool["type"] == "function"
        assert codex_tool["inputSchema"] == mcp_tool["inputSchema"] == dict(spec.input_schema)
        assert codex_tool["description"] == mcp_tool["description"] == spec.description
    narrowed = engine.dynamic_tools(registry.specs({"skaz_search"}))
    assert [tool["name"] for tool in narrowed] == ["skaz_search"]


async def test_interrupt_stops_the_run_and_its_process(engine: CodexEngine, connection: FakeConnection,
                                                       registry: ToolRegistry) -> None:
    events = engine.run(ask("case:hang", registry=registry))
    first = await asyncio.wait_for(anext(events), 10)
    assert first == TextDelta("run-1", "Working")
    assert engine.active_runs() == {"run-1"}
    await engine.interrupt("run-1")
    rest = [event async for event in events]
    assert rest == [Failed("run-1", "cancelled", "The answer was stopped.")]
    interrupted = connection.received("turn/interrupt")[0]["params"]
    assert interrupted["turnId"] == "turn-1" and interrupted["threadId"].startswith("thread-")
    assert engine.active_runs() == set()
    await engine.interrupt("run-1")  # finished ids are ignored


async def test_limit_failure_carries_the_reset_time_when_codex_reports_it(engine: CodexEngine,
                                                                         registry: ToolRegistry) -> None:
    pushed = await collect(engine.run(ask("case:limit", registry=registry)))
    assert pushed.terminal == Failed("run-1", "limit", "Your Codex usage limit is reached.",
                                     datetime.fromtimestamp(1790000000, tz=UTC))
    assert "PRIVATE" not in repr(pushed.events)

    read = await collect(engine.run(ask("case:limit_read", run_id="run-2", registry=registry)))
    assert read.terminal == Failed("run-2", "limit", "Codex is rate limited right now.",
                                   datetime.fromtimestamp(1791000000, tz=UTC))
    unknown = await collect(engine.run(ask("case:limit_unknown", run_id="run-3", registry=registry)))
    assert isinstance(unknown.terminal, Failed) and unknown.terminal.kind == "limit"
    assert unknown.terminal.retry_at is None

    auth = await collect(engine.run(ask("case:auth", run_id="run-4", registry=registry)))
    assert auth.terminal == Failed("run-4", "auth", "Codex needs you to sign in again.")


async def test_ingest_mode_gives_the_model_no_tools_at_all(engine: CodexEngine,
                                                           connection: FakeConnection) -> None:
    result = await collect(engine.run(ask("case:ingest", tools=False)))
    started = connection.received("thread/start")[0]["params"]
    assert started["dynamicTools"] == []
    assert all(started["config"][f"features.{name}"] is False for name in KB_DISABLED_FEATURES)
    assert "You have no tools" in started["baseInstructions"]
    refused = next(m for m in connection.received() if m.get("id") == "tool-x")
    assert refused["error"]["code"] == -32601  # the transport refuses any tool call
    assert not any(isinstance(event, ToolCall | ToolResult) for event in result.events)
    assert result.text == "No tools" and isinstance(result.terminal, Completed)


async def test_parallel_runs_use_separate_processes_with_an_explicit_cap(connection: FakeConnection,
                                                                         registry: ToolRegistry) -> None:
    engine = CodexEngine(connection, registry, max_parallel=2, run_timeout_s=10)
    first, second = engine.run(ask("case:hang", run_id="a", registry=registry)), engine.run(
        ask("case:hang", run_id="b", registry=registry))
    heads = await asyncio.wait_for(asyncio.gather(anext(first), anext(second)), 10)
    assert list(heads) == [TextDelta("a", "Working"), TextDelta("b", "Working")]  # both turns live at once
    assert engine.active_runs() == {"a", "b"} and connection.spawned == 2
    threads = {m["params"]["threadId"] for m in connection.received("turn/start")}
    assert len(threads) == 2  # one thread per process

    third = await collect(engine.run(ask("case:stream", run_id="c", registry=registry)))
    assert isinstance(third.terminal, Failed) and third.terminal.kind == "other"
    assert "Too many Codex answers" in third.terminal.message and connection.spawned == 2
    assert third.terminal.transient and third.terminal.unsent  # refused before anything was sent
    duplicate = await collect(engine.run(ask("case:stream", run_id="a", registry=registry)))
    assert duplicate.terminal == Failed("a", "other", "This answer is already running.")
    assert isinstance(duplicate.terminal, Failed) and duplicate.terminal.unsent

    await asyncio.gather(engine.interrupt("a"), engine.interrupt("b"))
    endings: list[list[AgentEvent]] = [[e async for e in first], [e async for e in second]]
    assert [ending[-1] for ending in endings] == [Failed("a", "cancelled", "The answer was stopped."),
                                                  Failed("b", "cancelled", "The answer was stopped.")]
    after = await collect(engine.run(ask("case:stream", run_id="c", registry=registry)))
    assert isinstance(after.terminal, Completed)


async def test_process_crash_and_not_ready_states(connection: FakeConnection, registry: ToolRegistry) -> None:
    engine = CodexEngine(connection, registry, run_timeout_s=10)
    crashed = await collect(engine.run(ask("case:crash", registry=registry)))
    assert crashed.terminal == Failed("run-1", "other", "Codex stopped unexpectedly.")
    assert isinstance(crashed.terminal, Failed) and not crashed.terminal.unsent  # may have been sent

    connection.view = {"status": "signed_out", "version": "codex-cli 0.160.0", "path": "/x"}
    signed_out = CodexEngine(connection, registry)
    status = await signed_out.status()
    assert status.installed and not status.signed_in and status.version == "0.160.0"
    spawned = connection.spawned
    result = await collect(signed_out.run(ask("case:stream", registry=registry)))
    assert isinstance(result.terminal, Failed) and result.terminal.kind == "auth"
    assert connection.spawned == spawned  # nothing started

    connection.view = {"status": "missing", "version": None, "path": None}
    missing = CodexEngine(connection, registry)
    result = await collect(missing.run(ask("case:stream", registry=registry)))
    assert result.terminal == Failed("run-1", "incompatible", "Codex is not installed.")
    connection.view = {"status": "incompatible", "version": "codex-cli 0.100.0", "path": "/x",
                       "error": "Codex 0.100.0 is outdated — version 0.149.1 or newer is required."}
    old = await CodexEngine(connection, registry).status()
    assert old.incompatible and old.reason is not None and "0.149.1" in old.reason

    cached = CodexEngine(connection, registry)
    await cached.status()
    checks = connection.checks
    await cached.status()
    assert connection.checks == checks  # cached between checks
    await collect(signed_out.run(ask("case:stream", run_id="run-9", registry=registry)))
    await signed_out.status()
    assert connection.checks == checks + 2  # an auth failure forces a fresh check (one in the run, one here)


async def test_models_come_from_model_list(engine: CodexEngine) -> None:
    models = await engine.models()
    assert [(m.id, m.label, m.efforts, m.default_effort) for m in models] == [
        ("gpt-fixture", "Fixture", ("low", "high"), "low")]


def test_history_is_bounded_untrusted_and_keeps_the_newest() -> None:
    text = turn_input((
        TurnMessage("user", "Что такое энтропия?"),
        TurnMessage("assistant", "Мера беспорядка [mat-1:seg-1].", engine="claude_code"),
        TurnMessage("user", "А при чём тут Клаузиус?"),
    ))
    history, current = text.split("\n\nCurrent user message:\n")
    assert current == "А при чём тут Клаузиус?"
    assert UNTRUSTED_HEADER in history and history.rstrip().endswith("</untrusted-data>")
    lines = [json.loads(line) for line in history.split("\n") if line.startswith("{")]
    assert lines == [{"role": "user", "content": "Что такое энтропия?"},
                     {"role": "assistant", "agent": "Claude Code",
                      "content": "Мера беспорядка [mat-1:seg-1]."}]

    many = (*(TurnMessage("user" if n % 2 == 0 else "assistant", f"m{n} " + "x" * 20_000, engine="codex")
              for n in range(20)), TurnMessage("user", "now"))
    bounded = turn_input(many)
    assert len(bounded) < 70_000 and "m19 " in bounded and "m0 " not in bounded
    assert "earlier messages omitted" in bounded and "[middle of this message omitted]" in bounded
    assert turn_input((TurnMessage("user", "only"),)) == "only"
    with pytest.raises(ValueError, match="must end with the user's message"):
        turn_input((TurnMessage("assistant", "hi", engine="codex"),))


def test_failure_classification_never_uses_provider_text() -> None:
    assert classify("usageLimitExceeded")[0] == "limit"
    assert classify({"httpConnectionFailed": {"httpStatusCode": 429}})[0] == "limit"
    assert classify({"responseStreamDisconnected": {"httpStatusCode": None}})[0] == "network"
    assert classify("badRequest")[0] == "incompatible"
    assert classify(None) == ("other", "Codex couldn't finish the answer.")
