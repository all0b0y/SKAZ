"""Review 0.3.1 (C-08): a failed Notes answer never says "Nothing was saved" while its finished
sections are kept for Retry. Authored model events only (no real model)."""
from __future__ import annotations

import json
from typing import Any

import httpx

from skaz.knowledge.agents.engine import Completed
from tests.knowledge.test_ingest_pipeline import wiki_dir
from tests.knowledge.test_wiki_streaming import (
    ONE,
    THREE,
    TWO,
    _headings,
    _ingest,
    _world,
    chunks,
    section,
)

REST = json.dumps({"sections": [json.loads(section(TWO)), json.loads(section(THREE))], "more": False},
                  ensure_ascii=False)


async def test_an_answer_invalid_twice_keeps_its_streamed_sections_and_says_so(
    kb_app: Any, kb_client: httpx.AsyncClient,
) -> None:
    invalid = '{"sections": [' + section(ONE) + ', {"title": 5, "blocks": []}], "more": false}'
    world = await _world(kb_app, kb_client, [[*chunks(invalid), Completed("")],
                                             [*chunks(invalid), Completed("")],
                                             [*chunks(REST), Completed("")]])
    failed = await _ingest(world, kb_client)
    assert failed["state"] == "failed" and failed["can_retry"] is True
    assert "not in the expected format, twice" in failed["error"]
    assert "Nothing was saved" not in failed["error"]
    assert "1 section before that is kept: Retry continues from it" in failed["error"]
    done = await _ingest(world, kb_client)
    assert done["state"] == "done", done["error"]
    assert _headings(world) == ["Энтропия", "Температура", "Рост энтропии"]


async def test_a_repeated_previous_answer_is_not_kept_and_retry_asks_for_it_again(
    kb_app: Any, kb_client: httpx.AsyncClient,
) -> None:
    first = '{"sections": [' + section(ONE) + '], "more": true}'
    world = await _world(kb_app, kb_client, [[*chunks(first), Completed("")], [*chunks(first), Completed("")],
                                             [*chunks(REST), Completed("")]])
    failed = await _ingest(world, kb_client)
    assert failed["state"] == "failed"
    assert "repeated its previous answer" in failed["error"]
    assert "Nothing was saved" not in failed["error"]
    assert "1 section before that is kept: Retry continues from it" in failed["error"]
    done = await _ingest(world, kb_client)
    assert done["state"] == "done", done["error"]
    assert _headings(world) == ["Энтропия", "Температура", "Рост энтропии"]
    note = (wiki_dir(world.runtime.kb) / "Notes" / "Лекция 8.md").read_text(encoding="utf-8")
    assert note.count("Энтропия определяется как мера беспорядка системы.") == 1
