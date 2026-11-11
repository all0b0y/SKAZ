"""C1-f: the wiki answer is read while it streams — each finished section or concept at once
(decided 2026-10-20). The loop rules themselves: ``test_wr3_duplicates``."""
from __future__ import annotations

import json

import pytest

from skaz.knowledge.ingest.stream import ItemStream
from tests.knowledge.ingest_support import block, cite, notes


def _feed_all(stream: ItemStream, text: str, size: int) -> list[str]:
    out: list[str] = []
    for start in range(0, len(text), size):
        out += stream.feed(text[start:start + size])
    return out


@pytest.mark.parametrize("size", [1, 3, 17, 10_000])
def test_finished_sections_come_out_as_soon_as_they_close(size: int) -> None:
    text = notes(
        ("Тема {1}", [block("from_source", 'Кавычки \\" и скобки } ] { внутри строки.', cite(1, "а"))]),
        ("Вторая", [block("explanation", "Ещё абзац.")]),
        more=True,
    )
    items = _feed_all(ItemStream("sections"), "```json\n" + text, size)
    assert [json.loads(item)["title"] for item in items] == ["Тема {1}", "Вторая"]


def test_an_unfinished_section_is_not_returned() -> None:
    stream = ItemStream("concepts")
    text = ('{"concepts": [{"title_in_wiki_language": "A", "definition_blocks": []}, '
            '{"title_in_wiki_language": "B"')
    assert [json.loads(item)["title_in_wiki_language"] for item in stream.feed(text)] == ["A"]
    assert stream.feed('') == []


def test_items_of_another_array_are_ignored() -> None:
    stream = ItemStream("sections")
    assert stream.feed('{"other": [{"x": 1}], "sections": [{"title": "T", "blocks": []}]}') == [
        '{"title": "T", "blocks": []}']
