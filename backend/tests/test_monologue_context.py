"""Monologue prompt block: labels in, checkable citations out."""

from __future__ import annotations

from audiohelper import monologue_context as mctx
from audiohelper import monologues as mono


def build(*speech: tuple[str, int | None]) -> list[mono.Monologue]:
    tokens = []
    for index, (text, speaker) in enumerate(speech):
        # Ten seconds apart: every entry is its own monologue regardless of speaker.
        tokens.append(mono.Token(
            id=f"t{index}", text=text + " ", start_ms=index * 10_000,
            end_ms=index * 10_000 + 1_000, speaker=speaker, segment_id=f"s{index}",
        ))
    return mono.build(tokens)


def test_entries_name_the_speaker_and_carry_a_label() -> None:
    context = mctx.build(build(("Первая мысль.", 1), ("Ответ.", 2)), budget_chars=10_000)
    assert "[P1]" in context.text and "[P2]" in context.text
    assert "Спикер 1" in context.text and "Спикер 2" in context.text
    assert "Первая мысль." in context.text


def test_undiarised_speech_is_labelled_honestly() -> None:
    context = mctx.build(build(("Речь без диаризации.", None)), budget_chars=10_000)
    assert "Спикер не определён" in context.text
    assert "Спикер 1" not in context.text


def test_a_cited_label_resolves_to_its_monologue_anchor() -> None:
    monologues = build(("Определение графа.", 1), ("Пример применения.", 1))
    context = mctx.build(monologues, budget_chars=10_000)
    (citation,) = context.citations_for("Дано определение графа. [P1]")
    assert citation.monologue_id == monologues[0].id
    assert citation.speaker == 1
    assert citation.text == "Определение графа."
    # The player and the transcript scroll still get a segment to address.
    assert citation.segment_id == "s0"


def test_an_unknown_label_cites_nothing() -> None:
    context = mctx.build(build(("Единственная мысль.", 1)), budget_chars=10_000)
    assert context.citations_for("Выдуманный источник. [P9]") == []


def test_an_unknown_label_is_reported_rather_than_repaired() -> None:
    context = mctx.build(build(("Единственная мысль.", 1)), budget_chars=10_000)
    assert mctx.unresolved(context.references, "Вывод. [P9]") == ["[P9]"]
    # A translated label is a broken identifier, never quietly read as [P1].
    assert mctx.unresolved(context.references, "Вывод. [П1]") == ["[П1]"]
    assert mctx.unresolved(context.references, "Вывод. [P1]") == []


def test_a_wide_range_fails_on_its_far_end() -> None:
    context = mctx.build(build(("Одна мысль.", 1)), budget_chars=10_000)
    assert mctx.unresolved(context.references, "Вывод. [P1-P9999]") == ["[P1-P9999]"]


def test_the_budget_truncates_visibly_instead_of_dropping_silently() -> None:
    context = mctx.build(build(*[(f"Мысль номер {n}.", 1) for n in range(20)]), budget_chars=200)
    assert context.truncated
    assert "truncated" in context.text
    # Only the monologues actually shown may be cited afterwards.
    assert all(key in context.text for key in context.references)


def test_offset_continues_the_numbering_across_batches() -> None:
    monologues = build(("Первая.", 1), ("Вторая.", 1))
    second = mctx.build(monologues[1:], budget_chars=10_000, offset=1)
    assert "[P2]" in second.text
    (citation,) = second.citations_for("Вывод. [P2]")
    assert citation.monologue_id == monologues[1].id
