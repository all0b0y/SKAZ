"""EX2 X3: the Research task card — proposed, typed and picked topics; the grant flow carries the final card.

Scenarios from G2: a Russian description, a card the user edited, topics picked from the user's own map, and
``research_finished`` read 1 s after it was created (it now stays unread until the user opens the task).
Same environment as B3 (``test_b3_research``): the real app with a scripted agent and a fake funnel.
"""

from __future__ import annotations

import json
from typing import Any

import httpx

from skaz.knowledge.api.schemas_explore import KbSearchPlanItem
from skaz.knowledge.research.agent import TOPICS_INSTRUCTIONS
from skaz.knowledge.research.store import TaskRow

from . import test_b3_research as b3
from .chat_support import finished
from .test_b3_research import DESCRIPTION, Env, counters, finding

#: B3's environment: the real app, a scripted agent and a fake funnel.
env = b3.env

RUSSIAN = "Найди, что нового в проверке утверждений для моей вики; это попросил коллега"


def topic(text: str, source: str = "typed", area_id: str | None = None) -> dict[str, Any]:
    return {"text": text, "source": source, "area_id": area_id}


def topic_turns(env: Env) -> int:
    return sum(turn.instructions == TOPICS_INSTRUCTIONS for turn in env.agents["codex"].turns)


# -- the proposal ("+ New research task", before anything starts) -----------------------------------------


async def test_a_proposal_shows_the_agents_title_and_topics_and_starts_nothing(env: Env) -> None:
    env.agents["codex"].topics = {
        "title": "Проверка утверждений", "topics": ["проверка утверждений", "fact-checking"]
    }
    chats_before = (await env.client.get("/kb/chats")).json()
    response = await env.client.post("/kb/research/proposals", json={"description": RUSSIAN})
    assert response.status_code == 200, response.text
    assert response.json() == {
        "title": "Проверка утверждений",
        "topics": [topic("проверка утверждений", "proposed"), topic("fact-checking", "proposed")],
    }
    # Only the chat agent saw the description; nothing was sent, no task, no chat, no run.
    assert topic_turns(env) == 1 and env.funnel.bodies == []
    assert (await env.client.get("/kb/research/tasks")).json()["tasks"] == []
    assert (await env.client.get("/kb/chats")).json() == chats_before


async def test_a_proposal_without_a_usable_agent_answer_is_honest(env: Env) -> None:
    env.agents["codex"].fail = "boom"
    response = await env.client.post("/kb/research/proposals", json={"description": DESCRIPTION})
    assert (response.status_code, response.json()) == (502, {"code": "provider_unavailable"})
    assert env.funnel.bodies == []


async def test_a_proposal_is_not_ready_without_a_library(kb_client: httpx.AsyncClient) -> None:
    response = await kb_client.post("/kb/research/proposals", json={"description": DESCRIPTION})
    assert (response.status_code, response.json()) == (503, {"code": "not_ready"})


# -- the card as the user left it ----------------------------------------------------------------------------


async def test_a_task_starts_with_exactly_the_cards_topics_and_no_derivation(env: Env) -> None:
    card = [
        topic("LLM agent harness"),
        topic("AI agents", "picked", "area-ai"),
        topic("claim verification at scale", "proposed"),
    ]
    response = await env.client.post(
        "/kb/research/tasks", json={"description": RUSSIAN, "topics": card}
    )
    assert response.status_code == 200, response.text
    task = response.json()
    assert topic_turns(env) == 0  # no derivation: the agent is not asked again
    assert task["topics"] == card and task["description"] == RUSSIAN
    assert task["title"] == "LLM agent harness"
    # The funnel searches and judges by exactly these topics (X2's plan); the description never leaves.
    (task_id, title, body), = env.funnel.bodies
    assert (task_id, title) == (task["id"], "LLM agent harness")
    assert body.plan == [
        KbSearchPlanItem(area_id=None, label="LLM agent harness", terms=["LLM agent harness"]),
        KbSearchPlanItem(area_id="area-ai", label="AI agents", terms=["AI agents"]),
        KbSearchPlanItem(
            area_id=None, label="claim verification at scale", terms=["claim verification at scale"]
        ),
    ]
    assert body.query == "" and "Найди" not in body.model_dump_json()
    # A topic picked from the map searches around it too (its continuations and neighbours).
    assert body.channels == ["continues", "branches", "search"]
    # The task keeps every topic with its source and area, also after a reread.
    again = (await env.client.get(f"/kb/research/tasks/{task['id']}")).json()
    assert again["topics"] == card
    listed = (await env.client.get("/kb/research/tasks")).json()["tasks"]
    assert listed[0]["topics"] == card
    note = (await env.messages(task["chat_id"]))[1]["parts"][0]["text"]
    assert "LLM agent harness · AI agents · claim verification at scale" in note


async def test_the_proposals_title_names_a_task_started_from_the_card(env: Env) -> None:
    """The «+» card sends the title it showed; without it the first topic names the task."""
    response = await env.client.post(
        "/kb/research/tasks",
        json={
            "description": RUSSIAN,
            "topics": [topic("LLM agent harness")],
            "title": "Methods for AI harness",
        },
    )
    assert response.status_code == 200, response.text
    task = response.json()
    assert task["title"] == "Methods for AI harness"
    (_, title, _), = env.funnel.bodies
    assert title == "Methods for AI harness"


async def test_card_topics_are_tidied_but_never_changed_or_filtered(env: Env) -> None:
    card = [topic("  graph   neural  networks "), topic("Graph neural networks", "proposed"), topic("rag")]
    request = {"description": DESCRIPTION, "topics": card}
    task = (await env.client.post("/kb/research/tasks", json=request)).json()
    # Spaces are tidied; the same topic twice is sent once (the first one wins).
    assert task["topics"] == [topic("graph neural networks"), topic("rag")]
    (_, _, body), = env.funnel.bodies
    assert [item.terms for item in body.plan or []] == [["graph neural networks"], ["rag"]]
    assert body.channels == ["search"]


async def test_a_card_with_a_blank_topic_starts_nothing(env: Env) -> None:
    response = await env.client.post(
        "/kb/research/tasks", json={"description": DESCRIPTION, "topics": [topic("   ")]}
    )
    assert (response.status_code, response.json()) == (422, {"code": "invalid_request"})
    too_many = [topic(f"topic {n}") for n in range(5)]
    request = {"description": DESCRIPTION, "topics": too_many}
    response = await env.client.post("/kb/research/tasks", json=request)
    assert response.status_code == 422
    assert env.funnel.bodies == [] and topic_turns(env) == 0


async def test_without_a_card_the_agents_topics_start_as_proposed(env: Env) -> None:
    task = (await env.client.post("/kb/research/tasks", json={"description": DESCRIPTION})).json()
    assert task["topics"] == [
        topic("claim verification", "proposed"), topic("fact-checking knowledge bases", "proposed")
    ]
    (_, _, body), = env.funnel.bodies
    assert [item.label for item in body.plan or []] == ["claim verification", "fact-checking knowledge bases"]


async def test_a_task_from_before_ex2_shows_its_topics_as_proposed(env: Env) -> None:
    task = (await env.client.post("/kb/research/tasks", json={"description": DESCRIPTION})).json()
    with env.research.store.db.write() as connection:  # the row as a pre-EX2 build wrote it
        connection.execute(
            "UPDATE research_tasks SET request_json = ? WHERE id = ?",
            (json.dumps({"topics": ["neural search"], "funnel": {}}), task["id"]),
        )
    row = env.research.store.task(task["id"])
    assert isinstance(row, TaskRow) and row.topics == ["neural search"]
    shown = (await env.client.get(f"/kb/research/tasks/{task['id']}")).json()
    assert shown["topics"] == [topic("neural search", "proposed")]


# -- the in-chat card: Allow carries the final topics -----------------------------------------------------


async def start_card(env: Env) -> tuple[str, dict[str, Any]]:
    env.agents["codex"].starts = [{"description": DESCRIPTION}]
    chat_id = await env.chat("codex")
    await env.send(chat_id)
    return chat_id, await env.pending(chat_id)


async def test_allow_starts_with_the_card_as_the_user_left_it(env: Env) -> None:
    chat_id, card = await start_card(env)
    final = [topic("claim verification", "proposed"), topic("Knowledge graphs", "picked", "area-kg"),
             topic("source scoring")]
    response = await env.client.post(
        f"/kb/research/permissions/{card['id']}/decide", json={"decision": "allow", "topics": final}
    )
    assert response.status_code == 200, response.text
    decided = response.json()
    # The pointer shows what actually left, not what was proposed.
    assert decided["status"] == "allowed"
    assert decided["topics"] == ["claim verification", "Knowledge graphs", "source scoring"]
    await finished(env.runtime.kb_chats)
    task = (await env.client.get(f"/kb/research/tasks/{decided['task_id']}")).json()
    assert task["topics"] == final and task["title"] == "Claim verification"
    (_, _, body), = env.funnel.bodies
    assert [(item.area_id, item.terms) for item in body.plan or []] == [
        (None, ["claim verification"]), ("area-kg", ["Knowledge graphs"]), (None, ["source scoring"])
    ]
    assert topic_turns(env) == 1  # the card's proposal only
    (pointer,) = await env.cards(chat_id)
    assert pointer["topics"] == ["claim verification", "Knowledge graphs", "source scoring"]
    data = json.loads(env.agents["codex"].outputs[-1][0].split("\n", 2)[2].rsplit("\n", 1)[0])
    assert [t["text"] for t in data["result"]["task"]["topics"]] == [t["text"] for t in final]


async def test_allow_without_topics_starts_as_proposed(env: Env) -> None:
    _, card = await start_card(env)
    decided = (await env.decide(card["id"], "allow")).json()
    await finished(env.runtime.kb_chats)
    task = (await env.client.get(f"/kb/research/tasks/{decided['task_id']}")).json()
    assert task["topics"] == [
        topic("claim verification", "proposed"), topic("fact-checking knowledge bases", "proposed")
    ]


async def test_allow_in_this_chat_carries_the_final_card_too(env: Env) -> None:
    chat_id, card = await start_card(env)
    final = [topic("retrieval augmented generation")]
    response = await env.client.post(
        f"/kb/research/permissions/{card['id']}/decide", json={"decision": "allow_chat", "topics": final}
    )
    assert response.json()["status"] == "allowed"
    await finished(env.runtime.kb_chats)
    task = (await env.client.get(f"/kb/research/tasks/{response.json()['task_id']}")).json()
    assert task["topics"] == final
    assert (await env.client.get(f"/kb/chats/{chat_id}/research-grant")).json()["allowed"] is True


async def test_deny_with_topics_still_sends_nothing(env: Env) -> None:
    _, card = await start_card(env)
    response = await env.client.post(
        f"/kb/research/permissions/{card['id']}/decide",
        json={"decision": "deny", "topics": [topic("anything")]},
    )
    assert response.json()["status"] == "denied"
    await finished(env.runtime.kb_chats)
    assert env.funnel.bodies == []


async def test_a_blank_topic_on_allow_keeps_the_card_waiting(env: Env) -> None:
    chat_id, card = await start_card(env)
    response = await env.client.post(
        f"/kb/research/permissions/{card['id']}/decide",
        json={"decision": "allow", "topics": [topic("  ")]},
    )
    assert (response.status_code, response.json()) == (422, {"code": "invalid_request"})
    assert (await env.pending(chat_id))["id"] == card["id"] and env.funnel.bodies == []
    assert (await env.decide(card["id"], "allow")).json()["status"] == "allowed"
    await finished(env.runtime.kb_chats)


# -- research_finished stays unread until the user opens the task -------------------------------------------


async def test_research_finished_is_read_only_by_its_own_read(env: Env) -> None:
    task = (await env.client.post("/kb/research/tasks", json={"description": DESCRIPTION})).json()
    env.funnel.found[task["id"]] = [finding(1, "new", task["id"])]
    env.funnel.set(task["run"]["id"], state="done", stage="ready", stop_reason="completed",
                   counters=counters(checked=5, on_topic=1, new=1))
    await env.research.settled(task["id"])
    other = env.runtime.kb.notification_repo.add("explore_finished", "Search", body="0 new")
    feed = (await env.client.get("/kb/notifications")).json()
    finished_note = next(item for item in feed["items"] if item["kind"] == "research_finished")
    # Looking at the bell reads everything up to its cursor, except the finished task.
    response = await env.client.post("/kb/notifications/read", json={"up_to_seq": feed["cursor"]})
    assert response.status_code == 204
    repo = env.runtime.kb.notification_repo
    assert repo.get(other.id).read_at is not None
    assert repo.get(finished_note["id"]).read_at is None
    # Reading the task's chat doesn't read it either.
    assert (await env.client.post(f"/kb/chats/{task['chat_id']}/read")).status_code == 204
    assert repo.get(finished_note["id"]).read_at is None
    # Opening the finished task does.
    response = await env.client.post(f"/kb/notifications/{finished_note['id']}/read")
    assert response.status_code == 204
    assert repo.get(finished_note["id"]).read_at is not None
