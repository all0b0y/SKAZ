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
from skaz.knowledge.ingest.pages import block_prefix, strip_material
from skaz.knowledge.markdown.page import Block, Cite, PageDocument, PageMeta, parse_page, render_page
from skaz.knowledge.markdown.source import FragmentInput
from skaz.knowledge.service import KnowledgeService
from skaz.knowledge.wiki.overlap import material_overlap
from skaz.knowledge.wiki.prompts import DISCREPANCY_SCHEMA
from skaz.knowledge.wiki.repeats import QUESTION, strengthen
from skaz.knowledge.wiki.retract import retract_material, retract_unquoted, strip_links
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


async def _case(kb: KnowledgeService, repeat: str | None = REPEAT, p_yes: float | None = None,
                textbook_notes: str = TEXTBOOK_NOTES) -> Case:
    wiki = ScriptedWiki(notes=[LECTURE_NOTES, textbook_notes], concepts=[LECTURE_CONCEPTS, TEXTBOOK_CONCEPTS],
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
    assert material_overlap(ready, case.textbook).repeated == 0  # type: ignore[union-attr]


async def test_without_a_decision_layer_the_writing_agent_s_mark_stands(ready: KnowledgeService) -> None:
    # Q1 n2 H3: a repeat merges only on the decision layer's confident "yes" (spec N2-2: the layer
    # confirms the pairs). No layer → the agent's mark alone deletes nothing: both paragraphs stay,
    # and nothing counts in the overlap line.
    case = await _case(ready)
    statements = case.statements()
    assert statements[DISORDER] == {case.lecture}
    assert statements["Энтропия — мера беспорядка."] == {case.textbook}
    assert material_overlap(ready, case.textbook).repeated == 0  # type: ignore[union-attr]


async def test_an_unsure_decision_layer_merges_nothing(ready: KnowledgeService) -> None:
    case = await _case(ready, p_yes=0.5)  # neither a confident yes nor a confident no
    statements = case.statements()
    assert statements[DISORDER] == {case.lecture}
    assert statements["Энтропия — мера беспорядка."] == {case.textbook}
    assert material_overlap(ready, case.textbook).repeated == 0  # type: ignore[union-attr]


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


async def test_deleting_the_first_source_brings_back_the_repeating_source_s_own_paragraph(
        ready: KnowledgeService) -> None:
    # Q1 n2 H2: the merged statement is the lecture's wording; the textbook never said it. When the
    # lecture goes, the textbook's own paragraph (its words, its citations) comes back instead of the
    # lecture's words staying under the textbook's citation.
    case = await _case(ready, p_yes=0.95)
    case.service.delete_material(case.lecture)
    statements = case.statements()
    assert DISORDER not in statements
    assert statements["Энтропия — мера беспорядка."] == {case.textbook}
    assert statements[UNIT] == {case.textbook}
    restored = next(part for part in case.document().blocks() if part.body.startswith("Энтропия — мера"))
    assert restored.owner == "agent" and restored.hash_matches() and "Лекция 8" not in restored.body
    assert restored.id.startswith(block_prefix(case.textbook))


async def test_re_adding_the_first_source_gives_the_repeat_back_to_its_source(
        ready: KnowledgeService) -> None:
    # Q1 n2 H1: re-adding the lecture (no repeat marked this time) must not leave the lecture's old
    # block citing only the textbook; the textbook's later re-ingest then replaces its own statements
    # cleanly — one paragraph per statement, no stale citation left behind.
    case = await _case(ready, p_yes=0.95)
    case.wiki.queues[ingest_prompts.NOTES_SCHEMA_TITLE].append(LECTURE_NOTES)
    case.wiki.queues[ingest_prompts.CONCEPTS_SCHEMA_TITLE].append(LECTURE_CONCEPTS)
    await ingest_done(case.ingest, case.lecture)
    await settle_wiki(case.service, case.ingest)
    statements = case.statements()
    assert statements[DISORDER] == {case.lecture}
    assert statements["Энтропия — мера беспорядка."] == {case.textbook}
    before = {part.id for part in case.document().blocks()
              if any(cite.material_id == case.textbook for cite in part.cites)}
    case.wiki.queues[ingest_prompts.NOTES_SCHEMA_TITLE].append(TEXTBOOK_NOTES)
    case.wiki.queues[ingest_prompts.CONCEPTS_SCHEMA_TITLE].append(TEXTBOOK_CONCEPTS)
    await ingest_done(case.ingest, case.textbook)
    await settle_wiki(case.service, case.ingest)
    textbook_blocks = [part for part in case.document().blocks()
                       if any(cite.material_id == case.textbook for cite in part.cites)]
    assert len(textbook_blocks) == 2  # the disorder statement and the unit, once each
    assert not before.intersection(part.id for part in textbook_blocks)  # all written by this ingest
    assert all(part.id.startswith(block_prefix(case.textbook)) for part in textbook_blocks)
    assert case.statements()[DISORDER] == {case.lecture}


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


SEA = "[[Materials/F/A/A#^seg-3|A · ¶ 3]]"


def _merged_water() -> PageDocument:
    """A's fuller statement with B's shorter repeat merged in (B adds nothing that A lacks)."""
    kept = Block.create("c-aaa-1", "from_source", f"Water boils at 100 °C at sea level. {A_LINK}",
                        cites=(Cite("mat-aaa", 1, "boils at 100 °C at sea level"),))
    repeat = Block.create("c-bbb-1", "from_source", f"Water boils at 100 °C. {B_LINK}",
                          cites=(Cite("mat-bbb", 2, "boils at 100"),))
    result = strengthen(_page(kept, repeat), "c-aaa-1", "c-bbb-1", lambda cites: [B_LINK] if cites else [])
    assert result is not None
    return parse_page(render_page(result))  # what is on disk, read back


def _only(document: PageDocument) -> Block:
    [only] = list(document.blocks())
    return only


def test_a_merged_statement_keeps_the_repeat_s_own_words_for_later() -> None:
    merged = _only(_merged_water())
    assert merged.body == f"Water boils at 100 °C at sea level. {A_LINK} {B_LINK}" and merged.hash_matches()
    assert [cite.material_id for cite in merged.cites] == ["mat-aaa", "mat-bbb"]


def test_deleting_the_first_source_restores_the_repeat_not_the_first_source_s_words() -> None:
    updated, result = retract_material(_merged_water(), "mat-aaa", "Materials/F/A")
    restored = _only(updated)
    assert restored.id == "c-bbb-1" and restored.body == f"Water boils at 100 °C. {B_LINK}"
    assert restored.cites == (Cite("mat-bbb", 2, "boils at 100"),) and restored.owner == "agent"
    assert result.removed == ["c-aaa-1"] and result.kept == ["c-bbb-1"]


def test_re_ingesting_the_first_source_restores_the_repeat_with_or_without_its_folder() -> None:
    for rel_dir in ("Materials/F/A", None):
        stripped, changed = strip_material(_merged_water(), "mat-aaa", rel_dir)
        restored = _only(stripped)
        assert changed == 1 and restored.id == "c-bbb-1"
        assert restored.body == f"Water boils at 100 °C. {B_LINK}" and restored.attrs == ()


def test_taking_the_repeating_source_off_removes_exactly_what_the_merge_added() -> None:
    for rel_dir in ("Materials/G/B", None):  # the added link is known even without B's folder
        stripped, changed = strip_material(_merged_water(), "mat-bbb", rel_dir)
        kept = _only(stripped)
        assert changed == 1 and kept.id == "c-aaa-1" and kept.attrs == ()
        assert kept.body == f"Water boils at 100 °C at sea level. {A_LINK}" and kept.hash_matches()
        assert [cite.material_id for cite in kept.cites] == ["mat-aaa"]
    updated, result = retract_material(_merged_water(), "mat-bbb", "Materials/G/B")
    assert _only(updated).body == f"Water boils at 100 °C at sea level. {A_LINK}"
    assert result.kept == ["c-aaa-1"] and not result.removed


def test_a_corrected_first_source_gives_the_repeat_back() -> None:
    # A's quote no longer verbatim after a recognition correction: A's statement goes, B's comes back.
    updated, result = retract_unquoted(_merged_water(), "mat-aaa", lambda _seg: "Water is wet.")
    assert _only(updated).id == "c-bbb-1" and result.removed == ["c-aaa-1"]
    # B's quote broken: only B's merged share comes off, A's statement stays.
    updated, result = retract_unquoted(_merged_water(), "mat-bbb", lambda _seg: "Ice is cold.")
    kept = _only(updated)
    assert kept.id == "c-aaa-1" and [cite.material_id for cite in kept.cites] == ["mat-aaa"]
    assert B_LINK not in kept.body and result.removed == ["c-bbb-1"]  # B's share, rewritten by its refresh



def test_taking_a_source_or_a_link_off_a_statement_keeps_its_marker_keys() -> None:
    # Q1 n2 M3: a kept statement keeps its other marker keys (here the merged repeat of B) when
    # another source is retracted or a link to a removed page is taken off.
    merged = _only(_merged_water())
    both = Block.create("c-aaa-1", "from_source", f"Water boils at 100 °C at sea level. {A_LINK} {SEA}",
                        cites=(*merged.cites[:1], Cite("mat-ccc", 3)), attrs=merged.attrs)
    updated, result = retract_material(_page(both), "mat-ccc", "Materials/H/C")
    assert result.kept == ["c-aaa-1"] and _only(updated).attrs == merged.attrs
    linked = Block.create("c-aaa-1", "from_source", f"{merged.body} [[Wiki/Concepts/Gone|Gone]]",
                          cites=merged.cites, attrs=merged.attrs)
    unlinked, changed = strip_links(_page(linked), {"Wiki/Concepts/Gone"})
    assert changed == ["c-aaa-1"] and _only(unlinked).attrs == merged.attrs


def test_a_repeat_already_back_on_the_page_is_not_restored_twice() -> None:
    merged = _only(_merged_water())
    again = Block.create("c-bbb-1", "from_source", f"Water boils at 100 °C. {B_LINK}",
                         cites=(Cite("mat-bbb", 2),))
    updated, _result = retract_material(_page(merged, again), "mat-aaa", "Materials/F/A")
    assert [block.id for block in updated.blocks()] == ["c-bbb-1"]
