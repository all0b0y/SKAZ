"""P3-c: «Ask the agent» on a test question — the question rides with the chat message as a P2 chip
(``kind="study"``). Before the user has answered, SKAZ never sends the right answer, the options'
origin, the source quotes or the agent's explanation (enforced in code); after the check, it sends all.
"""
from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

import httpx
import pytest

from skaz.knowledge.agents.engine import AgentTurn
from skaz.knowledge.chats.service import ChatService
from skaz.knowledge.permissions.store import RunRef
from skaz.knowledge.study.checks import QuestionIn
from skaz.knowledge.study.service import StudyService
from tests.knowledge.chat_support import Agents, Library, connect, finished, install, text
from tests.knowledge.test_s_study import ENTROPY, _questions


@dataclass
class Env:
    client: httpx.AsyncClient
    chats: ChatService
    study: StudyService
    agents: Agents
    library: Library
    turns: list[AgentTurn]

    async def ask(self, chat_id: str, body: dict[str, Any]) -> httpx.Response:
        sent = await self.client.post(f"/kb/chats/{chat_id}/messages", json=body)
        await finished(self.chats)
        return sent

    def data(self) -> str:
        """The test question's section of the agent's last request: SKAZ's note, then the data."""
        request = self.turns[-1].messages[-1].content
        return next(piece for piece in request.split("\n\n") if "«Ask the agent»" in piece)


@pytest.fixture
async def env(kb_app: Any, kb_client: httpx.AsyncClient) -> AsyncIterator[Env]:
    runtime = kb_app.state.runtime
    agents = Agents()
    install(runtime, agents)
    library = await connect(kb_client, runtime)
    turns: list[AgentTurn] = []

    def record(turn: AgentTurn) -> list[Any]:
        turns.append(turn)
        return text("Объясняю.")

    agents.scripts["codex"] = record
    yield Env(kb_client, runtime.kb_chats, runtime.kb_study, agents, library, turns)
    await runtime.kb_chats.close()


async def _test_in(env: Env, chat_id: str) -> Any:
    ref = RunRef("run-test", chat_id, "msg-test", "codex")
    questions = [QuestionIn.model_validate(q) for q in _questions(env.library)]
    made = await asyncio.to_thread(env.study.make_test, ref, "Проверка", questions)
    return made.block


def _chip(block: Any, item_id: str) -> dict[str, Any]:
    return {"message_id": block.message_id, "block_id": block.id, "kind": "study", "title": "made up",
            "items": [{"id": item_id, "label": "anything"}]}


async def test_before_an_answer_the_agent_never_gets_the_answer_and_is_told_so(env: Env) -> None:
    chat_id = (await env.client.post("/kb/chats", json={})).json()["id"]
    block = await _test_in(env, chat_id)
    choice, _multi, _short, open_q = env.study.questions(block)
    sent = await env.ask(chat_id, {"text": "Explain this question", "selection": _chip(block, choice.id)})
    assert sent.status_code == 202, sent.text
    stored = sent.json()["user"]["input"]["selection"]
    assert (stored["kind"], stored["title"], stored["items"]) == (
        "study", "Проверка", [{"id": choice.id, "label": "question 1"}])

    section = env.data()
    note, _, rest = section.partition("<untrusted-data")
    assert "have NOT answered" in note and "Never give the answer away" in note
    data = json.loads(rest.split(">", 1)[1].split("</untrusted-data>")[0])
    assert data["answered"] is False and data["question"] == "Энтропия — это…"
    assert sorted(o.split(". ", 1)[1] for o in data["options"]) == ["мера беспорядка", "мера массы",
                                                                   "мера температуры"]
    # Physically absent, not just asked to be kept quiet: no origin, answer, quote or explanation.
    for absent in ("right_answer", "source", "agent_explanation", "from", "picked_by_user"):
        assert absent not in rest
    assert ENTROPY not in rest

    await env.ask(chat_id, {"text": "Explain this question", "selection": _chip(block, open_q.id)})
    rest = env.data().partition("<untrusted-data")[2]
    assert "Мера беспорядка системы." not in rest and "Подумайте о порядке молекул." not in rest
    assert ENTROPY not in rest


async def test_after_the_check_the_agent_gets_the_whole_question(env: Env) -> None:
    chat_id = (await env.client.post("/kb/chats", json={})).json()["id"]
    block = await _test_in(env, chat_id)
    choice = env.study.questions(block)[0]
    wrong = next(o for o in env.study.options(block, choice) if o["origin"] == "agent")
    await asyncio.to_thread(env.study.answer, block.id, choice.id, choices=[wrong["id"]])
    await env.ask(chat_id, {"text": "Explain this question", "selection": _chip(block, choice.id)})
    note, _, rest = env.data().partition("<untrusted-data")
    assert "after answering it" in note
    data = json.loads(rest.split(">", 1)[1].split("</untrusted-data>")[0])
    assert data["answered"] is True and data["result"] == "not yet right"
    assert data["right_answer"] == ["мера беспорядка"] and data["source"][0]["quote"] == ENTROPY
    picked = [o for o in data["options"] if o["picked_by_user"]]
    assert [o["text"] for o in picked] == [wrong["text"]] and picked[0]["from"].startswith("made up")


async def test_a_chip_for_a_test_that_is_gone_is_refused_and_a_wiki_test_puts_a_new_chat_in_its_folder(
        env: Env) -> None:
    chat_id = (await env.client.post("/kb/chats", json={})).json()["id"]
    gone = {"message_id": "m", "block_id": "st-none", "kind": "study", "items": [{"id": "c-1", "label": "x"}]}
    refused = await env.ask(chat_id, {"text": "?", "selection": gone})
    assert refused.status_code == 422 and "no longer here" in refused.json()["detail"]

    block = await _test_in(env, chat_id)
    saved = await asyncio.to_thread(env.study.save, block.id, "allow")
    fresh = (await env.client.post("/kb/chats", json={})).json()["id"]
    sent = await env.ask(fresh, {"text": "Explain this question",
                                 "selection": _chip(saved, env.study.questions(saved)[0].id)})
    assert sent.status_code == 202, sent.text
    chat = (await env.client.get(f"/kb/chats/{fresh}")).json()
    assert env.library.physics in chat["folder_ids"]


async def test_a_chip_for_another_chats_unsaved_test_is_refused(env: Env) -> None:
    """Q1 p3 L9: a chat asks only about its own test, a saved one (the library), or a wiki test's block."""
    from skaz.knowledge.chats.model import SelectedItem, Selection
    from skaz.knowledge.chats.selection import SelectionInvalid
    from skaz.knowledge.study.ask import check_study_selection

    own = (await env.client.post("/kb/chats", json={})).json()["id"]
    other = (await env.client.post("/kb/chats", json={})).json()["id"]
    block = await _test_in(env, own)
    item = env.study.questions(block)[0].id
    chip = Selection(block.message_id, block.id, "study", "x", (SelectedItem(item, "x"),), "ask")
    assert check_study_selection(env.study, chip, chat_id=own).block_id == block.id
    with pytest.raises(SelectionInvalid, match="another chat"):
        check_study_selection(env.study, chip, chat_id=other)
    saved = await asyncio.to_thread(env.study.save, block.id, "allow")  # in the library now: any chat
    assert check_study_selection(env.study, chip, chat_id=other).block_id == saved.id


async def test_the_chat_route_refuses_another_chats_unsaved_test_chip(env: Env) -> None:
    """Q1 p3 L9 wired: the question route passes the asking chat to the study check."""
    own = (await env.client.post("/kb/chats", json={})).json()["id"]
    other = (await env.client.post("/kb/chats", json={})).json()["id"]
    block = await _test_in(env, own)
    chip = _chip(block, env.study.questions(block)[0].id)
    refused = await env.ask(other, {"text": "Explain this question", "selection": chip})
    assert refused.status_code == 422 and "another chat" in refused.json()["detail"]
    sent = await env.ask(own, {"text": "Explain this question", "selection": chip})
    assert sent.status_code == 202, sent.text
