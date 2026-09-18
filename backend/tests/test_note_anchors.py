"""Notes are stored as clean prose; provenance rides alongside as spans."""

from __future__ import annotations

from audiohelper import note_anchors


def test_labels_are_removed_from_the_stored_text() -> None:
    cleaned = note_anchors.strip_labels("- Алгоритм даёт кратчайший путь. [P2]")
    assert cleaned.content == "- Алгоритм даёт кратчайший путь."
    assert "[P2]" not in cleaned.content


def test_the_link_points_at_the_statement_not_the_bullet() -> None:
    cleaned = note_anchors.strip_labels("- Алгоритм даёт кратчайший путь. [P2]")
    (link,) = cleaned.links
    assert cleaned.content[link.start : link.end] == "Алгоритм даёт кратчайший путь."
    assert link.labels == ("P2",)


def test_a_range_label_keeps_every_unit_it_names() -> None:
    cleaned = note_anchors.strip_labels("Вывод по началу записи. [S2-S4]")
    (link,) = cleaned.links
    assert link.labels == ("S2", "S3", "S4")


def test_several_labels_on_one_line_are_merged_without_duplicates() -> None:
    cleaned = note_anchors.strip_labels("Общий вывод. [P1] Ещё уточнение. [P1, P3]")
    (link,) = cleaned.links
    assert link.labels == ("P1", "P3")
    assert cleaned.content == "Общий вывод. Ещё уточнение."


def test_prose_brackets_are_left_alone() -> None:
    cleaned = note_anchors.strip_labels("Ссылка на [Рис 2] в лекции. [P5]")
    assert "[Рис 2]" in cleaned.content
    assert cleaned.links[0].labels == ("P5",)


def test_offsets_hold_across_several_lines() -> None:
    cleaned = note_anchors.strip_labels(
        "# Заголовок\n- Первый пункт. [P1]\n- Второй пункт. [P2]\n"
    )
    first, second = cleaned.links
    assert cleaned.content[first.start : first.end] == "Первый пункт."
    assert cleaned.content[second.start : second.end] == "Второй пункт."


def test_a_line_without_labels_produces_no_link() -> None:
    cleaned = note_anchors.strip_labels("Просто абзац, написанный пользователем.")
    assert cleaned.links == ()
    assert cleaned.content == "Просто абзац, написанный пользователем."


def test_a_line_that_is_only_a_label_links_nothing() -> None:
    # Nothing was actually stated here, so there is no statement to vouch for.
    cleaned = note_anchors.strip_labels("[P7]")
    assert cleaned.content == ""
    assert cleaned.links == ()


def test_headings_keep_their_markdown() -> None:
    cleaned = note_anchors.strip_labels("## Раздел про графы [P3]")
    assert cleaned.content == "## Раздел про графы"
    (link,) = cleaned.links
    assert cleaned.content[link.start : link.end] == "Раздел про графы"
