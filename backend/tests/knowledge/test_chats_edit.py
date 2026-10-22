"""Editing your own question in place (2026-10-21, chat-actions mock «In place, later replies redone»).

``POST /kb/chats/{id}/messages/{message_id}/edit`` replaces the question's input, removes every
later message of the chat and answers it again with the chat's current agent/model. Fake engines
script the answers; nothing here proves a real model.
"""
from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest

from skaz.knowledge.agents.engine import AgentTurn
from skaz.knowledge.agents.fake import Gate, ScriptItem
from tests.knowledge.chat_support import Agents, all_text, connect, finished, install, text
from tests.knowledge.ingest_support import settle
from tests.knowledge.test_chats_api import Env


@pytest.fixture
async def env(kb_app: Any, kb_client: httpx.AsyncClient) -> AsyncIterator[Env]:
    runtime = kb_app.state.runtime
    agents = Agents()
    install(runtime, agents)
    library = await connect(kb_client, runtime)
    yield Env(kb_client, runtime, runtime.kb_chats, agents, library)
    await runtime.kb_chats.close()


async def test_edit_replaces_the_question_removes_later_messages_and_answers_again(env: Env) -> None:
    turns: list[AgentTurn] = []

    def script(turn: AgentTurn) -> list[ScriptItem]:
        turns.append(turn)
        return text(f"Ответ {len(turns)}.")

    env.agents.scripts["codex"] = script
    chat = await env.chat()
    first = await env.answered(chat["id"], "Что такое SIEM?")
    second = await env.answered(chat["id"], "Нарисуй это вертикально")
    # A model change after the second answer: a system row that goes too.
    changed = await env.client.patch(f"/kb/chats/{chat['id']}", json={"model": "fake-model"})
    assert changed.status_code == 200
    third = await env.answered(chat["id"], "А по TOGAF?")
    messages = (await env.client.get(f"/kb/chats/{chat['id']}")).json()["messages"]
    question = next(m for m in messages
                    if m["role"] == "user" and m["input"]["text"] == "Нарисуй это вертикально")
    later = [m["id"] for m in messages if m["seq"] > question["seq"]]
    assert second["id"] in later and third["id"] in later and len(later) == 4
    cursor = (await env.client.get(f"/kb/chats/{chat['id']}")).json()["cursor"]

    edited = await env.client.post(f"/kb/chats/{chat['id']}/messages/{question['id']}/edit",
                                   json={"text": "Нарисуй это вертикально и сравни с XDR"})
    assert edited.status_code == 202, edited.text
    pair = edited.json()
    assert pair["user"]["id"] == question["id"]
    assert pair["user"]["input"]["text"] == "Нарисуй это вертикально и сравни с XDR"
    assert pair["assistant"]["state"] == "streaming" and pair["assistant"]["role"] == "assistant"
    assert pair["assistant"]["model"] == "fake-model"  # the chat's current model answers
    await finished(env.chats)

    after = (await env.client.get(f"/kb/chats/{chat['id']}")).json()["messages"]
    assert [m["id"] for m in after] == [messages[0]["id"], first["id"], question["id"],
                                        pair["assistant"]["id"]]
    assert after[2]["input"]["text"] == "Нарисуй это вертикально и сравни с XDR"
    assert all_text(after[2]) == "Нарисуй это вертикально и сравни с XDR"
    assert after[3]["state"] == "done" and all_text(after[3]) == "Ответ 4."
    assert after[3]["seq"] > after[2]["seq"]
    # The agent got the edited question with only the history before it.
    last = turns[-1]
    assert last.messages[-1].content.endswith("Нарисуй это вертикально и сравни с XDR")
    history = " ".join(message.content for message in last.messages)
    assert "А по TOGAF?" not in history and "Ответ 2." not in history and "Ответ 1." in history
    # Readers that follow the chat are told what went away.
    url = f"/kb/chats/{chat['id']}/events"
    events = (await env.client.get(url, params={"after": cursor})).json()["events"]
    removed = [e["message_id"] for e in events if e["type"] == "removed"]
    assert sorted(removed) == sorted(later)
    # Search no longer finds the removed question.
    found = (await env.client.get("/kb/chats", params={"q": "TOGAF"})).json()
    assert found == []


async def test_edit_keeps_mentions_quotes_and_attachments_and_the_saved_wiki_page(env: Env) -> None:
    lib = env.library
    env.agents.scripts["codex"] = lambda _turn: text("Энтропия — мера беспорядка.")
    chat = await env.chat()
    asked = await env.ask(chat["id"], "Что такое @Энтропия?",
                          mentions=[{"type": "page", "id": lib.concept, "title": "Энтропия"}],
                          context={"open_page_id": lib.concept})
    await finished(env.chats)
    answer = asked["assistant"]
    saved = await env.client.post(f"/kb/chats/{chat['id']}/messages/{answer['id']}/save")
    assert saved.status_code == 200, saved.text
    page_id = saved.json()["id"]

    edited = await env.client.post(
        f"/kb/chats/{chat['id']}/messages/{asked['user']['id']}/edit",
        json={"text": "Коротко: что такое @Энтропия?",
              "mentions": [{"type": "page", "id": lib.concept, "title": "Энтропия"}],
              "quotes": [{"source": "material", "id": lib.lecture, "seg": 1, "text": "мера беспорядка"}],
              "attachments": [lib.textbook]})
    assert edited.status_code == 202, edited.text
    await finished(env.chats)
    user = await env.message(chat["id"], asked["user"]["id"])
    assert user["input"]["mentions"] == [{"type": "page", "id": lib.concept, "title": "Энтропия"}]
    assert [q["text"] for q in user["input"]["quotes"]] == ["мера беспорядка"]
    assert user["input"]["attachments"] == [lib.textbook]
    # The answer saved to the wiki is gone from the chat; its page stays in the wiki.
    ids = [m["id"] for m in (await env.client.get(f"/kb/chats/{chat['id']}")).json()["messages"]]
    assert answer["id"] not in ids
    assert (await env.client.get(f"/kb/wiki/pages/{page_id}")).status_code == 200
    # The question still carries what was open when it was asked.
    stored = await asyncio.to_thread(env.chats.repo.message, chat["id"], asked["user"]["id"])
    assert stored is not None and stored.input is not None and stored.input.context.page_id == lib.concept


async def test_edit_is_refused_while_the_chat_answers_and_for_other_messages(env: Env) -> None:
    gate = asyncio.Event()
    replies = iter([text("Готово."), [*text("Пишу…"), Gate(gate)]])
    env.agents.scripts["codex"] = lambda _turn: next(replies)
    chat = await env.chat()
    done = await env.answered(chat["id"], "Первый вопрос")
    sent = await env.ask(chat["id"], "Второй вопрос")
    await settle(lambda: bool(env.agents.engines["codex"].active_runs()))
    messages = (await env.client.get(f"/kb/chats/{chat['id']}")).json()["messages"]
    first_question = messages[0]
    busy = await env.client.post(f"/kb/chats/{chat['id']}/messages/{first_question['id']}/edit",
                                 json={"text": "Другой вопрос"})
    assert busy.status_code == 409 and busy.json()["code"] == "ANSWERING"
    assert "still answering" in busy.json()["detail"]
    gate.set()
    await finished(env.chats)
    assert [m["id"] for m in (await env.client.get(f"/kb/chats/{chat['id']}")).json()["messages"]] == \
        [m["id"] for m in messages]  # nothing changed
    answer = await env.client.post(f"/kb/chats/{chat['id']}/messages/{done['id']}/edit", json={"text": "x"})
    assert answer.status_code == 422
    missing = await env.client.post(f"/kb/chats/{chat['id']}/messages/msg-missing/edit", json={"text": "x"})
    assert missing.status_code == 404
    empty = await env.client.post(f"/kb/chats/{chat['id']}/messages/{sent['user']['id']}/edit",
                                  json={"text": ""})
    assert empty.status_code == 422
    # The chat answers again after a refusal (nothing stayed reserved).
    env.agents.scripts["codex"] = lambda _turn: text("Снова.")
    again = await env.client.post(f"/kb/chats/{chat['id']}/messages/{sent['user']['id']}/edit",
                                  json={"text": "Второй вопрос, иначе"})
    assert again.status_code == 202, again.text
    await finished(env.chats)
