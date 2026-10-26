"""P2 decision 4: «That’s wrong» → the agent rechecks → «Fix in wiki», written only on the user's click.

The agent is ``p_support.ToolEngine`` (a fake at the agent seam that calls the real SKAZ tools); the
proposal is checked against the real page, the click goes through the wiki's user-edit path.
"""
from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
import pytest

from skaz.knowledge.agents.engine import TextDelta
from skaz.knowledge.agents.registry import EngineRegistry
from skaz.knowledge.markdown.page import parse_page

from .chat_support import Library, connect, finished
from .p_support import Invoke, ToolEngine

WRONG = "Энтропия — мера беспорядка системы."  # pg-entropy / c-e1 (chat_support.seed_library)
RIGHT = "Энтропия — мера числа микросостояний системы."


@dataclass
class Env:
    client: httpx.AsyncClient
    runtime: Any
    engine: ToolEngine
    library: Library

    def page(self, page_id: str = "pg-entropy") -> str:
        record = self.runtime.kb.page_repo.get(page_id)
        path: Path = self.runtime.kb.require().root / record.rel_path
        return path.read_text(encoding="utf-8")

    async def answered(self, chat_id: str, body: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
        sent = await self.client.post(f"/kb/chats/{chat_id}/messages", json=body)
        assert sent.status_code == 202, sent.text
        await finished(self.runtime.kb_chats)
        view = (await self.client.get(f"/kb/chats/{chat_id}")).json()
        answer = next(m for m in view["messages"] if m["id"] == sent.json()["assistant"]["id"])
        return sent.json()["user"], answer


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


def _fix(**change: Any) -> Invoke:
    return Invoke("skaz_wiki_propose_fix", {"page_id": "pg-entropy", "block_id": "c-e1",
                                            "wrong": "мера беспорядка", "text": RIGHT,
                                            "reason": "Лекция 8 говорит о микросостояниях.", **change})


async def _marked(env: Env, intent: str = "wrong", proposal: list[Any] | None = None,
                  cite: str = "p:pg-entropy#c-e1") -> tuple[str, dict[str, Any]]:
    """An answer whose steps cite the wiki block, then «That’s wrong» on its first step."""
    steps = {"type": "steps", "steps": [
        {"id": "s1", "title": "Энтропия — мера беспорядка", "cite": cite},
        {"id": "s2", "title": "Растёт", "cite": f"m:{env.library.lecture}:1"}]}
    env.engine.script = lambda _turn: [TextDelta("", "```skaz-block\n" + json.dumps(steps) + "\n```\n")]
    chat_id = (await env.client.post("/kb/chats", json={"engine": "codex"})).json()["id"]
    _user, first = await env.answered(chat_id, {"text": "Что такое энтропия?"})
    (block,) = [part for part in first["parts"] if part["type"] == "answer_block"]
    env.engine.script = lambda _turn: [*(proposal or [_fix()]), TextDelta("", "Проверил: вики неточна.")]
    _user, answer = await env.answered(chat_id, {"text": "That’s wrong", "selection": {
        "message_id": first["id"], "block_id": block["id"], "kind": "block", "intent": intent,
        "items": [{"id": "s1", "label": "Энтропия — мера беспорядка"}]}})
    return chat_id, answer


async def test_a_confirmed_error_shows_before_after_and_changes_the_wiki_only_on_click(env: Env) -> None:
    before_file = env.page()
    chat_id, answer = await _marked(env)
    (card,) = [part for part in answer["parts"] if part["type"] == "wiki_fix"]
    assert card["status"] == "proposed" and card["available"] is True
    assert card["page"]["title"] == "Энтропия" and card["block_id"] == "c-e1"
    assert (card["before"], card["after"]) == (WRONG, RIGHT)
    assert json.loads(env.engine.outcomes[-1])["status"] == "shown"
    assert env.page() == before_file  # nothing is written by the agent

    url = f"/kb/chats/{chat_id}/messages/{answer['id']}/wiki-fixes/{card['id']}/apply"
    applied = await env.client.post(url)
    assert applied.status_code == 200, applied.text
    assert applied.json()["status"] == "applied"
    block = parse_page(env.page()).block("c-e1")
    assert block is not None and block.owner == "user_edited"  # the user's edit (wiki/edit.py)
    assert block.body.strip() == RIGHT and [c.seg for c in block.cites] == [1]  # its citation is kept
    view = (await env.client.get(f"/kb/chats/{chat_id}")).json()
    stored = next(m for m in view["messages"] if m["id"] == answer["id"])
    assert [p["status"] for p in stored["parts"] if p["type"] == "wiki_fix"] == ["applied"]
    again = await env.client.post(url)
    assert again.status_code == 200 and again.json()["status"] == "applied"


async def test_a_block_changed_since_the_proposal_is_left_alone(env: Env) -> None:
    chat_id, answer = await _marked(env)
    (card,) = [part for part in answer["parts"] if part["type"] == "wiki_fix"]
    await asyncio.to_thread(env.runtime.kb_wiki.update_block, "pg-entropy", "c-e1", "Моя правка.")
    edited = env.page()
    url = f"/kb/chats/{chat_id}/messages/{answer['id']}/wiki-fixes/{card['id']}/apply"
    stale = await env.client.post(url)
    assert stale.status_code == 200 and stale.json()["status"] == "stale"
    assert env.page() == edited


@pytest.mark.parametrize("intent, proposal, reason", [
    ("ask", [_fix()], "marked as wrong"),
    ("wrong", [_fix(page_id="pg-old-answer", block_id="c-a1", wrong="Разбор говорит")], "not a source"),
    ("wrong", [_fix(wrong="мера хаоса")], "not in that block"),
    ("wrong", [_fix(text=WRONG)], "the same as the block's text"),
    ("wrong", [_fix(text="Line\n\nTwo")], "one paragraph"),
    ("wrong", [_fix(), _fix()], "already proposed"),
])
async def test_a_proposal_that_does_not_match_the_page_or_the_marked_items_is_refused(
        env: Env, intent: str, proposal: list[Any], reason: str) -> None:
    _chat_id, answer = await _marked(env, intent, proposal)
    assert reason in env.engine.outcomes[-1], env.engine.outcomes
    cards = [part for part in answer["parts"] if part["type"] == "wiki_fix"]
    assert len(cards) == (1 if len(proposal) == 2 else 0)


async def test_the_users_own_note_is_never_proposed(env: Env) -> None:
    await asyncio.to_thread(env.runtime.kb_wiki.add_note, "pg-entropy", "Моя заметка про беспорядок.",
                            after_block_id=None, section=None)
    note_id = next(b.id for b in parse_page(env.page()).blocks() if b.owner == "user")
    # The item cites the whole page, so any of its blocks could be meant — but never the user's note.
    proposal = [_fix(block_id=note_id, wrong="Моя заметка")]
    _chat_id, answer = await _marked(env, "wrong", proposal, cite="p:pg-entropy")
    assert "user's own note" in env.engine.outcomes[-1]
    assert not [part for part in answer["parts"] if part["type"] == "wiki_fix"]
