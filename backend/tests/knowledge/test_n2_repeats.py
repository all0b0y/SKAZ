"""N2 decisions 2(2) and 3: a repeat is marked in the disagreement check and strengthens, not duplicates.

Authored agent answers and decision-layer answers only (``ScriptedWiki`` / ``FakeDecisions``): these
tests prove what SKAZ does with a marked repeat — the second citation, no second paragraph, clean
re-ingest and delete — never whether a real model marks repeats well.
"""

from __future__ import annotations

import json
from typing import Any

from skaz.knowledge.decisions.protocol import Question, Undecided, YesNoAnswer
from skaz.knowledge.ingest import prompts as ingest_prompts
from skaz.knowledge.ingest.pages import strip_material
from skaz.knowledge.markdown.page import Block, Cite, PageDocument, PageMeta, parse_page
from skaz.knowledge.markdown.source import FragmentInput
from skaz.knowledge.service import KnowledgeService
from skaz.knowledge.wiki.prompts import DISCREPANCY_SCHEMA
from skaz.knowledge.wiki.repeats import QUESTION, strengthen
from tests.knowledge.ingest_support import ScriptedWiki, add_material, block, cite, concept, concepts, notes
from tests.knowledge.wiki_support import (
    DISCREPANCIES,
    ENTROPY_TITLE,
    LECTURE_CONCEPTS,
    LECTURE_NOTES,
    ingest_done,
    settle_wiki,
    wired,
)

DISORDER = "Мера беспорядка системы."  # the lecture's statement (existing number 3 on the page)
UNIT = "Единица измерения — джоуль на кельвин."
TEXTBOOK = [
    FragmentInput(text="Энтропия — это мера беспорядка системы."),
    FragmentInput(text="Энтропия измеряется в джоулях на кельвин."),
]
TEXTBOOK_NOTES = notes(("Энтропия", [
    block("from_source", "Энтропия — мера беспорядка.", cite(1, "это мера беспорядка системы")),
    block("from_source", UNIT, cite(2, "измеряется в джоулях на кельвин")),
]))
TEXTBOOK_CONCEPTS = concepts(concept("Энтропия", "entropy", [
    block("from_source", "Энтропия — мера беспорядка.", cite(1, "это мера беспорядка системы")),
    block("from_source", UNIT, cite(2, "измеряется в джоулях на кельвин")),
]))
#: New statements first (the textbook's: 1 disorder, 2 unit), then the lecture's (3 disorder, 4 gas).
REPEAT = json.dumps({"conflicts": [], "repeats": [{"new": 1, "existing": 3}]})


def _verdict(p_yes: float | None) -> Any:
    def answer(question: Question) -> Any:
        if getattr(question, "question", "") == QUESTION and p_yes is not None:
            return YesNoAnswer(p_yes=p_yes)
        return Undecided("not asked in this test")
    return answer


class Case:
    def __init__(self, kb: KnowledgeService, wiki: ScriptedWiki, ingest: Any, service: Any,
                 lecture: str, textbook: str) -> None:
        self.kb, self.wiki, self.ingest, self.service = kb, wiki, ingest, service
        self.lecture, self.textbook = lecture, textbook

    @property
    def page_id(self) -> str:
        return next(page.id for page in self.kb.pages(kind="concept") if page.title == ENTROPY_TITLE)

    def document(self) -> PageDocument:
        record = self.kb.page_repo.get(self.page_id)
        assert record is not None
        return parse_page((self.kb.library_root / record.rel_path).read_text(encoding="utf-8"))

    def statements(self) -> dict[str, set[str]]:
        """Statement text (without links) → the materials it cites."""
        return {block.text.split(" [[")[0]: {cite.material_id for cite in block.citations}
                for block in self.kb.page_repo.blocks(self.page_id) if block.kind == "from_source"}

    def disorder(self) -> Block:
        return next(part for part in self.document().blocks() if part.body.startswith(DISORDER))


async def _case(kb: KnowledgeService, repeat: str | None = REPEAT, p_yes: float | None = None) -> Case:
    wiki = ScriptedWiki(notes=[LECTURE_NOTES, TEXTBOOK_NOTES], concepts=[LECTURE_CONCEPTS, TEXTBOOK_CONCEPTS],
                        matches=[1])
    ingest, service = wired(kb, wiki, _verdict(p_yes) if p_yes is not None else None)
    lecture = add_material(kb, "Физика", "Лекция 8")
    await ingest_done(ingest, lecture)
    await settle_wiki(service, ingest)
    textbook = add_material(kb, "Химия", "Учебник", TEXTBOOK, kind="book")
    if repeat is not None:
        wiki.queues.setdefault(DISCREPANCIES, []).append(repeat)
    await ingest_done(ingest, textbook)
    await settle_wiki(service, ingest)
    return Case(kb, wiki, ingest, service, lecture, textbook)


def test_the_disagreement_answer_carries_repeats_in_the_same_schema() -> None:
    assert set(DISCREPANCY_SCHEMA["properties"]) == {"conflicts", "repeats"}
    item = DISCREPANCY_SCHEMA["properties"]["repeats"]["items"]
    assert set(item["required"]) == {"page", "new", "existing"}


async def test_a_confirmed_repeat_adds_a_second_source_instead_of_a_second_paragraph(
        ready: KnowledgeService) -> None:
    case = await _case(ready, p_yes=0.95)
    assert len(case.wiki.turns(DISCREPANCIES)) == 1  # the repeat rode the disagreement call
    statements = case.statements()
    assert statements[DISORDER] == {case.lecture, case.textbook}  # "2 sources"
    assert "Энтропия — мера беспорядка." not in statements  # the repeat is not written again
    assert statements[UNIT] == {case.textbook}  # what is new is written as text
    body = case.disorder().body
    assert "Лекция 8" in body and "Учебник" in body  # both citation links, the textbook's added
    assert body.index("Лекция 8") < body.index("Учебник")
    page = ready.page_repo.get(case.page_id)
    assert page is not None and case.textbook in page.sources


async def test_a_confident_no_keeps_both_paragraphs(ready: KnowledgeService) -> None:
    case = await _case(ready, p_yes=0.05)
    statements = case.statements()
    assert statements[DISORDER] == {case.lecture}
    assert statements["Энтропия — мера беспорядка."] == {case.textbook}


async def test_without_a_decision_layer_the_writing_agent_s_mark_stands(ready: KnowledgeService) -> None:
    case = await _case(ready)  # no decision layer: undecided, logged, the agent's word kept (B9)
    assert case.statements()[DISORDER] == {case.lecture, case.textbook}


async def test_no_repeat_marked_writes_both_as_before(ready: KnowledgeService) -> None:
    case = await _case(ready, repeat=json.dumps({"conflicts": []}))
    assert case.statements()["Энтропия — мера беспорядка."] == {case.textbook}
    assert case.statements()[DISORDER] == {case.lecture}


async def test_deleting_the_repeating_source_leaves_the_statement_on_its_first_source(
        ready: KnowledgeService) -> None:
    case = await _case(ready, p_yes=0.95)
    case.service.delete_material(case.textbook)
    assert case.statements()[DISORDER] == {case.lecture}
    block = case.disorder()
    assert "Учебник" not in block.body and block.owner == "agent" and block.hash_matches()


async def test_deleting_the_first_source_leaves_the_statement_on_the_repeating_one(
        ready: KnowledgeService) -> None:
    case = await _case(ready, p_yes=0.95)
    case.service.delete_material(case.lecture)
    statements = case.statements()
    assert statements[DISORDER] == {case.textbook}
    assert "Лекция 8" not in case.disorder().body


async def test_re_adding_the_repeating_source_strengthens_once_not_twice(ready: KnowledgeService) -> None:
    case = await _case(ready, p_yes=0.95)
    case.wiki.queues[ingest_prompts.NOTES_SCHEMA_TITLE].append(TEXTBOOK_NOTES)
    case.wiki.queues[ingest_prompts.CONCEPTS_SCHEMA_TITLE].append(TEXTBOOK_CONCEPTS)
    case.wiki.queues.setdefault(DISCREPANCIES, []).append(REPEAT)
    await ingest_done(case.ingest, case.textbook)
    await settle_wiki(case.service, case.ingest)
    statements = case.statements()
    assert statements[DISORDER] == {case.lecture, case.textbook}
    assert "Энтропия — мера беспорядка." not in statements
    cites = [cite.material_id for cite in case.disorder().cites]
    assert cites.count(case.textbook) == 1 and case.disorder().body.count("|Учебник · ") == 1


async def test_re_adding_without_the_concept_takes_its_citation_off_the_statement(
        ready: KnowledgeService) -> None:
    case = await _case(ready, p_yes=0.95)
    other = concepts(concept("Джоуль", None, [block("from_source", UNIT, cite(2, "измеряется в джоулях"))]))
    case.wiki.queues[ingest_prompts.NOTES_SCHEMA_TITLE].append(TEXTBOOK_NOTES)
    case.wiki.queues[ingest_prompts.CONCEPTS_SCHEMA_TITLE].append(other)
    await ingest_done(case.ingest, case.textbook)
    await settle_wiki(case.service, case.ingest)
    assert case.statements()[DISORDER] == {case.lecture}
    assert "Учебник" not in case.disorder().body
    page = ready.page_repo.get(case.page_id)
    assert page is not None and case.textbook not in page.sources


# -- the pure parts ----------------------------------------------------------------------------


def _page(*blocks: Block) -> PageDocument:
    meta = PageMeta(skaz_id="pg-x", kind="concept", title="X", language="en")
    return PageDocument(meta=meta, parts=list(blocks))


A_LINK = "[[Materials/F/A/A#^seg-1|A · ¶ 1]]"
B_LINK = "[[Materials/G/B/B#^seg-2|B · ¶ 2]]"


def test_strengthen_moves_the_citation_and_drops_the_repeat() -> None:
    kept = Block.create("c-aaa-1", "from_source",
                        f"Water boils at 100 °C. {A_LINK} [[Wiki/Concepts/Heat|Heat]]",
                        cites=(Cite("mat-aaa", 1, "boils"),))
    repeat = Block.create("c-bbb-1", "from_source", f"At 100 °C water boils. {B_LINK}",
                          cites=(Cite("mat-bbb", 2, "boils at"),))
    result = strengthen(_page(kept, repeat), "c-aaa-1", "c-bbb-1", lambda cites: [B_LINK] if cites else [])
    assert result is not None
    [only] = list(result.blocks())
    assert only.id == "c-aaa-1" and only.owner == "agent" and only.hash_matches()
    assert [cite.material_id for cite in only.cites] == ["mat-aaa", "mat-bbb"]
    assert only.body == f"Water boils at 100 °C. {A_LINK} {B_LINK} [[Wiki/Concepts/Heat|Heat]]"


def test_strengthen_never_touches_the_user_s_words() -> None:
    kept = Block.create("c-aaa-1", "from_source", f"Water boils. {A_LINK}", cites=(Cite("mat-aaa", 1),),
                        owner="user_edited")
    repeat = Block.create("c-bbb-1", "from_source", f"Water boils. {B_LINK}", cites=(Cite("mat-bbb", 2),))
    assert strengthen(_page(kept, repeat), "c-aaa-1", "c-bbb-1", lambda cites: [B_LINK]) is None


def test_strip_material_takes_only_the_citation_off_a_statement_others_support() -> None:
    both = Block.create("c-aaa-1", "from_source", f"Water boils. {A_LINK} {B_LINK}",
                        cites=(Cite("mat-aaa", 1), Cite("mat-bbb", 2)))
    own = Block.create("c-bbb-2", "from_source", f"Ice melts. {B_LINK}", cites=(Cite("mat-bbb", 2),))
    confirmed = Block.create("c-bbb-3", "from_source", f"Steam is hot. {B_LINK} {A_LINK}",
                             cites=(Cite("mat-bbb", 2), Cite("mat-aaa", 1)))
    stripped, changed = strip_material(_page(both, own, confirmed), "mat-bbb", "Materials/G/B")
    kept = {block.id: block for block in stripped.blocks()}
    assert changed == 3 and set(kept) == {"c-aaa-1", "c-bbb-3"}
    assert kept["c-aaa-1"].body == f"Water boils. {A_LINK}"
    assert [cite.material_id for cite in kept["c-aaa-1"].cites] == ["mat-aaa"]
    assert kept["c-bbb-3"].body == f"Steam is hot. {A_LINK}"
    # Without the material's folder (no link to take off) it is as before N2: only its own blocks go.
    old, count = strip_material(_page(both, own), "mat-bbb")
    assert count == 1 and [block.id for block in old.blocks()] == ["c-aaa-1"]
