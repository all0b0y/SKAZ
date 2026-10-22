"""C1-f: the wiki answer is read while it streams — each finished section or concept at once —
and a model that starts going round in circles is stopped (decided 2026-10-20)."""
from __future__ import annotations

import json

import pytest

from skaz.knowledge.ingest.repetition import RepeatGuard, Repeating
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


def _section(guard: RepeatGuard, title: str, *texts: str) -> None:
    guard.check(title, list(texts))


def test_a_section_title_repeated_within_one_part_is_going_round() -> None:
    guard = RepeatGuard()
    guard.new_part()
    _section(guard, "Введение", "Первый абзац о предмете курса.")
    _section(guard, "Определения", "Энтропия — мера беспорядка.")
    # Continuing the section just written (a new answer starts with the same title) is allowed.
    _section(guard, "Определения", "Температура — средняя кинетическая энергия.")
    with pytest.raises(Repeating):
        _section(guard, "введение", "Совсем другой текст.")


def test_the_same_title_in_the_next_part_is_allowed() -> None:
    guard = RepeatGuard()
    guard.new_part()
    _section(guard, "Итоги", "Абзац один.")
    guard.new_part()
    _section(guard, "Итоги", "Абзац два, другой.")


def test_three_near_identical_paragraphs_stop_the_answer_but_one_or_two_do_not() -> None:
    guard = RepeatGuard()
    guard.new_part()
    base = "Энтропия изолированной системы не убывает со временем, это второе начало термодинамики."
    _section(guard, "A", base)
    # A lecture repeats a thought on purpose: one or two near repeats are fine.
    _section(guard, "B", base.replace("со временем", "со временем,"))
    _section(guard, "C", base + " ")
    # A paraphrase is not a repeat.
    _section(guard, "D", "Второе начало говорит, что энтропия замкнутой системы только растёт или остаётся.")
    with pytest.raises(Repeating):
        _section(guard, "E", base.upper())


def test_known_items_are_remembered_without_stopping() -> None:
    """A resumed answer feeds the sections already kept; they never stop the run themselves."""
    guard = RepeatGuard()
    guard.new_part()
    guard.remember("Итоги", ["Абзац."])
    guard.remember("Итоги", ["Абзац."])
    with pytest.raises(Repeating):
        _section(guard, "Начало", "x")
        _section(guard, "Итоги", "y")
