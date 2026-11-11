"""Codex liveness over a scripted event stream and an injected clock; no model or sleeps."""
from __future__ import annotations

import asyncio
from collections.abc import Coroutine
from dataclasses import dataclass
from typing import Any

import pytest

from skaz.knowledge.agents import codex
from skaz.knowledge.agents.engine import AgentTurn, Completed, Failed, TurnMessage, collect
from skaz.knowledge.ingest.execution import ProcessingProfile, execution_scope, stored_scope
from skaz.knowledge.ingest.jobs import JobRepository
from skaz.knowledge.service import KnowledgeService

from .test_codex_engine import FakeConnection
from .test_codex_engine import connection as connection


@dataclass
class Clock:
    now: float = 0.0

    def __call__(self) -> float:
        return self.now


def event(method: str, **params: Any) -> dict[str, Any]:
    return {"method": method, "params": {"threadId": "thread", "turnId": "turn", **params}}


class ScriptedCodex(codex.CodexEngine):
    async def _start(self, turn: AgentTurn, run: codex._Run) -> Failed | None:
        run.thread_id, run.turn_id = "thread", "turn"
        return None


def scripted(monkeypatch: pytest.MonkeyPatch, connection: FakeConnection,
             script: list[tuple[float, dict[str, Any]]]) -> tuple[ScriptedCodex, Clock]:
    clock = Clock()
    engine = ScriptedCodex(connection, None, clock=clock)

    async def wait(awaitable: Coroutine[Any, Any, object], timeout: float) -> object:
        run = engine._runs["test"]
        if script and script[0][0] < clock.now + timeout:
            clock.now, message = script.pop(0)
            run.queue.put_nowait(message)
            return await awaitable
        awaitable.close()
        clock.now += timeout
        raise TimeoutError

    monkeypatch.setattr(asyncio, "wait_for", wait)
    return engine, clock


def turn() -> AgentTurn:
    return AgentTurn("test", (TurnMessage("user", "fixture"),), "fixture", tools=None)


async def test_silence_stops_after_ten_minutes(monkeypatch: pytest.MonkeyPatch,
                                              connection: FakeConnection) -> None:
    engine, clock = scripted(monkeypatch, connection, [])
    result = await collect(engine.run(turn()))
    assert clock.now == 600
    assert isinstance(result.terminal, Failed)
    assert "silent for 10 minutes" in result.terminal.message
    assert engine.active_runs() == set()


@pytest.mark.parametrize("foreign", [
    event("item/reasoning/textDelta", threadId="other"),
    event("item/reasoning/textDelta", turnId="other"),
    {"method": "account/rateLimits/updated", "params": {"rateLimits": {}}},
])
async def test_other_runs_and_account_events_do_not_reset_silence(
    monkeypatch: pytest.MonkeyPatch, connection: FakeConnection, foreign: dict[str, Any],
) -> None:
    engine, clock = scripted(monkeypatch, connection, [(500, foreign)])
    result = await collect(engine.run(turn()))
    assert clock.now == 600 and isinstance(result.terminal, Failed)


@pytest.mark.parametrize("method", ["item/reasoning/textDelta", "thread/tokenUsage/updated",
                                     "turn/started", "thread/status/changed"])
async def test_steady_run_events_keep_it_alive_until_the_absolute_ceiling(
    monkeypatch: pytest.MonkeyPatch, connection: FakeConnection, method: str,
) -> None:
    engine, clock = scripted(monkeypatch, connection, [(at, event(method)) for at in range(500, 4000, 500)])
    result = await collect(engine.run(turn()))
    assert clock.now == 3600
    assert isinstance(result.terminal, Failed)
    assert "60-minute ceiling" in result.terminal.message


async def test_a_lively_long_answer_can_finish(monkeypatch: pytest.MonkeyPatch,
                                               connection: FakeConnection) -> None:
    script: list[tuple[float, dict[str, Any]]] = [
        (at, event("item/reasoning/textDelta")) for at in range(500, 3500, 500)]
    script.append((3500, event("turn/completed", turn={"id": "turn", "status": "completed"})))
    engine, clock = scripted(monkeypatch, connection, script)
    result = await collect(engine.run(turn()))
    assert clock.now == 3500 and isinstance(result.terminal, Completed)


async def test_codex_retry_errors_reset_silence_and_reach_the_job_journal(
    monkeypatch: pytest.MonkeyPatch, connection: FakeConnection, ready: KnowledgeService,
) -> None:
    retry = event("error", willRetry=True, error={"codexErrorInfo": "rateLimitExceeded",
                                                  "message": "PRIVATE provider detail"})
    engine, clock = scripted(monkeypatch, connection, [(500, retry), (1000, retry)])
    jobs = JobRepository(ready.db)
    job = jobs.create(None, profile=ProcessingProfile("codex", None, None, "en"))
    with execution_scope(stored_scope(ready.db, job.id)):
        result = await collect(engine.run(turn()))
    assert clock.now == 1600 and isinstance(result.terminal, Failed)
    saved = jobs.get(job.id)
    assert saved is not None
    assert [entry.message for entry in saved.journal] == [
        "Codex hit a rate limit and is retrying.", "Codex hit a rate limit and is retrying.",
    ]
    assert "PRIVATE" not in repr(saved)
