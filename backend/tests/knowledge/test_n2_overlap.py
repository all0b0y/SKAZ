"""N2 decision 1(1): the quiet line at the material — "About N% of this is already in your wiki".

Computed by code from the wiki (``wiki.overlap``); the repeats come from authored answers, so these
tests prove the arithmetic and the links, not a model's judgement of what repeats.
"""

from __future__ import annotations

from skaz.knowledge.api.materials import material_view
from skaz.knowledge.service import KnowledgeService
from skaz.knowledge.wiki.overlap import material_overlap, section_overlap
from tests.knowledge.ingest_support import block, cite, notes
from tests.knowledge.test_n2_repeats import UNIT, _case
from tests.knowledge.wiki_support import ENTROPY_TITLE

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
