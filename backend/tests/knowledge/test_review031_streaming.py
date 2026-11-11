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


async def test_a_repeated_previous_answer_is_not_kept_and_skaz_asks_once_more(
    kb_app: Any, kb_client: httpx.AsyncClient,
) -> None:
    """WR3: an answer that adds nothing new is not a section twice; one more continuation is asked."""
    first = '{"sections": [' + section(ONE) + '], "more": true}'
    world = await _world(kb_app, kb_client, [[*chunks(first), Completed("")], [*chunks(first), Completed("")],
                                             [*chunks(REST), Completed("")]])
    done = await _ingest(world, kb_client)
    assert done["state"] == "done", done["error"]
    assert _headings(world) == ["Энтропия", "Температура", "Рост энтропии"]
    note = (wiki_dir(world.runtime.kb) / "Notes" / "Лекция 8.md").read_text(encoding="utf-8")
    assert note.count("Энтропия определяется как мера беспорядка системы.") == 1
    journal = " ".join(entry["message"] for entry in done["journal"])
    assert "added nothing new; SKAZ asked once more" in journal


async def test_an_answer_repeated_twice_in_a_row_fails_and_retry_asks_for_the_rest(
    kb_app: Any, kb_client: httpx.AsyncClient,
) -> None:
    first = '{"sections": [' + section(ONE) + '], "more": true}'
    world = await _world(kb_app, kb_client, [[*chunks(first), Completed("")], [*chunks(first), Completed("")],
                                             [*chunks(first), Completed("")], [*chunks(REST), Completed("")]])
    failed = await _ingest(world, kb_client)
    assert failed["state"] == "failed"
    assert "without anything new" in failed["error"]
    assert "Nothing was saved" not in failed["error"]
    assert "1 section before that is kept: Retry or another model in Settings → Models continues from it" in (
        failed["error"])
    done = await _ingest(world, kb_client)
    assert done["state"] == "done", done["error"]
    assert _headings(world) == ["Энтропия", "Температура", "Рост энтропии"]
    note = (wiki_dir(world.runtime.kb) / "Notes" / "Лекция 8.md").read_text(encoding="utf-8")
    assert note.count("Энтропия определяется как мера беспорядка системы.") == 1
