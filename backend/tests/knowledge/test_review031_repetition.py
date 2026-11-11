"""Review 0.3.1 (C-05), kept under WR3: the loop sign has no false positives on healthy notes.

Contract (decision 9c): only 3 items in a row of one answer that add nothing new are a loop; a
thought restated once per part, or a short label in many sections, never stops the answer.
"""
from __future__ import annotations

import pytest

from skaz.knowledge.ingest.pages import match_key
from skaz.knowledge.ingest.repetition import AnswerRun, LoopDetector, Looping

DEFINITION = "Энтропия изолированной системы не убывает со временем, это второе начало термодинамики."


def _section(run: AnswerRun[str], title: str, *texts: str) -> None:
    run.add(title, title, [match_key(title)], list(texts))


def test_short_labels_in_many_sections_are_not_a_loop() -> None:
    run: AnswerRun[str] = AnswerRun(LoopDetector())
    for n, topic in enumerate(("энтропии", "температуры", "давления", "объёма", "теплоёмкости")):
        detail = f"Подробный разбор {topic} на конкретной задаче из лекции {n}."
        _section(run, f"Раздел {n}", "Пример:", detail, "Formula:")
    assert run.useful == 5


def test_a_definition_restated_once_per_part_is_not_a_loop() -> None:
    detector = LoopDetector()
    for part in range(5):
        run: AnswerRun[str] = AnswerRun(detector)
        _section(run, f"Часть {part}", DEFINITION, f"Новый материал части номер {part} со своими примерами.")
        assert run.useful == 1


def test_three_sections_in_a_row_that_add_nothing_still_stop_the_answer() -> None:
    run: AnswerRun[str] = AnswerRun(LoopDetector())
    _section(run, "A", DEFINITION)
    _section(run, "A", DEFINITION)  # one repeat: allowed
    _section(run, "A", DEFINITION)  # two
    with pytest.raises(Looping):
        _section(run, "A", DEFINITION)
