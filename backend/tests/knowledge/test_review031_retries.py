"""Review 0.3.1 (C-07): a refusal that would repeat (request too long, no tool access, first check
not done) fails at once; only a busy or not-yet-started engine is tried again.

Authored model events at the external seam, and the adapters' own refusals before anything starts.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

import httpx
import pytest

from skaz.knowledge.agents.codex import MAX_MESSAGE_BYTES, CodexEngine
from skaz.knowledge.agents.engine import AgentTurn, Completed, Failed, TextDelta, TurnMessage, collect
from skaz.knowledge.agents.fake import FakeEngine, ScriptItem
from skaz.knowledge.agents.tools import ToolRegistry
from skaz.knowledge.service import KnowledgeService
from skaz.knowledge.wiki.agent import AgentCaller, WikiJobFailed
from tests.knowledge import test_agent_claude_code as claude_tests
from tests.knowledge import test_agent_hermes as hermes_tests
from tests.knowledge.test_codex_engine import FakeConnection
from tests.knowledge.test_wiki_retries import _run, ok

TOO_LONG = "This request is too long for Codex. Send a shorter text."


def refused() -> list[ScriptItem]:
    return [Failed("", "other", TOO_LONG, unsent=True, permanent=True)]


async def test_an_ingest_step_that_can_never_be_sent_fails_at_once(
        kb_app: Any, kb_client: httpx.AsyncClient) -> None:
    failed, turns = await _run(kb_app, kb_client, [refused(), ok()])
    assert failed["state"] == "failed" and failed["can_retry"] is True
    assert len(turns) == 1
    assert "too long for Codex" in failed["error"]
    assert not any("busy" in entry["message"] for entry in failed["journal"])


async def test_follow_up_wiki_calls_do_not_retry_a_refusal_that_would_repeat() -> None:
    answers: list[list[ScriptItem]] = [refused(), [TextDelta("", "{}"), Completed("")]]
    engine = FakeEngine("codex", script=lambda _turn: answers.pop(0))
    with pytest.raises(WikiJobFailed) as failure:
        await AgentCaller(engine, "t", retry_delays_s=(0.0,)).ask("x", [], {})
    assert len(engine.turns) == 1 and "too long for Codex" in failure.value.message


async def test_codex_marks_a_too_long_request_as_one_that_would_repeat(tmp_path: Path,
                                                                     ready: KnowledgeService) -> None:
    root = tmp_path / "codex"
    root.mkdir()
    connection = FakeConnection(root)
    engine = CodexEngine(connection, ToolRegistry(ready), run_timeout_s=10)
    turn = AgentTurn(run_id="r", messages=(TurnMessage("user", "ж" * MAX_MESSAGE_BYTES),),
                     instructions="Answer briefly.", tools=None)
    result = await collect(engine.run(turn))
    assert isinstance(result.terminal, Failed) and result.terminal.message == TOO_LONG
    assert result.terminal.unsent and result.terminal.permanent and not result.terminal.transient
    assert connection.spawned == 0


async def test_claude_code_and_hermes_mark_missing_tool_access_as_one_that_would_repeat(
        tmp_path: Path) -> None:
    claude, _fake = claude_tests.engine_for(tmp_path / "claude", {"stream": claude_tests.SUCCESS})
    events = await claude_tests.drain(claude, claude_tests.turn())
    assert isinstance(events[0], Failed) and events[0].unsent and events[0].permanent
    hermes, _cli = hermes_tests.engine_for(tmp_path / "hermes", hermes_tests.scenario())
    events = await hermes_tests.drain(hermes, hermes_tests.turn())
    assert isinstance(events[0], Failed) and events[0].unsent and events[0].permanent


def test_a_busy_engine_is_not_marked_as_one_that_would_repeat() -> None:
    assert Failed("r", "other", "busy", transient=True, unsent=True).permanent is False
