"""Bug 1 (2026-10-26): a test or deck opened from the wiki lives beside the chat only.

It belongs to SKAZ's own wiki-study thread — never the chat that happens to be open, never listed —
goes on where it stopped when opened again, and an open answer is checked by the agent a new chat
would get (the default agent with its last model and effort), fixed for the block when it is made.
"""
from __future__ import annotations

import asyncio
from typing import Any

import httpx

from skaz.knowledge.agents.engine import AgentTurn, ModelOption
from skaz.knowledge.agents.fake import FakeEngine
from skaz.knowledge.agents.last_choice import LastChoice
from skaz.knowledge.agents.registry import EngineRegistry
from skaz.knowledge.chats.store import WIKI_STUDY_CHAT_ID
from tests.knowledge.chat_support import text
from tests.knowledge.test_s_study import _saved_deck, _test, world  # noqa: F401 - the study world


async def _saved_test(runtime: Any, library: Any) -> str:
    block = await _test(runtime, library)
    saved = await asyncio.to_thread(runtime.kb_study.save, block.id, "allow")
    page_id: str = saved.page_id
    return page_id


async def _open(client: httpx.AsyncClient, page_id: str, **body: Any) -> dict[str, Any]:
    response = await client.post(f"/kb/study/decks/{page_id}/study", json={"mode": "all", **body})
    assert response.status_code == 200, response.text
    started: dict[str, Any] = response.json()
    return started


async def test_a_deck_from_the_wiki_never_joins_the_open_chat(
    world: Any, kb_client: httpx.AsyncClient  # noqa: F811
) -> None:
    runtime, library, ref = world
    page_id = await _saved_deck(runtime, library)
    before = (await kb_client.get(f"/kb/chats/{ref.chat_id}")).json()["messages"]

    started = await _open(kb_client, page_id, chat_id=ref.chat_id)  # an older caller names the open chat

    assert started["chat_id"] == WIKI_STUDY_CHAT_ID and started["study"]["place"] == "panel"
    assert (await kb_client.get(f"/kb/chats/{ref.chat_id}")).json()["messages"] == before
    listed = (await kb_client.get("/kb/chats")).json()
    assert WIKI_STUDY_CHAT_ID not in {chat["id"] for chat in listed}
    assert ref.chat_id in {chat["id"] for chat in listed}


async def test_a_deck_opened_again_goes_on_where_it_stopped_and_a_finished_pass_starts_anew(
    world: Any, kb_client: httpx.AsyncClient  # noqa: F811
) -> None:
    runtime, library, _ref = world
    page_id = await _saved_deck(runtime, library)
    first = (await _open(kb_client, page_id))["study"]
    card = first["cards"][0]["id"]
    graded = await kb_client.post(f"/kb/study/{first['id']}/grade", json={"item_id": card, "grade": "good"})
    assert graded.status_code == 200, graded.text

    again = (await _open(kb_client, page_id))["study"]
    assert again["id"] == first["id"] and again["position"] == 1

    block = runtime.kb_study.get(first["id"])
    await asyncio.to_thread(runtime.kb_study.store.update_block, block.id, position=len(first["cards"]))
    fresh = (await _open(kb_client, page_id))["study"]
    assert fresh["id"] != first["id"] and fresh["position"] == 0


async def test_a_test_opened_again_keeps_its_answers_and_result_until_retake(
    world: Any, kb_client: httpx.AsyncClient  # noqa: F811
) -> None:
    runtime, library, _ref = world
    page_id = await _saved_test(runtime, library)
    first = (await _open(kb_client, page_id))["study"]
    question = first["questions"][0]
    choice = question["options"][0]["id"]
    answered = await kb_client.post(f"/kb/study/{first['id']}/answer",
                                    json={"item_id": question["id"], "choices": [choice]})
    assert answered.status_code == 200, answered.text

    again = (await _open(kb_client, page_id))["study"]
    assert again["id"] == first["id"] and again["questions"][0]["response"] is not None

    assert (await kb_client.post(f"/kb/study/{first['id']}/finish")).status_code == 200
    done = (await _open(kb_client, page_id))["study"]
    assert done["id"] == first["id"] and done["result"] is not None  # the result, with Retake
    retaken = (await kb_client.post(f"/kb/study/{first['id']}/retake", json={"mistakes_only": False})).json()
    assert retaken["result"] is None and retaken["questions"][0]["response"] is None


async def test_open_answers_are_checked_by_the_default_agent_with_its_last_model_fixed_at_opening(
    world: Any, kb_client: httpx.AsyncClient  # noqa: F811
) -> None:
    runtime, library, _ref = world
    turns: list[AgentTurn] = []

    def judge(turn: AgentTurn) -> Any:
        turns.append(turn)
        return text('{"verdict": "right", "missing": "", "comment": "Да."}')

    models = (ModelOption("fast", "Fast", ("low", "high"), "low"),
              ModelOption("deep", "Deep", ("medium", "xhigh")))
    engines: dict[str, Any] = {engine: FakeEngine(engine, script=judge, models=models)  # type: ignore[arg-type]
                               for engine in ("codex", "claude_code", "hermes", "opencode")}
    registry = EngineRegistry(engines, runtime.kb.settings, cache_s=0.0)  # type: ignore[arg-type]
    runtime.kb_agents.registry = registry
    LastChoice(runtime.kb.settings).remember("codex", "deep", "xhigh")
    page_id = await _saved_test(runtime, library)

    block = (await _open(kb_client, page_id))["study"]
    LastChoice(runtime.kb.settings).remember("codex", "fast", "low")  # later choices don't change it
    open_question = next(q for q in block["questions"] if q["type"] == "open")
    checking = await kb_client.post(f"/kb/study/{block['id']}/check-open",
                                    json={"item_id": open_question["id"], "text": "Энтропия растёт."})
    assert checking.status_code == 200, checking.text
    await runtime.kb_study.settle()

    (turn,) = turns
    assert (turn.model, turn.effort) == ("deep", "xhigh")
    response = next(q for q in (await kb_client.get(f"/kb/study/{block['id']}")).json()["questions"]
                    if q["id"] == open_question["id"])["response"]
    assert response["verdict"] == "right" and response["checked_by"] == "Codex · Deep"
