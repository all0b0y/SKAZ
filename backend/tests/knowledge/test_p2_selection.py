"""P2: asking about items picked in an earlier answer — checked against the stored answer, told to the
agent as untrusted data with their sources, kept with the question (the chip), never trusted from
the client beyond the ids."""
from __future__ import annotations

import json
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

import httpx
import pytest

from skaz.knowledge.agents.engine import AgentTurn
from skaz.knowledge.chats.context import user_turn_text
from skaz.knowledge.chats.model import MessageInput, SelectedItem, Selection
from skaz.knowledge.chats.selection import diagram_id
from skaz.knowledge.chats.service import ChatService
from tests.knowledge.chat_support import Agents, Library, connect, finished, install, text

FLOW = "flowchart LR\n  A[Таймаут] --> B(Кандидат)\n  B -->|голоса| C{Большинство?}"


def test_the_diagram_id_is_the_one_the_chat_ui_computes() -> None:
    assert diagram_id("flowchart LR\n  A --> B") == "mmd-ffcb5ba0"  # chat/select/select.test.tsx
    assert diagram_id("  flowchart LR\n\nA --> B  \n") == "mmd-ffcb5ba0"


def test_a_selection_round_trips_with_the_question_and_shows_in_the_history() -> None:
    given = MessageInput(text="Тут ошибка", selection=Selection(
        "msg-a", "blk-1", "block", "Шаги", (SelectedItem("s1", "Таймаут"),), "wrong"))
    assert MessageInput.from_json(json.loads(json.dumps(given.to_json()))) == given
    assert MessageInput.from_json({"text": "x"}).selection is None
    assert user_turn_text(given) == "Тут ошибка\n(The user selected in an earlier answer: “Таймаут”)"


@dataclass
class Env:
    client: httpx.AsyncClient
    chats: ChatService
    agents: Agents
    library: Library
    turns: list[AgentTurn]

    async def answer(self, chat_id: str, body: dict[str, Any]) -> httpx.Response:
        sent = await self.client.post(f"/kb/chats/{chat_id}/messages", json=body)
        await finished(self.chats)
        return sent

    async def message(self, chat_id: str, message_id: str) -> dict[str, Any]:
        chat = (await self.client.get(f"/kb/chats/{chat_id}")).json()
        return next(m for m in chat["messages"] if m["id"] == message_id)


@pytest.fixture
async def env(kb_app: Any, kb_client: httpx.AsyncClient) -> AsyncIterator[Env]:
    runtime = kb_app.state.runtime
    agents = Agents()
    install(runtime, agents)
    library = await connect(kb_client, runtime)
    yield Env(kb_client, runtime.kb_chats, agents, library, [])
    await runtime.kb_chats.close()


async def _first_answer(env: Env) -> tuple[str, dict[str, Any]]:
    lib = env.library
    steps = {"type": "steps", "title": "Энтропия по шагам", "steps": [
        {"id": "s1", "title": "Мера беспорядка", "cite": f"m:{lib.lecture}:1|мера беспорядка системы"},
        {"id": "s2", "title": "Страница вики", "text": "Энтропия — мера", "cite": f"p:{lib.concept}#c-e1"},
        {"id": "s3", "title": "Своё знание", "basis": "agent"},
    ]}
    fence = "```skaz-block\n" + json.dumps(steps, ensure_ascii=False) + "\n```\n"
    diagram = f"Схема:\n\n```mermaid\n{FLOW}\n```\n"
    env.agents.scripts["codex"] = lambda _turn: text("Кратко:\n", fence, diagram)
    chat_id = (await env.client.post("/kb/chats", json={})).json()["id"]
    sent = await env.answer(chat_id, {"text": "Объясни"})
    assert sent.status_code == 202, sent.text
    answer = await env.message(chat_id, sent.json()["assistant"]["id"])

    def record(turn: AgentTurn) -> list[Any]:
        env.turns.append(turn)
        return text("Проверил.")

    env.agents.scripts["codex"] = record
    return chat_id, answer


async def test_the_agent_gets_the_picked_items_with_their_sources_as_data(env: Env) -> None:
    chat_id, answer = await _first_answer(env)
    (block,) = [part for part in answer["parts"] if part["type"] == "answer_block"]
    selection = {"message_id": answer["id"], "block_id": block["id"], "kind": "block", "title": "made up",
                 "intent": "wrong", "items": [{"id": "s2", "label": "Страница\u200b вики"},
                                              {"id": "s3", "label": "Своё"}]}
    sent = await env.answer(chat_id, {"text": "That’s wrong: не так", "selection": selection})
    assert sent.status_code == 202, sent.text
    stored = sent.json()["user"]["input"]["selection"]
    # The title is the stored block's own; labels are cleaned (no invisible characters).
    assert stored["title"] == "Энтропия по шагам" and stored["intent"] == "wrong"
    assert stored["items"] == [{"id": "s2", "label": "Страница вики"}, {"id": "s3", "label": "Своё"}]
    request = env.turns[-1].messages[-1].content
    section = next(piece for piece in request.split("\n\n") if "says they are wrong" in piece)
    note, _, rest = section.partition("<untrusted-data")
    assert "Recheck each" in note and 'label="selected items"' in rest[:40]
    data = rest.split("</untrusted-data>")[0]
    assert f"p:{env.library.concept}#c-e1" in data and "Энтропия — мера" in data
    assert "the agent's own knowledge" in data
    assert "Мера беспорядка" not in data  # only the picked items
    assert request.rstrip().endswith("The user's message:\nThat’s wrong: не так")
    # The old answer is untouched; the chip stays with the question.
    view = (await env.client.get(f"/kb/chats/{chat_id}")).json()
    assert next(m for m in view["messages"] if m["id"] == answer["id"])["parts"] == answer["parts"]
    question = next(m for m in view["messages"] if m["id"] == sent.json()["user"]["id"])
    assert question["input"]["selection"] == stored


async def test_a_diagram_selection_names_nodes_and_edges_by_their_source_ids(env: Env) -> None:
    chat_id, answer = await _first_answer(env)
    selection = {"message_id": answer["id"], "block_id": diagram_id(FLOW), "kind": "diagram",
                 "intent": "explain",
                 "items": [{"id": "node:C", "label": "Большинство?"},
                           {"id": "edge:B->C", "label": "Кандидат → …"}]}
    sent = await env.answer(chat_id, {"text": "Explain more", "selection": selection})
    assert sent.status_code == 202, sent.text
    request = env.turns[-1].messages[-1].content
    assert "pressed «Explain more»" in request
    assert "- node:C: Большинство?" in request and "- edge:B->C: Кандидат → …" in request
    assert "```mermaid\n" + FLOW in request


@pytest.mark.parametrize("change, reason", [
    ({"message_id": "msg-none"}, "no longer in this chat"),
    ({"items": [{"id": "s9", "label": "x"}]}, "no longer in the block"),
    ({"block_id": "blk-none"}, "no longer in the answer"),
    ({"kind": "diagram", "block_id": "mmd-00000000"}, "diagram is no longer"),
])
async def test_a_selection_that_does_not_match_the_stored_answer_is_refused(
        env: Env, change: dict[str, Any], reason: str) -> None:
    chat_id, answer = await _first_answer(env)
    (block,) = [part for part in answer["parts"] if part["type"] == "answer_block"]
    selection = {"message_id": answer["id"], "block_id": block["id"], "kind": "block",
                 "items": [{"id": "s1", "label": "x"}], **change}
    sent = await env.answer(chat_id, {"text": "?", "selection": selection})
    assert sent.status_code == 422 and reason in sent.json()["detail"], sent.text
    bad_node = {"message_id": answer["id"], "block_id": diagram_id(FLOW), "kind": "diagram",
                "items": [{"id": "node:Z", "label": "x"}]}
    assert (await env.answer(chat_id, {"text": "?", "selection": bad_node})).status_code == 422


async def test_editing_the_question_keeps_its_selection(env: Env) -> None:
    chat_id, answer = await _first_answer(env)
    selection = {"message_id": answer["id"], "block_id": diagram_id(FLOW), "kind": "diagram",
                 "items": [{"id": "node:A", "label": "Таймаут"}]}
    sent = await env.answer(chat_id, {"text": "Почему?", "selection": selection})
    edited = await env.client.post(f"/kb/chats/{chat_id}/messages/{sent.json()['user']['id']}/edit",
                                   json={"text": "А почему так?"})
    assert edited.status_code == 202, edited.text
    await finished(env.chats)
    assert edited.json()["user"]["input"]["selection"]["items"] == [{"id": "node:A", "label": "Таймаут"}]
    assert "- node:A: Таймаут" in env.turns[-1].messages[-1].content
