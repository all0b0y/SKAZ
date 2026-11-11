"""WR3 (decision 9c): the old repeat guard is split into a duplicate filter and a loop detector.

The duplicate filter never stops a job: a repeated concept merges into its draft, a near-duplicate
statement of the same concept (or same-titled Notes section) is not added and its source refs move to
the kept one. The loop detector stops only a model that writes 3 items in a row adding nothing new.
"""
from __future__ import annotations

import pytest

from skaz.knowledge.ingest.checks import CheckedBlock
from skaz.knowledge.ingest.drafts import ConceptDraft, place_block
from skaz.knowledge.ingest.repetition import LOOP_RUN, AnswerRun, LoopDetector, Looping

DEFINITION = "Энтропия изолированной системы не убывает со временем, это второе начало термодинамики."
RESTATED = "Энтропия изолированной системы не убывает со временем — это второе начало термодинамики!"
OTHER = "Температура показывает среднюю кинетическую энергию частиц газа в сосуде при равновесии."


def _block(text: str, seg: int, *, kind: str = "from_source") -> CheckedBlock:
    return CheckedBlock(kind, text, (seg,), (), ((seg, f"quote {seg}"),))  # type: ignore[arg-type]


# -- loop detector ------------------------------------------------------------------------------


def test_a_new_concept_adds_something_and_its_repeat_does_not() -> None:
    detector = LoopDetector()
    assert detector.take(["энтропия", "entropy"], [DEFINITION]) is True
    assert detector.take(["entropy"], [RESTATED]) is False  # same concept by its original, same words
    assert detector.take(["энтропия"], [DEFINITION, OTHER]) is True  # one new statement is enough


def test_a_quote_shared_by_different_concepts_is_new_for_each() -> None:
    detector = LoopDetector()
    assert detector.take(["энтропия"], [DEFINITION])
    assert detector.take(["второе начало"], [DEFINITION])


def test_an_item_without_statements_adds_nothing() -> None:
    detector = LoopDetector()
    assert detector.take(["энтропия"], []) is False


def test_short_labels_count_only_when_exactly_the_same() -> None:
    detector = LoopDetector()
    assert detector.take(["etl"], ["Extract, transform, load."])
    assert detector.take(["lasso"], ["L1 regularisation."])  # short, but another concept
    assert detector.take(["etl"], ["extract transform load"]) is False
    assert detector.take(["etl"], ["Extract and load."])


def test_the_detector_forgets_an_answer_that_is_asked_again() -> None:
    detector = LoopDetector()
    state = detector.snapshot()
    assert detector.take(["энтропия"], [DEFINITION])
    detector.restore(state)
    assert detector.take(["энтропия"], [DEFINITION])


def _run(detector: LoopDetector) -> AnswerRun[str]:
    return AnswerRun(detector)


def test_three_items_in_a_row_that_add_nothing_are_a_loop_cut_before_the_first() -> None:
    detector = LoopDetector()
    run = _run(detector)
    run.add("a", "A", ["a"], [DEFINITION])
    run.add("b", "B", ["b"], [OTHER])
    run.add("a2", "A", ["a"], [RESTATED])
    run.add("b2", "B", ["b"], [OTHER])
    with pytest.raises(Looping) as stopped:
        run.add("a3", "A", ["a"], [DEFINITION])
    assert stopped.value.titles == ["A", "B", "A"]
    assert run.kept == ["a", "b"] and run.useful == 2  # the looping items are never kept


def test_scattered_repeats_between_useful_items_are_not_a_loop() -> None:
    run = _run(LoopDetector())
    run.add("a", "A", ["a"], [DEFINITION])
    for n in range(5):
        run.add(f"a{n}", "A", ["a"], [RESTATED])  # a repeat…
        run.add(f"new{n}", f"N{n}", [f"n{n}"], [f"{OTHER} Пример номер {n}."])  # …then something new
    assert run.useful == 6
    run.add("tail", "A", ["a"], [DEFINITION])
    assert run.close() == ["a", *[x for n in range(5) for x in (f"a{n}", f"new{n}")], "tail"]


def test_the_run_length_is_three() -> None:
    assert LOOP_RUN == 3


# -- duplicate filter ---------------------------------------------------------------------------


def test_a_near_duplicate_statement_of_the_same_concept_is_merged_with_its_refs() -> None:
    draft = ConceptDraft("Энтропия", "entropy", blocks=[_block(DEFINITION, 1)])
    again = ConceptDraft("Энтропия", None, blocks=[_block(RESTATED, 7), _block(OTHER, 8)])
    assert draft.absorb(again) == 1
    assert [block.text for block in draft.blocks] == [DEFINITION, OTHER]
    kept = draft.blocks[0]
    assert kept.segs == (1, 7)  # the second place in the source is not lost
    assert kept.quotes == ((1, "quote 1"), (7, "quote 7"))


def test_the_same_statement_of_another_kind_is_not_merged() -> None:
    draft = ConceptDraft("Энтропия", None, blocks=[_block(DEFINITION, 1)])
    assert draft.add(_block(DEFINITION, 2, kind="explanation")) is True
    assert len(draft.blocks) == 2


def test_a_shared_quote_stays_on_both_concepts() -> None:
    entropy = ConceptDraft("Энтропия", None)
    law = ConceptDraft("Второе начало", None)
    assert entropy.add(_block(DEFINITION, 1)) and law.add(_block(DEFINITION, 1))
    assert len(entropy.blocks) == len(law.blocks) == 1


def test_short_statements_of_a_concept_merge_only_when_identical() -> None:
    draft = ConceptDraft("ETL", None, blocks=[_block("Extract, transform, load.", 1)])
    assert draft.add(_block("Extract, transform, load.", 4)) is False
    assert draft.blocks[0].segs == (1, 4)
    assert draft.add(_block("Extract and load.", 5)) is True


def test_notes_drop_a_near_duplicate_within_same_titled_sections_but_keep_short_labels() -> None:
    first: list[CheckedBlock] = [_block("Пример:", 1), _block(DEFINITION, 1)]
    later: list[CheckedBlock] = []
    assert place_block(later, _block(RESTATED, 9), [first, later], exact_short=False) is False
    assert first[1].segs == (1, 9)
    assert place_block(later, _block("Пример:", 9), [first, later], exact_short=False) is True
    assert [block.text for block in later] == ["Пример:"]


def test_notes_drop_a_short_statement_written_again_for_the_same_fragments() -> None:
    kept: list[CheckedBlock] = [_block("Lasso: L1.", 3)]
    again: list[CheckedBlock] = []
    assert place_block(again, _block("Lasso: L1.", 3), [kept, again], exact_short=False) is False
    assert again == [] and kept[0].segs == (3,)


@pytest.mark.parametrize(("first", "second"), [
    ("Accept when p < 0.05.", "Accept when p > 0.05."),
    ("The root is +2.", "The root is -2."),
    ("The root is 2.", "The root is −2."),
    ("Accept when p < 0.05.", "Accept when p < 0.5."),
    ("For this long statement accept the measured result only when p < 0.05 in the test.",
     "For this long statement accept the measured result only when p > 0.05 in the test."),
])
def test_distinct_formulae_keep_their_own_statements_and_citations(first: str, second: str) -> None:
    draft = ConceptDraft("Criterion", None, blocks=[_block(first, 1)])
    assert draft.add(_block(second, 2)) is True
    assert [(block.text, block.segs, block.quotes) for block in draft.blocks] == [
        (first, (1,), ((1, "quote 1"),)), (second, (2,), ((2, "quote 2"),))]
    detector = LoopDetector()
    assert detector.take(["criterion"], [first])
    assert detector.take(["criterion"], [second])
    assert not detector.take(["criterion"], [second])
