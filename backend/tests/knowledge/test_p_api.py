"""0.3.1 P, step 3: the P API — permission and question parts, ``part_update``, decide / undo /
answer routes, ``waiting_for_user`` in the chat list and its events.

The agent is ``p_support.ToolEngine`` (a fake at the agent seam that calls the real SKAZ tools).
"""
from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

import httpx
import pytest

from skaz.knowledge.agents.engine import TextDelta
from skaz.knowledge.agents.registry import EngineRegistry
from skaz.knowledge.permissions.questions import LATE, OWN_WORDS

from .chat_support import Library, connect, finished
from .p_support import Ask, Invoke, ToolEngine

QUOTE = "мера беспорядка системы"


@dataclass
class Env:
    client: httpx.AsyncClient
    runtime: Any
    engine: ToolEngine
    library: Library

    async def chat(self) -> dict[str, Any]:
        response = await self.client.post("/kb/chats", json={"engine": "codex"})
        assert response.status_code == 201, response.text
        return dict(response.json())

    async def send(self, chat_id: str, text: str) -> dict[str, Any]:
        response = await self.client.post(f"/kb/chats/{chat_id}/messages", json={"text": text})
        assert response.status_code == 202, response.text
        return dict(response.json())

    async def chat_view(self, chat_id: str) -> dict[str, Any]:
        return dict((await self.client.get(f"/kb/chats/{chat_id}")).json())

    async def part_of(self, chat_id: str, kind: str) -> dict[str, Any]:
        for _ in range(300):
            chat = await self.chat_view(chat_id)
            for message in chat["messages"]:
                for part in message["parts"]:
                    if part["type"] == kind:
                        return dict(part)
            await asyncio.sleep(0.01)
        raise AssertionError(f"no {kind} part")


@pytest.fixture
async def env(kb_app: Any, kb_client: httpx.AsyncClient) -> AsyncIterator[Env]:
    runtime = kb_app.state.runtime
    engine = ToolEngine(runtime)
    engines: dict[str, Any] = {"codex": engine, "claude_code": ToolEngine(runtime, "claude_code"),
                               "hermes": ToolEngine(runtime, "hermes")}
    runtime.kb_agents.registry = EngineRegistry(engines, runtime.kb.settings, cache_s=0.0)  # type: ignore[arg-type]
    library = await connect(kb_client, runtime)
    yield Env(kb_client, runtime, engine, library)
    await runtime.kb_chats.close()


def _create(library: Library) -> Invoke:
    return Invoke("skaz_wiki_create_page", {
        "title": "Беспорядок", "kind": "concept",
        "blocks": [{"text": "Энтропия измеряет беспорядок.",
                    "citations": [{"material_id": library.lecture, "seg": 1, "quote": QUOTE}]}]})


async def test_permission_card_waits_is_decided_and_undone_over_the_api(env: Env) -> None:
    env.engine.script = lambda _turn: [_create(env.library), TextDelta("", "Готово.")]
    chat = await env.chat()
    cursor = chat["cursor"]
    lists = (await env.client.get("/kb/chats/events")).json()["cursor"]
    sent = await env.send(chat["id"], "Создай страницу")

    part = await env.part_of(chat["id"], "permission")
    assert (part["kind"], part["status"], part["engine"], part["auto"]) == (
        "create", "pending", "codex", False)
    assert part["summary"] == {"added": 1, "changed": 0, "removed": 0, "user_notes_untouched": True}
    assert part["changes"][0]["label"] == "Added" and part["changes"][0]["block_kind"] == "from_source"
    assert part["path"] == "Wiki/Concepts/Беспорядок.md" and part["undoable"] is False
    events = (await env.client.get(f"/kb/chats/{chat['id']}/events", params={"after": cursor})).json()
    assert any(event["type"] == "part" and event["part"]["type"] == "permission"
               for event in events["events"])
    listed = {item["id"]: item for item in (await env.client.get("/kb/chats")).json()}
    assert listed[chat["id"]]["waiting_for_user"] is True and listed[chat["id"]]["state"] == "answering"
    changed = (await env.client.get("/kb/chats/events", params={"after": lists})).json()["chats"]
    assert any(item["id"] == chat["id"] and item["waiting_for_user"] for item in changed)

    after = events["cursor"]
    decided = await env.client.post(f"/kb/permissions/{part['id']}/decide", json={"decision": "allow"})
    assert decided.status_code == 200 and decided.json()["status"] == "allowed"
    await finished(env.runtime.kb_chats)
    again = await env.client.post(f"/kb/permissions/{part['id']}/decide", json={"decision": "deny"})
    assert again.status_code == 409 and again.json()["code"] == "ALREADY_DECIDED"
    updates = (await env.client.get(f"/kb/chats/{chat['id']}/events",
                                    params={"after": after})).json()["events"]
    assert any(event["type"] == "part_update" and event["part"]["id"] == part["id"]
               and event["part"]["undoable"] for event in updates)
    messages = (await env.chat_view(chat["id"]))["messages"]
    message = next(m for m in messages if m["id"] == sent["assistant"]["id"])
    final = next(p for p in message["parts"] if p["type"] == "permission")
    assert final["status"] == "allowed" and final["undoable"] is True and final["page_id"]
    assert env.engine.outcomes[0].startswith('{"status":"applied"')
    listed = {item["id"]: item for item in (await env.client.get("/kb/chats")).json()}
    assert listed[chat["id"]]["waiting_for_user"] is False

    undone = await env.client.post(f"/kb/permissions/{part['id']}/undo")
    assert undone.status_code == 200 and undone.json()["status"] == "undone"
    assert env.runtime.kb.page_repo.get(final["page_id"]) is None
    twice = await env.client.post(f"/kb/permissions/{part['id']}/undo")
    assert twice.status_code == 409 and twice.json()["code"] == "NOT_APPLIED"
    assert (await env.client.post("/kb/permissions/perm-nope/decide",
                                  json={"decision": "allow"})).status_code == 404
    long = await env.client.post(f"/kb/permissions/{part['id']}/decide",
                                 json={"decision": "deny", "reason": "x" * 501})
    assert long.status_code == 422


async def test_deny_reason_reaches_the_agent_and_stop_cancels_the_card(env: Env) -> None:
    env.engine.script = lambda _turn: [_create(env.library), _create(env.library)]
    chat = await env.chat()
    await env.send(chat["id"], "Создай")
    part = await env.part_of(chat["id"], "permission")
    await env.client.post(f"/kb/permissions/{part['id']}/decide",
                          json={"decision": "deny", "reason": "Не надо"})
    for _ in range(300):
        if len(env.runtime.kb_permissions.store.pending_permissions()) == 1:
            break
        await asyncio.sleep(0.01)
    assert env.engine.outcomes[0] == '{"status":"denied","reason":"Не надо"}'
    second = env.runtime.kb_permissions.store.pending_permissions()[0]
    message_id = second.message_id
    stopped = await env.client.post(f"/kb/chats/{chat['id']}/messages/{message_id}/stop")
    assert stopped.status_code == 200
    await finished(env.runtime.kb_chats)
    assert env.engine.outcomes[1].startswith('{"status":"cancelled"')
    view = await env.chat_view(chat["id"])
    statuses = [p["status"] for m in view["messages"] for p in m["parts"] if p["type"] == "permission"]
    assert statuses == ["denied", "cancelled"] and view["waiting_for_user"] is False


async def test_question_answered_by_option_own_message_and_later_option(env: Env) -> None:
    options = (("Cards", "Flashcards from the lecture", False), ("Test", "A short test", True))
    env.engine.script = lambda turn: (
        [Ask("Cards or a test?", options), TextDelta("", "Ок.")]
        if "Сделай" in turn.messages[-1].content else [TextDelta("", "Принято.")])
    chat = await env.chat()
    await env.send(chat["id"], "Сделай что-нибудь")
    part = await env.part_of(chat["id"], "question")
    assert part["status"] == "pending" and part["allow_other"] is True and part["engine"] == "codex"
    assert [option["label"] for option in part["options"]] == ["Test", "Cards"]  # recommended first
    assert part["options"][0]["recommended"] is True and part["options"][0]["description"] == "A short test"
    assert (await env.chat_view(chat["id"]))["waiting_for_user"] is True
    bad = await env.client.post(f"/kb/questions/{part['id']}/answer", json={"option_index": 1, "text": "x"})
    assert bad.status_code == 422
    answered = await env.client.post(f"/kb/questions/{part['id']}/answer", json={"option_index": 0})
    assert answered.status_code == 200 and answered.json()["answer"] == "Test"
    await finished(env.runtime.kb_chats)
    assert env.engine.outcomes == ["answered:Test"]
    again = await env.client.post(f"/kb/questions/{part['id']}/answer", json={"option_index": 1})
    assert again.status_code == 409

    # The user writes their own message while the next question waits: it closes the question.
    env.engine.outcomes.clear()
    sent = await env.send(chat["id"], "Сделай ещё")
    second = None
    for _ in range(300):
        found = env.runtime.kb_questions.store.pending_questions(chat_id=chat["id"])
        if found:
            second = found[0]
            break
        await asyncio.sleep(0.01)
    assert second is not None
    own = await env.send(chat["id"], "Лучше кратко перескажи")
    assert own["assistant"]["id"] == sent["assistant"]["id"] and own["user"]["role"] == "user"
    await finished(env.runtime.kb_chats)
    assert env.engine.outcomes == [f"answered:{OWN_WORDS.format(text='Лучше кратко перескажи')}"]
    closed = env.runtime.kb_questions.get(second.id)
    assert closed.status == "superseded" and closed.answer is None

    # Picking an option later sends it as a new message.
    late = await env.client.post(f"/kb/questions/{second.id}/answer", json={"option_index": 1})
    assert late.status_code == 200 and late.json()["status"] == "answered"
    await finished(env.runtime.kb_chats)
    texts = [m["input"]["text"] for m in (await env.chat_view(chat["id"]))["messages"] if m["role"] == "user"]
    assert texts[-1] == LATE.format(answer="Cards")


async def test_skaz_ask_user_is_the_question_tool_and_the_agent_card_says_so(env: Env) -> None:
    """Q-A1: no installed agent's native question tool works with SKAZ yet (``permissions/ask_tool.py``),
    so each gets ``skaz_ask_user`` and its card says "Questions: through SKAZ" ahead of time."""
    ask = Invoke("skaz_ask_user", {"question": "Which lecture?", "recommended_index": 1, "options": [
        {"label": "Lecture 1", "description": "Thermodynamics"},
        {"label": "Lecture 3", "description": "Entropy"}]})
    env.engine.script = lambda _turn: [ask, TextDelta("", "Ок.")]
    chat = await env.chat()
    await env.send(chat["id"], "Объясни")
    part = await env.part_of(chat["id"], "question")
    assert [option["label"] for option in part["options"]] == ["Lecture 3", "Lecture 1"]
    offered = env.engine.turns[0].tools
    assert offered is not None and "skaz_ask_user" in {spec.name for spec in offered}
    answered = await env.client.post(f"/kb/questions/{part['id']}/answer", json={"text": "Обе"})
    assert answered.status_code == 200
    await finished(env.runtime.kb_chats)
    assert env.engine.outcomes == ['{"status":"answered","answer":"Обе"}']
    bad = await env.runtime.kb_tools.call("skaz_ask_user", {"question": "Q?", "recommended_index": 2,
                                                            "options": [{"label": "A"}]}, None)
    assert bad.is_error

    agents = (await env.client.get("/kb/agents")).json()["agents"]
    assert {agent["id"]: agent["questions"] for agent in agents} == {
        "codex": "skaz", "claude_code": "skaz", "hermes": "skaz"}
