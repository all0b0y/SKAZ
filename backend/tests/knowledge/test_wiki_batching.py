"""Wiki micro-calls asked in batches (slice 2 of the call audit, .dev/docs/CODEX-CALLS-AUDIT.md).

One agent call now carries many concept-match items and many pages' disagreement checks instead of
one call each. A batch answer that misses an item, or is not usable at all, is asked again for the
missing items one by one — never guessed, never silently dropped. Authored answers only: these tests
prove SKAZ's batching and fallback, not a real model's decisions.
"""
from __future__ import annotations

import json
import re

from skaz.knowledge.agents.engine import AgentTurn
from skaz.knowledge.decisions.protocol import Question, Undecided
from skaz.knowledge.ingest import prompts
from skaz.knowledge.markdown.source import FragmentInput
from skaz.knowledge.service import KnowledgeService
from tests.knowledge.ingest_support import (
    FakeDecisions,
    ScriptedWiki,
    add_material,
    block,
    cite,
    concept,
    concepts,
    match_answer,
    notes,
)
from tests.knowledge.test_ingest_pipeline import CONCEPTS_OK, NOTES_OK, run_ingest, service_for
from tests.knowledge.wiki_support import (
    DISCREPANCIES,
    LECTURE_CONCEPTS,
    LECTURE_NOTES,
    ingest_done,
    settle_wiki,
    wired,
)

SECOND = concepts(
    concept("Энтропия", None, [
        block("from_source", "Растёт вместе с температурой.", cite(3, "энтропия газа тоже растёт"))]),
    concept("Температура", None, [
        block("from_source", "Средняя кинетическая энергия.",
              cite(2, "Температура показывает среднюю кинетическую энергию частиц."))]),
)


def _undecided(_question: Question) -> Undecided:
    return Undecided("below the confidence threshold")


def _items(turn: AgentTurn) -> list[int]:
    return [int(number) for number in re.findall(r"^Item (\d+):$", turn.messages[0].content, re.M)]


def _choose(*picks: tuple[int, int]) -> str:
    return json.dumps({"choices": [{"item": item, "choice": choice} for item, choice in picks]})


def _match_every_item(turn: AgentTurn) -> str:
    return _choose(*((item, 1) for item in _items(turn)))


async def _two_materials(ready: KnowledgeService, matches: list[object]) -> tuple[ScriptedWiki, str]:
    first = add_material(ready, "Физика", "Лекция 8")
    second = add_material(ready, "Химия", "Лекция 2")
    wiki = ScriptedWiki(notes=[NOTES_OK, NOTES_OK], concepts=[CONCEPTS_OK, SECOND],
                        answers={prompts.MATCH_SCHEMA_TITLE: matches})  # type: ignore[dict-item]
    ingest = service_for(ready, wiki, decisions=FakeDecisions(_undecided))
    await run_ingest(ingest, first)
    job_id = await run_ingest(ingest, second)
    return wiki, str(ingest.job(job_id).counters.get("concepts_updated"))


async def test_undecided_concepts_are_matched_in_one_agent_call(ready: KnowledgeService) -> None:
    wiki, updated = await _two_materials(ready, [_match_every_item])
    asked = wiki.turns(prompts.MATCH_SCHEMA_TITLE)
    assert len(asked) == 1 and _items(asked[0]) == [1, 2]
    assert updated == "2"  # both concepts joined their existing pages
    assert sorted(page.title for page in ready.pages(kind="concept")) == ["Температура", "Энтропия (entropy)"]


async def test_an_item_missing_from_the_batch_answer_is_asked_alone(ready: KnowledgeService) -> None:
    wiki, updated = await _two_materials(ready, [_choose((1, 1)), _choose((1, 1))])
    asked = wiki.turns(prompts.MATCH_SCHEMA_TITLE)
    assert [_items(turn) for turn in asked] == [[1, 2], [1]]
    assert "Средняя кинетическая энергия" in asked[1].messages[0].content  # the missing one: Температура
    assert updated == "2"


async def test_an_unusable_batch_answer_falls_back_to_one_item_per_call(ready: KnowledgeService) -> None:
    wiki, updated = await _two_materials(ready, ["not json", _choose((1, 1)), _choose((1, 1))])
    asked = wiki.turns(prompts.MATCH_SCHEMA_TITLE)
    assert [_items(turn) for turn in asked] == [[1, 2], [1], [1]]
    assert updated == "2"  # each concept, asked alone, joined its page


# -- disagreement checks ----------------------------------------------------------------------

TEXTBOOK_TWO = [
    FragmentInput(text="Энтропия изолированной системы со временем убывает."),
    FragmentInput(text="Температура не связана с движением частиц."),
]
TEXTBOOK_TWO_CONCEPTS = concepts(
    concept("Энтропия", "entropy", [
        block("from_source", "Энтропия изолированной системы убывает.",
              cite(1, "Энтропия изолированной системы со временем убывает."))]),
    concept("Температура", None, [
        block("from_source", "Температура не связана с движением частиц.",
              cite(2, "Температура не связана с движением частиц."))]),
)


def _pages(turn: AgentTurn) -> dict[str, int]:
    return {title: int(number) for number, title in
            re.findall(r"^Concept page (\d+): (.+)$", turn.messages[0].content, re.M)}


def _temperature_conflict(turn: AgentTurn) -> str:
    page = _pages(turn).get("Температура")
    found = [] if page is None else [{"page": page, "new": 1, "existing": 2,
                                      "explanation": "Одна связывает с частицами, другая нет."}]
    return json.dumps({"conflicts": found}, ensure_ascii=False)


async def _textbook_after_lecture(ready: KnowledgeService, disagreements: list[object]) -> ScriptedWiki:
    decreases = block("from_source", "Энтропия изолированной системы убывает.",
                      cite(1, "Энтропия изолированной системы со временем убывает."))
    wiki = ScriptedWiki(notes=[LECTURE_NOTES, notes(("Энтропия", [decreases]))],
                        concepts=[LECTURE_CONCEPTS, TEXTBOOK_TWO_CONCEPTS],
                        answers={prompts.MATCH_SCHEMA_TITLE: [match_answer(1)]})
    ingest, service = wired(ready, wiki)
    await ingest_done(ingest, add_material(ready, "Физика", "Лекция 8"))
    await settle_wiki(service, ingest)
    wiki.queues[DISCREPANCIES] = list(disagreements)  # type: ignore[arg-type]
    await ingest_done(ingest, add_material(ready, "Химия", "Учебник", TEXTBOOK_TWO, kind="book"))
    await settle_wiki(service, ingest)
    return wiki


def _disagreeing_pages(kb: KnowledgeService) -> list[str]:
    with kb.db.read() as connection:
        ids = [row[0] for row in connection.execute("SELECT page_id FROM wiki_discrepancies")]
    titles = {page.id: page.title for page in kb.pages(kind="concept")}
    return sorted(titles[page_id] for page_id in ids)


async def test_pages_updated_by_one_source_are_checked_for_disagreements_in_one_call(
        ready: KnowledgeService) -> None:
    wiki = await _textbook_after_lecture(ready, [_temperature_conflict])
    asked = wiki.turns(DISCREPANCIES)
    assert len(asked) == 1 and sorted(_pages(asked[0])) == ["Температура", "Энтропия (entropy)"]
    assert _disagreeing_pages(ready) == ["Температура"]  # the conflict landed on the page it named


async def test_an_unusable_disagreement_batch_is_checked_again_page_by_page(ready: KnowledgeService) -> None:
    # Not usable twice (the answer and its one repair): each page is then asked on its own.
    wiki = await _textbook_after_lecture(ready, ["not json", "not json", _temperature_conflict,
                                                 _temperature_conflict])
    asked = wiki.turns(DISCREPANCIES)
    assert [len(_pages(turn)) for turn in asked] == [2, 2, 1, 1]
    assert _disagreeing_pages(ready) == ["Температура"]
