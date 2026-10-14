"""Source and wiki page formats: lossless round-trip, stable ids, verbatim quotes."""
from __future__ import annotations

import unicodedata

import pytest

from skaz.knowledge.markdown.page import (
    Block,
    Cite,
    Heading,
    PageDocument,
    PageFormatError,
    PageMeta,
    RawText,
    citation_link,
    parse_page,
    render_page,
    section_title,
)
from skaz.knowledge.markdown.source import (
    Fragment,
    FragmentInput,
    SourceFormatError,
    number_fragments,
    read_source,
    render_source,
)
from skaz.knowledge.markdown.text import block_hash, format_timestamp, normalize_text, quote_in_fragment


def speech(seg: int, text: str, start_ms: int, speaker: str | None = "1") -> Fragment:
    return Fragment(seg=seg, text=text, start_ms=start_ms, end_ms=start_ms + 5_000, speaker=speaker)


def test_timestamps_switch_to_hours_after_one_hour() -> None:
    assert format_timestamp(492_000) == "08:12"
    assert format_timestamp(3_599_999) == "59:59"
    assert format_timestamp(4_350_000) == "01:12:30"


def test_speech_source_round_trips_with_cyrillic_and_stable_block_ids() -> None:
    fragments = [
        speech(1, "Энтропия — мера беспорядка системы.", 0),
        speech(2, "Second speaker answers in English.\nAnd keeps talking.", 492_000, speaker="2"),
        speech(3, "Без диаризации.", 4_350_000, speaker=None),
    ]
    text = render_source("mat-1", "recording", fragments)

    assert "**Speaker 1** · 00:00\nЭнтропия — мера беспорядка системы. ^seg-1" in text
    assert "**Speaker 2** · 08:12\nSecond speaker answers in English.\nAnd keeps talking. ^seg-2" in text
    assert "01:12:30\nБез диаризации. ^seg-3" in text
    parsed = read_source(text, fragments)
    assert [(f.seg, f.text) for f in parsed] == [(f.seg, f.text) for f in fragments]
    assert render_source("mat-1", "recording", parsed) == text


def test_document_source_round_trips_pages_and_indexes() -> None:
    fragments = [
        Fragment(seg=1, text="Первый абзац PDF.", page=1),
        Fragment(seg=2, text="Second paragraph on page two.", page=2),
    ]
    text = render_source("mat-2", "pdf", fragments)
    assert text.startswith('---\nskaz_id: "mat-2"\nkind: "pdf"\n---\n')
    assert read_source(text, fragments) == fragments


def test_appending_fragments_never_renumbers_existing_ones() -> None:
    first = number_fragments([], [FragmentInput(text="one", start_ms=0),
                                  FragmentInput(text="two", start_ms=1_000)])
    later = number_fragments(first, [FragmentInput(text="three", start_ms=2_000)])
    assert [f.seg for f in first] == [1, 2]
    assert [f.seg for f in later] == [3]
    whole = render_source("mat-3", "recording", [*first, *later])
    assert whole.startswith(render_source("mat-3", "recording", first).rstrip("\n"))


def test_fragment_must_be_a_single_paragraph() -> None:
    with pytest.raises(SourceFormatError):
        number_fragments([], [FragmentInput(text="one\n\ntwo")])
    with pytest.raises(SourceFormatError):
        number_fragments([], [FragmentInput(text="   ")])


def test_quote_check_is_verbatim_after_whitespace_and_nfc_normalisation() -> None:
    fragment = "Энтропия —  мера\nбеспорядка системы."
    assert quote_in_fragment("мера беспорядка", fragment)
    assert quote_in_fragment(unicodedata.normalize("NFD", "Энтропия — мера"), fragment)
    assert not quote_in_fragment("Мера беспорядка", fragment)  # case is preserved
    assert not quote_in_fragment("мера хаоса", fragment)
    assert not quote_in_fragment("   ", fragment)


def test_block_hash_ignores_whitespace_layout_only() -> None:
    assert block_hash("a  b\nc") == block_hash(" a b c ")
    assert block_hash("a b c") != block_hash("a b C")
    assert len(block_hash("x")) == 12
    assert normalize_text(unicodedata.normalize("NFD", "й")) == "й"


PAGE = """---
skaz_id: "pg-1"
kind: "concept"
title: "Энтропия"
original: "entropy"
aliases: ["entropy", "S"]
folders: ["fld-1"]
language: "ru"
sources: ["mat-1"]
---

# Энтропия

## Из источников

%% skaz:block id=c-a1 kind=from_source owner=agent hash={h1} cites=mat-1:seg-12,mat-1:seg-14 %%
Энтропия — мера беспорядка [[Materials/Физика/Лекция 8/Лекция 8#^seg-12|Лекция 8 · 08:12]] ^c-a1

Пользователь дописал абзац без маркеров.
Вторая строка заметки.

## Мои заметки

- пункт списка пользователя
%% skaz:block id=c-b2 kind=user_note owner=user hash={h2} %%
- Моя проверенная заметка ^c-b2
"""


def page_text() -> str:
    body1 = "Энтропия — мера беспорядка [[Materials/Физика/Лекция 8/Лекция 8#^seg-12|Лекция 8 · 08:12]]"
    return PAGE.replace("{h1}", block_hash(body1)).replace("{h2}", block_hash("- Моя проверенная заметка"))


def test_page_round_trip_is_byte_exact_including_user_text() -> None:
    text = page_text()
    document = parse_page(text)
    assert render_page(document) == text
    assert document.meta.title == "Энтропия"
    assert document.meta.aliases == ("entropy", "S")
    blocks = document.blocks()
    assert [b.id for b in blocks] == ["c-a1", "c-b2"]
    assert blocks[0].cites == (Cite("mat-1", 12), Cite("mat-1", 14))
    assert blocks[0].hash_matches()
    notes = document.user_paragraphs()
    assert [n.text for n in notes] == [
        "Пользователь дописал абзац без маркеров.\nВторая строка заметки.",
        "- пункт списка пользователя",
    ]


def test_page_round_trip_survives_crlf_and_odd_spacing() -> None:
    text = page_text().replace("\n", "\r\n") + "\r\n\r\n   \r\ntrailing"
    assert render_page(parse_page(text)) == text


def test_marker_without_block_id_stays_user_text() -> None:
    text = page_text().replace(" ^c-a1", "")
    document = parse_page(text)
    assert render_page(document) == text
    assert [b.id for b in document.blocks()] == ["c-b2"]


def test_external_edit_changes_only_the_marker_line() -> None:
    text = page_text().replace("мера беспорядка", "мера   хаоса (моя правка)")
    document = parse_page(text)
    edited = document.blocks()[0]
    assert not edited.hash_matches()
    updated = document.with_block(edited.remarked(owner="user_edited"))
    out = render_page(updated)
    old_marker = next(line for line in text.splitlines() if "id=c-a1" in line)
    new_marker = next(line for line in out.splitlines() if "id=c-a1" in line)
    assert "owner=user_edited" in new_marker and f"hash={block_hash(edited.body)}" in new_marker
    assert out.replace(new_marker, old_marker) == text


def test_new_page_renders_canonically_and_parses_back() -> None:
    meta = PageMeta(skaz_id="pg-2", kind="note", title="Лекция 8", language="en", sources=("mat-1",))
    link = citation_link("Физика", "Лекция 8", 12, "08:12")
    block = Block.create(
        "c-x1", "from_source", f"Claim with a quote {link}", cites=(Cite("mat-1", 12),),
    )
    document = PageDocument(meta=meta, parts=[
        Heading(level=2, title=section_title("from_source", "en")), block,
    ])
    text = render_page(document)
    assert "## From sources\n" in text
    assert "[[Materials/Физика/Лекция 8/Лекция 8#^seg-12|Лекция 8 · 08:12]] ^c-x1" in text
    assert "%% skaz:block id=c-x1 kind=from_source owner=agent hash=" in text
    again = parse_page(text)
    assert render_page(again) == text
    assert again.blocks()[0].hash_matches()
    assert again.meta == meta


def test_frontmatter_written_by_obsidian_in_block_style_is_read() -> None:
    text = (
        "---\nskaz_id: pg-3\nkind: analysis\ntitle: Разбор\naliases:\n  - один\n  - два\n"
        "folders: []\nlanguage: ru\nsources: []\ncssclasses: wide\n---\nbody\n"
    )
    document = parse_page(text)
    assert document.meta.aliases == ("один", "два")
    assert document.meta.extra == {"cssclasses": "wide"}
    assert render_page(document) == text
    assert isinstance(document.parts[0], RawText)


@pytest.mark.parametrize("text", [
    "no frontmatter", "---\ntitle: x\n---\n", "---\nskaz_id: a\nkind: blog\n---\n",
])
def test_foreign_markdown_is_not_a_page(text: str) -> None:
    with pytest.raises(PageFormatError):
        parse_page(text)
