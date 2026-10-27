"""P3-b: the «Unclear» mark on cards and test questions, and the read-only ``skaz_study_unclear`` tool.

The mark lives on the item (not the attempt): it survives retakes and a right answer, never touches
FSRS, is separate from «hard», and only the user clears it. The agent reads the marks in the chat's
scope (its folders, or the whole library) and never changes them.
"""
from __future__ import annotations

import asyncio
from typing import Any

import httpx

from skaz.knowledge.study.tools import STUDY_TOOL_NAMES, UnclearArgs
from tests.knowledge.test_s_study import (  # noqa: F401 - the study world
    _deck,
    _ids,
    _options,
    _test,
    _tool,
    _tool_error,
    world,
)


async def test_a_question_mark_survives_retakes_and_a_right_answer_and_only_the_user_clears_it(
    world: Any,  # noqa: F811
) -> None:
    runtime, library, _ref = world
    study = runtime.kb_study
    block = await _test(runtime, library)
    first = study.questions(block)[0].id
    await asyncio.to_thread(study.mark, block.id, [first], "unclear")
    assert study.unclear_of([first]) == {first}

    right = next(o["id"] for o in _options(runtime, block, 0) if o["origin"] == "source")
    await asyncio.to_thread(study.answer, block.id, first, choices=[right])  # a right answer…
    await asyncio.to_thread(study.finish, block.id)
    await asyncio.to_thread(study.retake, block.id, mistakes_only=False)  # …and a retake
    assert study.unclear_of([first]) == {first}

    saved = await asyncio.to_thread(study.save, block.id, "allow")  # the saved test keeps it
    assert study.items.one(first).page_id == saved.page_id
    await asyncio.to_thread(study.mark, block.id, [first], "clear")
    assert study.unclear_of([first]) == set()


async def test_a_card_mark_never_touches_fsrs_and_is_apart_from_hard(world: Any) -> None:  # noqa: F811
    runtime, library, _ref = world
    study = runtime.kb_study
    block = await asyncio.to_thread(study.save, (await _deck(runtime, library)).id, "allow")
    card = _ids(runtime, block)[0]
    await asyncio.to_thread(study.mark, block.id, [card], "unclear")
    assert study.store.cards([card]) == {}  # no FSRS state, no review
    view = study.card_view(study.get(block.id))
    assert view[0]["unclear"] is True and view[0]["marked_hard"] is False
    deck = study.deck(block.page_id)
    assert deck["unclear"] == 1 and deck["cards"][0]["unclear"] is True
    await asyncio.to_thread(study.mark, None, [card], "clear", page_id=block.page_id)  # from the deck page
    assert study.deck(block.page_id)["unclear"] == 0


async def test_the_agent_reads_unclear_items_in_the_chats_scope_and_cannot_change_them(
    world: Any, kb_client: httpx.AsyncClient  # noqa: F811
) -> None:
    runtime, library, ref = world
    study = runtime.kb_study
    block = await _test(runtime, library)
    questions = study.questions(block)
    first, open_q = questions[0].id, questions[3].id
    wrong = next(o["id"] for o in _options(runtime, block, 0) if o["origin"] == "agent")
    await asyncio.to_thread(study.answer, block.id, first, choices=[wrong])
    await asyncio.to_thread(study.mark, block.id, [first, open_q], "unclear")

    assert "skaz_study_unclear" in STUDY_TOOL_NAMES
    read = await _tool(runtime, "skaz_study_unclear", {})
    assert read["scope"] == "the whole library" and read["count"] == 2  # the chat has no folders: «All»
    item = read["items"][0]
    assert (item["item_id"], item["kind"], item["type"]) == (first, "test question", "choice")
    assert item["right_answer"] == ["мера беспорядка"]
    assert {o["text"] for o in item["options"] if not o["right"]} == {"мера температуры", "мера массы"}
    assert item["last_answer"].endswith("(not right)") and item["source"][0]["quote"]
    assert item["where"].startswith("test block") and item["in"] == "Проверка"

    # The chat's folders bound the scope: a chat about chemistry sees nothing of this physics test.
    await asyncio.to_thread(runtime.kb_chats.repo.update, ref.chat_id, folder_ids=(library.chemistry,))
    assert (await _tool(runtime, "skaz_study_unclear", {}))["count"] == 0
    await asyncio.to_thread(runtime.kb_chats.repo.update, ref.chat_id, folder_ids=(library.physics,))
    assert (await _tool(runtime, "skaz_study_unclear", {}))["count"] == 2

    # Read-only: the tool takes nothing to change (its only argument narrows the list to a page).
    assert set(UnclearArgs.model_fields) == {"page_id"}
    await _tool_error(runtime, "skaz_study_unclear", {"clear": [first]})
    assert study.unclear_of([first, open_q]) == {first, open_q}

    # «Clear now» is the user's: the route clears what is listed and answers with the rest.
    listed = (await kb_client.get("/kb/study/unclear", params={"chat_id": ref.chat_id})).json()
    assert listed["scope"] == "folders" and [i["item_id"] for i in listed["items"]] == [first, open_q]
    left = (await kb_client.post("/kb/study/unclear/clear", params={"chat_id": ref.chat_id},
                                 json={"item_ids": [first]})).json()
    assert [i["item_id"] for i in left["items"]] == [open_q]


async def test_the_block_view_and_the_open_context_carry_the_mark(
    world: Any, kb_client: httpx.AsyncClient  # noqa: F811
) -> None:
    runtime, library, _ref = world
    study = runtime.kb_study
    block = await _test(runtime, library)
    first = study.questions(block)[0].id
    marked = await kb_client.post(f"/kb/study/{block.id}/mark",
                                  json={"item_ids": [first], "mark": "unclear"})
    assert marked.status_code == 200 and marked.json()["questions"][0]["unclear"] is True
    assert "marked it Unclear" in (study.open_context(block.id) or "")
