"""Review 0.3.1 (C-05): the going-round-in-circles sign has no false positives on healthy notes.

Contract (REMAINING-WORK C1-f): a section title repeated within one part, or three paragraphs
≥90 % alike already written; a single repeat (lectures do it on purpose) never stops the answer.
"""
from __future__ import annotations

import pytest

from skaz.knowledge.ingest.repetition import RepeatGuard, Repeating

DEFINITION = "Энтропия изолированной системы не убывает со временем, это второе начало термодинамики."


def test_short_labels_in_many_sections_are_not_a_loop() -> None:
    guard = RepeatGuard()
    guard.new_part()
    for n, topic in enumerate(("энтропии", "температуры", "давления", "объёма", "теплоёмкости")):
        detail = f"Подробный разбор {topic} на конкретной задаче из лекции {n}."
        guard.check(f"Раздел {n}", ["Пример:", detail, "Formula:"])


def test_a_definition_restated_once_per_part_is_not_a_loop() -> None:
    guard = RepeatGuard()
    for part in range(5):
        guard.new_part()
        guard.check(f"Часть {part}", [DEFINITION, f"Новый материал части номер {part} со своими примерами."])


def test_three_long_repeats_within_one_part_still_stop_the_answer() -> None:
    guard = RepeatGuard()
    guard.new_part()
    guard.check("A", [DEFINITION])
    guard.check("B", [DEFINITION])  # one repeat: allowed
    guard.check("C", [DEFINITION])  # two
    with pytest.raises(Repeating):
        guard.check("D", [DEFINITION])
