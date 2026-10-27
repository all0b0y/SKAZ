"""N2 decision 1(1): the quiet line at the material — "About N% of this is already in your wiki".

Computed by code from the wiki (``wiki.overlap``); the repeats come from authored answers, so these
tests prove the arithmetic and the links, not a model's judgement of what repeats.
"""

from __future__ import annotations

import json
import re
from dataclasses import replace
from typing import Any

from skaz.knowledge.api.materials import material_view
from skaz.knowledge.ingest import prompts as ingest_prompts
from skaz.knowledge.markdown.page import Block, Cite, parse_page, render_page
from skaz.knowledge.service import KnowledgeService
from skaz.knowledge.wiki.overlap import _section_of, material_overlap, section_overlap
from skaz.knowledge.wiki.pages_io import page_path, reindex
from tests.knowledge.ingest_support import block, cite, notes
from tests.knowledge.test_n2_repeats import DISORDER, UNIT, _case
from tests.knowledge.wiki_support import (
    DISCREPANCIES,
    ENTROPY_TITLE,
    LECTURE_CONCEPTS,
    LECTURE_NOTES,
    ingest_done,
    settle_wiki,
)

#: The textbook's Notes in two sections: the definition (repeats the lecture) and the unit (new).
TWO_SECTIONS = notes(
    ("Определение", [
        block("from_source", "Энтропия — мера беспорядка.", cite(1, "это мера беспорядка системы"))]),
    ("Единицы", [block("from_source", UNIT, cite(2, "измеряется в джоулях на кельвин"))]),
)


async def test_the_share_of_repeated_statements_with_pages_and_sections(ready: KnowledgeService) -> None:
    case = await _case(ready, p_yes=0.95, textbook_notes=TWO_SECTIONS)
    overlap = material_overlap(ready, case.textbook)
    assert overlap is not None
    assert (overlap.repeated, overlap.total, overlap.percent) == (1, 2, 50)
    assert [(page.title, page.repeated) for page in overlap.pages] == [(ENTROPY_TITLE, 1)]
    assert [page.id for page in overlap.pages] == [case.page_id]  # each repeat links to its page
    assert [section.title for section in overlap.repeated_sections] == ["Определение"]
    assert [section.title for section in overlap.new_sections] == ["Единицы"]
    assert [section.title for section in section_overlap(ready, case.textbook)] == ["Определение", "Единицы"]


async def test_the_first_source_has_nothing_repeated(ready: KnowledgeService) -> None:
    case = await _case(ready, p_yes=0.95)
    overlap = material_overlap(ready, case.lecture)
    assert overlap is not None and overlap.repeated == 0 and overlap.percent == 0 and overlap.pages == ()


async def test_no_repeat_no_overlap(ready: KnowledgeService) -> None:
    case = await _case(ready, p_yes=0.05)
    overlap = material_overlap(ready, case.textbook)
    assert overlap is not None and overlap.repeated == 0 and overlap.total == 2


async def test_once_the_first_source_is_gone_nothing_is_already_there(ready: KnowledgeService) -> None:
    case = await _case(ready, p_yes=0.95)
    case.service.delete_material(case.lecture)
    overlap = material_overlap(ready, case.textbook)
    assert overlap is not None and overlap.repeated == 0 and overlap.total == 2


async def test_a_material_outside_the_wiki_has_no_overlap(ready: KnowledgeService) -> None:
    case = await _case(ready, p_yes=0.95)
    case.service.delete_material(case.textbook)
    assert material_overlap(ready, case.textbook) is None


async def test_the_material_view_carries_the_line(ready: KnowledgeService) -> None:
    case = await _case(ready, p_yes=0.95, textbook_notes=TWO_SECTIONS)
    view = material_view(ready, case.textbook, case.service)
    assert view.overlap is not None
    assert view.overlap.model_dump() == {
        "percent": 50, "repeated": 1, "total": 2,
        "pages": [{"id": case.page_id, "title": ENTROPY_TITLE, "repeated": 1}],
        "new_sections": ["Единицы"], "repeated_sections": ["Определение"],
    }
    assert material_view(ready, case.lecture, case.service).overlap is not None


def _number(prompt: str, text: str) -> int:
    match = re.search(r"\[(\d+)\][^\n]*" + re.escape(text), prompt)
    assert match is not None, text
    return int(match.group(1))


async def test_re_adding_the_first_source_keeps_whose_words_are_whose(ready: KnowledgeService) -> None:
    # Q1 n2 M2: after the lecture is re-added and its statement now repeats the textbook's (back in
    # its own words), the lecture is the one that repeats; the textbook's statement is its own.
    case = await _case(ready, p_yes=0.95)

    def repeat_of_textbook(turn: Any) -> str:
        prompt = turn.messages[0].content
        new, existing = _number(prompt, DISORDER), _number(prompt, "Энтропия — мера беспорядка.")
        return json.dumps({"conflicts": [], "repeats": [{"page": 1, "new": new, "existing": existing}]})

    case.wiki.queues[ingest_prompts.NOTES_SCHEMA_TITLE].append(LECTURE_NOTES)
    case.wiki.queues[ingest_prompts.CONCEPTS_SCHEMA_TITLE].append(LECTURE_CONCEPTS)
    case.wiki.queues.setdefault(DISCREPANCIES, []).append(repeat_of_textbook)
    await ingest_done(case.ingest, case.lecture)
    await settle_wiki(case.service, case.ingest)
    assert case.statements()["Энтропия — мера беспорядка."] == {case.textbook, case.lecture}
    lecture, textbook = material_overlap(ready, case.lecture), material_overlap(ready, case.textbook)
    assert lecture is not None and textbook is not None
    assert lecture.repeated == 1 and textbook.repeated == 0


async def test_a_statement_written_with_two_sources_is_not_a_confirmed_repeat(
        ready: KnowledgeService) -> None:
    # "About N%" counts only repeats the decision layer confirmed and merged, not a statement that
    # simply cites two sources (e.g. one the chat agent wrote on the concept page).
    case = await _case(ready, p_yes=0.05)
    library, path = page_path(ready, case.page_id)
    document = parse_page(path.read_text(encoding="utf-8"))
    both = Block.create("c-0123456789ab", "from_source", "Энтропия растёт.",
                        cites=(Cite(case.lecture, 1), Cite(case.textbook, 1)))
    path.write_text(render_page(replace(document, parts=[*document.parts, both])), encoding="utf-8")
    reindex(ready, library, path)
    overlap = material_overlap(ready, case.textbook)
    assert overlap is not None and overlap.repeated == 0 and overlap.total == 3


def test_a_statement_between_interleaved_sections_goes_to_the_nearest_one() -> None:
    # Q1 n2 L5: notes whose sections interleave (1: segs 1 and 9, 2: segs 4 and 6) — a statement
    # citing seg 5 sits in both ranges; it belongs to the section with the nearest cited fragment.
    sections = [("One", {1, 9}), ("Two", {4, 6})]
    assert _section_of([5], sections) == 1
    assert _section_of([8], sections) == 0
    assert _section_of([4], sections) == 1  # a cited fragment itself still wins outright
    assert _section_of([20], sections) is None
