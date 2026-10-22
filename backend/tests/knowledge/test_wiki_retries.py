"""Retries of a wiki model call by whether the request may have reached the model (user, 2026-10-20).

* Failed before it was sent (the engine was busy or couldn't start): up to 3 automatic retries.
* Failed after it may have been sent (network drop, the engine crashed mid-answer): exactly one
  automatic retry, continuing from the finished sections; then the job fails honestly with Retry.

Authored model events only: a fake at the external seam, never evidence of real model behaviour.
"""
from __future__ import annotations

import json
from typing import Any

import httpx

from skaz.knowledge.agents.engine import AgentTurn, Completed, Failed, ModelOption, TextDelta
from skaz.knowledge.agents.fake import FakeEngine, ScriptItem
from skaz.knowledge.ingest import prompts
from skaz.knowledge.ingest.runner import Limits
from tests.knowledge.ingest_support import (
    W2_EMPTY_ANSWERS,
    PatternDetector,
    add_material,
    block,
    cite,
    settle,
)
from tests.knowledge.test_ingest_pipeline import CONCEPTS_OK, NOTES_OK

ONE = ("Энтропия", [block("from_source", "Энтропия определяется как мера беспорядка системы.",
                          cite(1, "мера беспорядка системы"))])
TWO = ("Температура", [block("from_source", "Температура связана со средней кинетической энергией частиц.",
                             cite(2, "среднюю кинетическую энергию частиц"))])


def section(item: tuple[str, list[dict[str, Any]]]) -> str:
    return json.dumps({"title": item[0], "blocks": item[1]}, ensure_ascii=False)


def unsent() -> list[ScriptItem]:
    return [Failed("", "other", "Codex could not start.", unsent=True)]


def dropped() -> list[ScriptItem]:
    return [Failed("", "network", "The connection to Codex dropped.")]


def ok(text: str = NOTES_OK) -> list[ScriptItem]:
    return [TextDelta("", text), Completed("")]


async def _run(kb_app: Any, kb_client: httpx.AsyncClient,
               notes_answers: list[list[ScriptItem]],
               title: str = "Лекция 8") -> tuple[dict[str, Any], list[AgentTurn]]:
    await kb_client.post("/kb/library", json={})
    runtime = kb_app.state.runtime
    runtime.kb_ingest.limits = Limits(retry_delays_s=(0.0,))
    queue = list(notes_answers)

    def answer(turn: AgentTurn) -> list[ScriptItem]:
        assert turn.response_schema is not None
        title = turn.response_schema["title"]
        if title == prompts.NOTES_SCHEMA_TITLE:
            return queue.pop(0)
        result = (CONCEPTS_OK if title == prompts.CONCEPTS_SCHEMA_TITLE
                  else W2_EMPTY_ANSWERS.get(str(title), '{"choice":0}'))
        return [TextDelta("", result), Completed("")]

    engine = FakeEngine("codex", script=answer, models=[ModelOption("retry-model", "Retry", ("low",), "low")])
    runtime.kb_ingest.engines = lambda _engine: engine
    runtime.kb_ingest.detector = PatternDetector()
    saved = await kb_client.put("/kb/settings/wiki", json={"wiki_engine": "codex",
                                                            "wiki_model": "retry-model",
                                                            "wiki_effort": "low"})
    assert saved.status_code == 200, saved.text
    material_id = add_material(runtime.kb, "Physics", title, kind="pdf")
    job = (await kb_client.post(f"/kb/materials/{material_id}/ingest")).json()
    await settle(lambda: not runtime.kb_ingest.active_jobs())
    record: dict[str, Any] = (await kb_client.get(f"/kb/jobs/{job['id']}")).json()
    notes_turns = [turn for turn in engine.turns if turn.response_schema is not None
                   and turn.response_schema["title"] == prompts.NOTES_SCHEMA_TITLE]
    return record, notes_turns


async def test_a_request_that_never_left_is_retried_up_to_three_times(
    kb_app: Any, kb_client: httpx.AsyncClient,
) -> None:
    done, turns = await _run(kb_app, kb_client, [unsent(), unsent(), unsent(), ok()])
    assert done["state"] == "done", done["error"]
    assert len(turns) == 4


async def test_a_fourth_failure_before_sending_fails_the_job(
    kb_app: Any, kb_client: httpx.AsyncClient,
) -> None:
    failed, turns = await _run(kb_app, kb_client, [unsent(), unsent(), unsent(), unsent(), ok()])
    assert failed["state"] == "failed" and failed["can_retry"] is True
    assert len(turns) == 4
    assert "Codex could not start" in failed["error"]


async def test_a_request_that_may_have_been_sent_is_retried_exactly_once(
    kb_app: Any, kb_client: httpx.AsyncClient,
) -> None:
    done, turns = await _run(kb_app, kb_client, [dropped(), ok()])
    assert done["state"] == "done", done["error"]
    assert len(turns) == 2
    failed, turns = await _run(kb_app, kb_client, [dropped(), dropped(), ok()], title="Лекция 9")
    assert failed["state"] == "failed" and failed["can_retry"] is True
    assert len(turns) == 2  # never a third, possibly paid, attempt
    assert "dropped" in failed["error"] and "tried once more" in failed["error"]


async def test_a_crash_mid_answer_continues_once_from_the_finished_sections_then_fails_honestly(
    kb_app: Any, kb_client: httpx.AsyncClient,
) -> None:
    first = '{"sections": [' + section(ONE) + ', {"title": "Темп'
    again = '{"sections": [' + section(TWO) + ', {"title": "Рост'
    crashed = Failed("", "other", "Codex stopped unexpectedly.")
    failed, turns = await _run(kb_app, kb_client, [[TextDelta("", first), crashed],
                                                   [TextDelta("", again), crashed], ok()])
    assert failed["state"] == "failed"
    assert len(turns) == 2
    # The retry continued from the finished section instead of starting over.
    assert json.loads(turns[1].messages[1].content)["sections"][0]["title"] == "Энтропия"
    assert "Retry continues from them" in failed["error"]


def test_unknown_dispatch_is_treated_as_may_have_been_sent() -> None:
    # Adapters mark ``unsent`` only where they know (test_codex_engine, test_agent_claude_code,
    # test_agent_hermes); everything else may have been paid for.
    assert Failed("r", "network", "dropped").unsent is False
    assert Failed("r", "other", "busy", unsent=True) == Failed("r", "other", "busy")  # equality unchanged


async def test_follow_up_wiki_calls_use_the_same_retry_policy() -> None:
    """Connections, overviews and disagreement checks go through ``AgentCaller.ask``."""
    import pytest

    from skaz.knowledge.wiki.agent import AgentCaller, WikiJobFailed

    answers: list[list[ScriptItem]] = [unsent(), unsent(), unsent(), [TextDelta("", "{}"), Completed("")]]
    engine = FakeEngine("codex", script=lambda _turn: answers.pop(0))
    assert await AgentCaller(engine, "t", retry_delays_s=(0.0,)).ask("x", [], {}) == "{}"
    assert len(engine.turns) == 4
    answers = [dropped(), [TextDelta("", "{}"), Completed("")]]
    engine = FakeEngine("codex", script=lambda _turn: answers.pop(0))
    assert await AgentCaller(engine, "t", retry_delays_s=(0.0,)).ask("x", [], {}) == "{}"
    answers = [dropped(), dropped(), [TextDelta("", "{}"), Completed("")]]
    engine = FakeEngine("codex", script=lambda _turn: answers.pop(0))
    with pytest.raises(WikiJobFailed) as failure:
        await AgentCaller(engine, "t", retry_delays_s=(0.0,)).ask("x", [], {})
    assert len(engine.turns) == 2 and "tried once more" in failure.value.message
