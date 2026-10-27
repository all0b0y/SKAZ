"""P3-d: a pass through a deck — «I know this» = Good (the card leaves the pile), a skip = Again once per
pass (the card goes under the pile and comes back), ← brings back the last skipped one, the pass ends
when no card is left. Practice modes still write only Again.
"""
from __future__ import annotations

import asyncio
from typing import Any

import httpx
import pytest

from skaz.knowledge.errors import KnowledgeError
from skaz.knowledge.study.passes import Pass, apply, read_pass
from tests.knowledge.test_s_study import _deck, _ids, _saved_deck, _tool, world  # noqa: F401


def _reviews(runtime: Any, card_id: str) -> list[int]:
    with runtime.kb.db.read() as connection:
        rows = connection.execute("SELECT rating FROM study_reviews WHERE card_id = ? ORDER BY id",
                                  (card_id,))
        return [int(row[0]) for row in rows]


def test_the_pass_moves_cards_as_decided() -> None:
    ids = ["a", "b", "c"]
    start = read_pass({}, ids, 0)
    after, again = apply(start, "skip", "a", ids)
    assert (after.queue, after.again, after.thrown, again) == (["b", "c", "a"], ["a"], ["a"], True)
    after, _ = apply(after, "know", "b", ids)
    after, again = apply(after, "skip", "c", ids)
    after, again2 = apply(after, "skip", "a", ids)  # «a» again: no second Again in this pass
    assert (after.queue, again, again2) == (["c", "a"], True, False)
    after, _ = apply(after, "back", None, ids)  # ← the last skipped comes back on top
    assert after.queue == ["a", "c"] and after.thrown == ["a", "c"]
    assert read_pass({}, ids, 1).queue == ["b", "c"]  # a block from before P3-d: from its position on
    gone = {"pass": Pass(["x", "b"], [], ["a", "c"]).to_json()}
    assert read_pass(gone, ids, 0).queue == ["b"]  # deleted cards drop out
    with pytest.raises(ValueError):
        apply(after, "know", "b", ids)  # known already: not on the pile


async def test_a_saved_deck_records_good_and_again_once_per_pass(world: Any) -> None:  # noqa: F811
    runtime, library, _ref = world
    study = runtime.kb_study
    page_id = await _saved_deck(runtime, library)
    shown = await _tool(runtime, "skaz_study_show", {"page_ids": [page_id], "mode": "new"})
    block = study.get(shown["study_id"])
    first, second, third = _ids(runtime, block)

    block = await asyncio.to_thread(study.study_pass, block.id, "skip", first)
    assert study.pile(block).queue == [second, third, first] and block.position == 1
    assert _reviews(runtime, first) == [1]
    await asyncio.to_thread(study.study_pass, block.id, "know", second)
    await asyncio.to_thread(study.study_pass, block.id, "know", third)
    block = await asyncio.to_thread(study.study_pass, block.id, "skip", first)  # comes back, skipped again
    assert _reviews(runtime, first) == [1] and _reviews(runtime, second) == [3]
    block = await asyncio.to_thread(study.study_pass, block.id, "know", first)
    assert study.pile(block).queue == [] and block.position == 3  # the pass is over
    assert _reviews(runtime, first) == [1, 3]

    block = await asyncio.to_thread(study.study_pass, block.id, "restart")
    assert study.pile(block).queue == [first, second, third] and block.state["grades"] == {}
    await asyncio.to_thread(study.study_pass, block.id, "skip", first)  # a new pass: Again once more
    assert _reviews(runtime, first) == [1, 3, 1]


async def test_practice_writes_only_again_and_an_unsaved_deck_waits_for_save(
    world: Any, kb_client: httpx.AsyncClient  # noqa: F811
) -> None:
    runtime, library, _ref = world
    study = runtime.kb_study
    page_id = await _saved_deck(runtime, library)
    shown = await _tool(runtime, "skaz_study_show", {"page_ids": [page_id], "mode": "all"})
    block = study.get(shown["study_id"])
    first, second, _third = _ids(runtime, block)
    await asyncio.to_thread(study.study_pass, block.id, "know", first)
    await asyncio.to_thread(study.study_pass, block.id, "skip", second)
    assert _reviews(runtime, first) == [] and _reviews(runtime, second) == [1]

    fresh = await _deck(runtime, library)
    one = _ids(runtime, fresh)[0]
    known = await kb_client.post(f"/kb/study/{fresh.id}/pass", json={"action": "know", "item_id": one})
    part = known.json()
    assert part["pile"] == {"queue": _ids(runtime, fresh)[1:], "known": 1, "again": 0, "can_back": False}
    assert study.store.cards([one]) == {} and study.get(fresh.id).state["pending"][one]["reps"] == 1
    refused = await kb_client.post(f"/kb/study/{fresh.id}/pass", json={"action": "know", "item_id": one})
    assert refused.status_code == 404
    with pytest.raises(KnowledgeError, match="Only cards"):
        made = await _tool(runtime, "skaz_study_make_test", {"title": "T", "questions": [{
            "type": "short", "question": "Q?", "answers": ["второго рода"],
            "citations": [{"material_id": library.lecture, "seg": 2,
                           "quote": "запрещает вечный двигатель второго рода"}]}]})
        await asyncio.to_thread(study.study_pass, made["study_id"], "restart")


def test_cards_added_to_the_deck_during_a_pass_join_the_pile() -> None:
    """Q1 p3 L6: a card new on the page goes under the current pile instead of waiting for a new pass."""
    stored = {"pass": Pass(["b"], ["b"], ["a"], ["b"]).to_json()}
    after = read_pass(stored, ["a", "b", "c"], 0)
    assert (after.queue, after.known, after.again) == (["b", "c"], ["a"], ["b"])
    done = {"pass": Pass([], [], ["a", "b"], []).to_json()}
    assert read_pass(done, ["a", "b", "c"], 0).queue == ["c"]  # «All done» becomes one card left
    assert read_pass(done, ["a", "b"], 0).queue == []
