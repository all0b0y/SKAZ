"""Q1 n78 H-1 / p3 H1: the chat's sources (N7-4) hold on the interactive tools too — the study tools.

«Use only these sources» / «Exclude from this chat» narrow ``skaz_study_unclear`` (items resting on
sources outside the chat's set are left out and counted; quotes of such sources are withheld),
refuse ``skaz_study_read`` / ``skaz_study_show`` on a deck or test page the chat doesn't allow, refuse
making cards or tests that cite such sources, and keep their quotes out of the P3-c «Ask the agent»
context.
"""
from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest

from skaz.knowledge.agents.tools import ToolContext
from skaz.knowledge.permissions.search_rules import ChatRules
from skaz.knowledge.permissions.source_scope import EXCLUDED, PAGE_EXCLUDED, PAGE_NOT_IN_SOURCES
from tests.knowledge.test_p3_ask import Env, _chip, _test_in
from tests.knowledge.test_p3_ask import env as env_fixture  # noqa: F401  (the P3-c environment)
from tests.knowledge.test_s_study import (  # noqa: F401 - the study world
    ENTROPY,
    GIBBS,
    RUN_ID,
    _cards,
    _deck,
    _options,
    _test,
    _tool,
    world,
)


@pytest.fixture
def env(env_fixture: Env) -> Env:  # noqa: F811
    return env_fixture


def _scoped(runtime: Any, chat_id: str, rules: ChatRules) -> None:
    """The chat's sources, and the scope hook knowing the world's run (as the chat service would)."""
    runtime.kb_search_rules.set_chat(chat_id, rules)
    runtime.kb_tools.scope.runs = runtime.kb_study_tools.runs


async def _call(runtime: Any, name: str, arguments: dict[str, Any]) -> Any:
    return await runtime.kb_tools.call(name, arguments, ToolContext(RUN_ID, "claude_code"))


def _unwrapped(text: str) -> dict[str, Any]:
    """``skaz_study_unclear``'s answer with its items read out of their untrusted-data block (the study
    code narrows them before it wraps them, Q1 p3 M4)."""
    data = json.loads(text)
    block = data["items"]
    assert isinstance(block, str) and '<untrusted-data label="unclear items">' in block
    return {**data, "items": json.loads(block.split("\n", 2)[2].rsplit("\n</untrusted-data>", 1)[0])}


async def test_unclear_items_from_sources_outside_the_chat_are_left_out_and_counted(
        world: Any) -> None:  # noqa: F811
    runtime, library, ref = world
    study = runtime.kb_study
    block = await _test(runtime, library)
    lecture_q, textbook_q = (q.id for q in study.questions(block)[:2])
    await asyncio.to_thread(study.mark, block.id, [lecture_q, textbook_q], "unclear")

    rounds = (ChatRules(excluded=(library.lecture,)),
              ChatRules(sources_only=True, sources=(library.textbook,)))
    # Not answered yet: the questions come without their sources (p3 H2), yet the lecture's is still left
    # out — SKAZ judges by the real citations, not by what the agent is shown.
    for rules in rounds:
        _scoped(runtime, ref.chat_id, rules)
        outcome = await _call(runtime, "skaz_study_unclear", {})
        assert not outcome.is_error, outcome.text
        data = _unwrapped(outcome.text)
        assert [item["item_id"] for item in data["items"]] == [textbook_q]
        assert data["count"] == 1 and data["left_out"] == 1 and "left out" in data["scope_note"]
        assert ENTROPY not in outcome.text and "Энтропия" not in outcome.text
    # Answered: the kept item carries its source quote, the left-out one's never shows.
    for index, question_id in enumerate((lecture_q, textbook_q)):
        right = [o["id"] for o in _options(runtime, block, index) if o["origin"] == "source"]
        await asyncio.to_thread(study.answer, block.id, question_id, choices=right)
    for rules in rounds:
        _scoped(runtime, ref.chat_id, rules)
        outcome = await _call(runtime, "skaz_study_unclear", {})
        assert not outcome.is_error, outcome.text
        data = _unwrapped(outcome.text)
        assert [item["item_id"] for item in data["items"]] == [textbook_q]
        assert data["count"] == 1 and data["left_out"] == 1 and "left out" in data["scope_note"]
        assert ENTROPY not in outcome.text and GIBBS in outcome.text


async def test_a_quote_of_an_excluded_source_is_withheld_on_an_item_that_stays(world: Any) -> None:  # noqa: F811
    runtime, library, ref = world
    study = runtime.kb_study
    cards = _cards(library)
    cards[2]["citations"].append({"material_id": library.lecture, "seg": 1, "quote": ENTROPY})
    made = await _tool(runtime, "skaz_study_make_deck", {"title": "Смесь", "cards": cards})
    block = study.get(made["study_id"])
    mixed = [card.id for card, _page in study.cards(block)][2]
    await asyncio.to_thread(study.mark, block.id, [mixed], "unclear")
    _scoped(runtime, ref.chat_id, ChatRules(excluded=(library.lecture,)))
    outcome = await _call(runtime, "skaz_study_unclear", {})
    data = _unwrapped(outcome.text)
    (item,) = data["items"]
    by_material = {source["cite"].split(":")[1]: source for source in item["source"]}
    assert by_material[library.textbook]["quote"] == GIBBS
    assert "quote" not in by_material[library.lecture] and by_material[library.lecture]["withheld"] is True
    assert ENTROPY not in json.dumps(data, ensure_ascii=False) and ENTROPY not in outcome.text


async def test_a_deck_page_outside_the_chat_is_not_read_or_shown(world: Any) -> None:  # noqa: F811
    runtime, library, ref = world
    study = runtime.kb_study
    saved = await asyncio.to_thread(study.save, (await _deck(runtime, library)).id, "allow")
    page = saved.page_id
    _scoped(runtime, ref.chat_id, ChatRules(excluded=(page,)))
    read = await _call(runtime, "skaz_study_read", {"page_id": page})
    assert read.is_error and read.text == PAGE_EXCLUDED
    shown = await _call(runtime, "skaz_study_show", {"page_ids": [page], "mode": "all"})
    assert shown.is_error and shown.text == PAGE_EXCLUDED

    _scoped(runtime, ref.chat_id, ChatRules(sources_only=True, sources=(library.lecture,)))
    read = await _call(runtime, "skaz_study_read", {"page_id": page})
    assert read.is_error and read.text == PAGE_NOT_IN_SOURCES
    _scoped(runtime, ref.chat_id, ChatRules(sources_only=True, sources=(page,)))
    assert not (await _call(runtime, "skaz_study_read", {"page_id": page})).is_error


async def test_cards_citing_an_excluded_source_are_refused_before_anything_is_shown(
        world: Any) -> None:  # noqa: F811
    runtime, library, ref = world
    _scoped(runtime, ref.chat_id, ChatRules(excluded=(library.textbook,)))
    before = len(runtime.kb_study.store.blocks_of_chat(ref.chat_id))
    made = await _call(runtime, "skaz_study_make_deck", {"title": "Т", "cards": _cards(library)})
    assert made.is_error and EXCLUDED in made.text
    assert len(runtime.kb_study.store.blocks_of_chat(ref.chat_id)) == before
    _scoped(runtime, ref.chat_id, ChatRules(sources_only=True, sources=(library.lecture,)))
    made = await _call(runtime, "skaz_study_make_deck", {"title": "Т", "cards": _cards(library)[:2]})
    assert not made.is_error, made.text


async def test_ask_the_agent_withholds_quotes_of_sources_outside_the_chat(env: Env) -> None:
    chat_id = (await env.client.post("/kb/chats", json={})).json()["id"]
    block = await _test_in(env, chat_id)
    choice = env.study.questions(block)[0]
    wrong = next(o for o in env.study.options(block, choice) if o["origin"] == "agent")
    await asyncio.to_thread(env.study.answer, block.id, choice.id, choices=[wrong["id"]])
    put = await env.client.put(f"/kb/chats/{chat_id}/search-rules",
                               json={"excluded": [env.library.lecture]})
    assert put.status_code == 200, put.text
    await env.ask(chat_id, {"text": "Explain this question", "selection": _chip(block, choice.id)})
    rest = env.data().partition("<untrusted-data")[2]
    data = json.loads(rest.split(">", 1)[1].split("</untrusted-data>")[0])
    assert data["answered"] is True and ENTROPY not in rest
    assert data["source"][0]["withheld"] is True and data["sources_withheld"] == 1


# -- the predicate the study code calls itself (it wraps its payload as untrusted text, fix/q1-study) --


def test_the_study_side_can_narrow_items_before_wrapping_them() -> None:
    from skaz.knowledge.permissions.source_scope import (
        UNCLEAR_LEFT_OUT,
        SourceScope,
        narrow_unclear_items,
        scope_payload,
    )

    scope = SourceScope(None, frozenset({"mat-x", "pg-x"}))
    items = [
        {"item_id": "a", "page_id": None, "source": [{"cite": "m:mat-x:1", "quote": "secret"}]},
        {"item_id": "b", "page_id": "pg-ok", "source": [{"cite": "m:mat-x:1", "quote": "secret"},
                                                        {"cite": "m:mat-y:2", "quote": "fine"}]},
        {"item_id": "c", "page_id": "pg-x", "source": [{"cite": "m:mat-y:2", "quote": "fine"}]},
    ]
    kept, left_out = narrow_unclear_items(items, scope)
    assert [item["item_id"] for item in kept] == ["b"] and left_out == 2
    assert "secret" not in json.dumps(kept) and kept[0]["source"][0]["withheld"] is True
    assert "2 marked item(s)" in UNCLEAR_LEFT_OUT.format(count=left_out)
    # Already wrapped by the study code: the registry's narrowing leaves it alone (never empties it).
    wrapped = {"status": "ok", "count": 1, "items": "<untrusted-data>…</untrusted-data>"}
    assert scope_payload("skaz_study_unclear", dict(wrapped), scope) == wrapped


async def test_the_scope_of_a_chat_or_a_run_is_public(world: Any) -> None:  # noqa: F811
    runtime, library, ref = world
    _scoped(runtime, ref.chat_id, ChatRules(excluded=(library.lecture,)))
    scopes = runtime.kb_tools.scope
    scope = await asyncio.to_thread(scopes.for_chat, ref.chat_id)
    assert scope is not None and not scope.allows(library.lecture) and scope.allows(library.textbook)
    assert await scopes.for_context(ToolContext(RUN_ID, "claude_code")) == scope
    assert await scopes.for_context(None) is None
