"""N6: Codex keeps one live thread per chat (authored stand-in app-server; protocol, not model quality).

``start`` opens a persistent (non-ephemeral) thread seeded with the history; ``continue`` / ``revert``
resume it in a new process and send only the new message; a thread that can't be resumed or
reverted fails with ``session_lost``; ``thread/delete`` removes it; a ``contextCompaction`` item is
reported as ``Compacted``. Stateless runs (no plan) stay ephemeral.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from skaz.knowledge.agents.codex import CodexEngine
from skaz.knowledge.agents.engine import (
    AgentTurn,
    Compacted,
    Completed,
    Failed,
    LiveSessionEngine,
    SessionBound,
    SessionDeleteDeferred,
    SessionPlan,
    TurnMessage,
    collect,
    session_support,
)
from skaz.knowledge.agents.tools import ToolRegistry
from skaz.knowledge.service import KnowledgeService

from .a1_library import seed
from .test_codex_engine import FakeConnection

HISTORY = (TurnMessage("user", "Что такое энтропия? KIWI-WORD"),
           TurnMessage("assistant", "Мера беспорядка.", engine="codex"))


@pytest.fixture
def tools(ready: KnowledgeService) -> ToolRegistry:
    seed(ready)
    return ToolRegistry(ready)


@pytest.fixture
def codex(tmp_path: Path) -> FakeConnection:
    root = tmp_path / "codex"
    root.mkdir()
    return FakeConnection(root)


def chat_turn(text: str, plan: SessionPlan | None, tools: ToolRegistry, *, run_id: str = "run-1",
              history: tuple[TurnMessage, ...] = HISTORY) -> AgentTurn:
    return AgentTurn(run_id=run_id, messages=(*history, TurnMessage("user", text)),
                     instructions="Answer briefly.", tools=tools.specs(), model="gpt-fixture", effort="low",
                     session=plan)


async def test_codex_declares_live_sessions_with_revert(codex: FakeConnection, tools: ToolRegistry) -> None:
    engine = CodexEngine(codex, tools, run_timeout_s=10)
    assert isinstance(engine, LiveSessionEngine)
    assert session_support(engine).live and session_support(engine).revert


async def test_start_opens_a_persistent_thread_seeded_with_the_history(codex: FakeConnection,
                                                                      tools: ToolRegistry) -> None:
    engine = CodexEngine(codex, tools, run_timeout_s=10)
    result = await collect(engine.run(chat_turn("case:stream", SessionPlan("start"), tools)))
    assert isinstance(result.terminal, Completed)
    started = codex.received("thread/start")[0]["params"]
    assert started["ephemeral"] is False and started["environments"] == []
    assert started["config"]["web_search"] == "disabled"
    assert [tool["name"] for tool in started["dynamicTools"]] == [spec.name for spec in tools.specs()]
    sent = codex.received("turn/start")[0]["params"]["input"][0]["text"]
    assert "KIWI-WORD" in sent and sent.endswith("Current user message:\ncase:stream")
    bound = [event for event in result.events if isinstance(event, SessionBound)]
    assert bound == [SessionBound("run-1", started_thread(codex), "turn-1")]
    assert result.events.index(bound[0]) == 0  # before any answer text


def started_thread(codex: FakeConnection) -> str:
    return str(codex.received("turn/start")[0]["params"]["threadId"])


async def test_continue_resumes_the_thread_in_a_new_process_and_sends_only_the_new_message(
        codex: FakeConnection, tools: ToolRegistry) -> None:
    engine = CodexEngine(codex, tools, run_timeout_s=10)
    result = await collect(engine.run(chat_turn("Ещё вопрос case:stream",
                                                SessionPlan("continue", "thread-live-1"), tools)))
    assert isinstance(result.terminal, Completed) and result.text == "Hello world\n\nSecond part"
    assert codex.received("thread/start") == []
    resumed = codex.received("thread/resume")[0]["params"]
    assert resumed["threadId"] == "thread-live-1" and resumed["excludeTurns"] is True
    assert resumed["approvalPolicy"] == "never" and resumed["model"] == "gpt-fixture"
    assert resumed["config"]["web_search"] == "disabled"
    assert "dynamicTools" not in resumed and "baseInstructions" not in resumed  # fixed at thread start
    turn = codex.received("turn/start")[0]["params"]
    assert turn["threadId"] == "thread-live-1"
    assert turn["input"][0]["text"] == "Ещё вопрос case:stream"  # no history text at all
    assert (turn["model"], turn["effort"]) == ("gpt-fixture", "low")  # model and effort go with the turn
    bound = next(event for event in result.events if isinstance(event, SessionBound))
    assert bound.session_id == "thread-live-1" and bound.turn_id.startswith("turn-r")
    assert codex.received("thread/revert") == []


async def test_revert_drops_the_turn_before_sending_the_new_message(codex: FakeConnection,
                                                                    tools: ToolRegistry) -> None:
    engine = CodexEngine(codex, tools, run_timeout_s=10)
    plan = SessionPlan("revert", "thread-live-1", "turn-7")
    result = await collect(engine.run(chat_turn("Исправленный вопрос case:stream", plan, tools)))
    assert isinstance(result.terminal, Completed)
    methods = [m.get("method") for m in codex.received()
               if m.get("method", "").startswith(("thread/", "turn/"))]
    assert methods == ["thread/resume", "thread/revert", "turn/start"]
    reverted = codex.received("thread/revert")[0]["params"]
    assert reverted == {"threadId": "thread-live-1", "beforeTurnId": "turn-7"}
    assert "KIWI-WORD" not in codex.received("turn/start")[0]["params"]["input"][0]["text"]


@pytest.mark.parametrize("plan", [SessionPlan("continue", "thread-gone-1"),
                                  SessionPlan("continue", "thread-locked-1"),
                                  SessionPlan("revert", "thread-live-1", "turn-missing")])
async def test_a_thread_that_cant_be_continued_fails_as_session_lost_with_nothing_sent(
        codex: FakeConnection, tools: ToolRegistry, plan: SessionPlan) -> None:
    engine = CodexEngine(codex, tools, run_timeout_s=10)
    result = await collect(engine.run(chat_turn("case:stream", plan, tools)))
    assert isinstance(result.terminal, Failed)
    assert result.terminal.session_lost and result.terminal.unsent
    assert "PRIVATE" not in result.terminal.message
    assert codex.received("turn/start") == []  # nothing reached the model
    assert not any(isinstance(event, SessionBound) for event in result.events)
    assert engine.active_runs() == set()


async def test_compaction_item_is_reported_once_as_compacted(codex: FakeConnection,
                                                             tools: ToolRegistry) -> None:
    engine = CodexEngine(codex, tools, run_timeout_s=10)
    plan = SessionPlan("continue", "thread-live-1")
    result = await collect(engine.run(chat_turn("case:compact", plan, tools)))
    assert [event for event in result.events if isinstance(event, Compacted)] == [Compacted("run-1")]
    assert result.text == "After compaction" and isinstance(result.terminal, Completed)


async def test_delete_session_runs_thread_delete_in_a_short_lived_process(codex: FakeConnection,
                                                                         tools: ToolRegistry) -> None:
    engine = CodexEngine(codex, tools, run_timeout_s=10)
    await engine.delete_session("thread-live-1")
    assert codex.received("thread/delete")[0]["params"] == {"threadId": "thread-live-1"}
    with pytest.raises(Exception):  # noqa: B017 - any failure: the caller counts an attempt and retries
        await engine.delete_session("thread-locked-1")


async def test_stateless_runs_stay_ephemeral_and_bind_nothing(codex: FakeConnection,
                                                              tools: ToolRegistry) -> None:
    """Ingest, judge, W-3b and summaries never pass a session plan: nothing about them changes."""
    engine = CodexEngine(codex, tools, run_timeout_s=10)
    result = await collect(engine.run(chat_turn("case:stream", None, tools)))
    assert codex.received("thread/start")[0]["params"]["ephemeral"] is True
    assert codex.received("thread/resume") == []
    assert not any(isinstance(event, SessionBound | Compacted) for event in result.events)
    assert AgentTurn(run_id="x", messages=(), instructions="", tools=None).session is None


async def test_a_thread_whose_turn_never_started_is_deleted(codex: FakeConnection,
                                                            tools: ToolRegistry) -> None:
    """FIX-1: ``thread/start`` made a persistent thread, then ``turn/start`` was refused — no
    ``SessionBound``, so SKAZ has no record of it: Codex deletes it itself (best effort)."""
    engine = CodexEngine(codex, tools, run_timeout_s=10)
    result = await collect(engine.run(chat_turn("case:refuse_turn", SessionPlan("start"), tools)))
    await engine.settle()
    assert isinstance(result.terminal, Failed) and not any(isinstance(e, SessionBound) for e in result.events)
    thread = codex.received("thread/start")[0]
    assert thread["params"]["ephemeral"] is False
    deleted = [item["params"]["threadId"] for item in codex.received("thread/delete")]
    assert len(deleted) == 1 and deleted[0].startswith("thread-")
    # A stateless (ephemeral) run leaves nothing to delete.
    await collect(engine.run(chat_turn("case:refuse_turn", None, tools, run_id="run-2")))
    await engine.settle()
    assert len(codex.received("thread/delete")) == 1


async def test_delete_of_a_thread_codex_no_longer_has_is_done(codex: FakeConnection,
                                                              tools: ToolRegistry) -> None:
    engine = CodexEngine(codex, tools, run_timeout_s=10)
    await engine.delete_session("thread-gone-1")  # refused, and ``thread/read`` doesn't know it either
    assert codex.received("thread/read")[0]["params"]["threadId"] == "thread-gone-1"
    with pytest.raises(Exception):  # noqa: B017 - it still exists: an attempt failed
        await engine.delete_session("thread-locked-1")


async def test_delete_without_codex_installed_is_deferred(codex: FakeConnection, tools: ToolRegistry) -> None:
    codex.binary = None
    codex.view = {"status": "missing"}
    engine = CodexEngine(codex, tools, run_timeout_s=10)
    with pytest.raises(SessionDeleteDeferred):
        await engine.delete_session("thread-live-1")
    assert codex.received("thread/delete") == []
