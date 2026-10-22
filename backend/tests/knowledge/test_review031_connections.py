"""Review 0.3.1 (C-15): a connection answer not in the expected format counts against the pair it is
about (2026-10-21 #3: up to 3 attempts per pair, then skipped with a journal line), never against
every pair that shared its batch, and never as a remembered "no connection".

Authored connection answers only (``AuthoredWiki``): a fake at the model seam.
"""
from __future__ import annotations

from typing import Any

from skaz.knowledge.agents.engine import AgentTurn, Completed, TextDelta
from skaz.knowledge.agents.fake import ScriptItem
from skaz.knowledge.service import KnowledgeService
from tests.knowledge.ingest_support import add_material
from tests.knowledge.test_wiki_connection_batches import (
    ALL_THREE,
    ENTROPY,
    LECTURE_CONCEPTS,
    PARTICLES,
    TEMPERATURE,
    AuthoredWiki,
    added,
    asked,
    ids,
    pair,
    run,
)
from tests.knowledge.wiki_support import CONNECTIONS, LECTURE_NOTES, Batch, wired

BAD = pair(ENTROPY, TEMPERATURE)


class OneBadPair(AuthoredWiki):
    """Every connection answer for a batch with the ``BAD`` pair is not JSON; the rest are fine."""

    def _answer(self, turn: AgentTurn) -> list[ScriptItem]:
        assert turn.response_schema is not None
        batch = Batch.read(turn.messages[0].content)
        if turn.response_schema["title"] == CONNECTIONS and BAD in batch.unordered():
            self.connection_calls += 1
            return [TextDelta("", "Sorry, here are my thoughts instead of JSON."), Completed("")]
        return super()._answer(turn)


def checks(kb: KnowledgeService) -> dict[frozenset[str], tuple[str, int]]:
    titles = {page_id: title for title, page_id in ids(kb).items()}
    with kb.db.read() as connection:
        rows = connection.execute(
            "SELECT page_a, page_b, outcome, attempts FROM wiki_connection_checks").fetchall()
    return {frozenset((titles[row[0]], titles[row[1]])): (row[2], int(row[3])) for row in rows}


async def test_one_malformed_pair_is_split_off_and_only_it_is_skipped(ready: KnowledgeService) -> None:
    wiki = OneBadPair(notes=[LECTURE_NOTES], concepts=[LECTURE_CONCEPTS])
    ingest, service = wired(ready, wiki)
    await added(ingest, service, add_material(ready, "Физика", "Лекция 8"))  # attempt 1: one batch fails
    await run(service, ingest, [])  # attempt 2
    calls = len(wiki.batches())
    third = await run(service, ingest, [])  # attempt 3
    assert third.state == "done", third.error
    found = checks(ready)
    assert found[BAD] == ("unanswered", 3)
    assert all(found[item] == ("none", 0) for item in ALL_THREE - {BAD}), found
    assert any("1 connection pair(s)" in entry.message and "skipped" in entry.message
               for entry in third.journal)
    # The last try of a pair is alone in its batch (its failure is its own): the answer and its repair.
    last = [batch.unordered() for batch in wiki.batches()[calls:]]
    assert all(len(pairs) == 1 for pairs in last) and last.count({BAD}) == 2, last


def wrong_sides(batch: Batch) -> list[dict[str, Any]]:
    """A connection for Entropy–Temperature citing each page's statement on the other side."""
    found = batch.connect(ENTROPY, TEMPERATURE, "газа растёт", "энергию частиц", "Связь.")
    if found is None:
        return []
    found["first_side"], found["second_side"] = found["second_side"], found["first_side"]
    return [found]


async def test_a_malformed_entry_in_a_valid_answer_is_asked_again_not_remembered_as_none(
        ready: KnowledgeService) -> None:
    wiki = AuthoredWiki(wrong_sides, notes=[LECTURE_NOTES], concepts=[LECTURE_CONCEPTS])
    ingest, service = wired(ready, wiki)
    await added(ingest, service, add_material(ready, "Физика", "Лекция 8"))
    found = checks(ready)
    assert found[BAD] == ("unanswered", 1)
    assert found[pair(ENTROPY, PARTICLES)] == ("none", 0)
    assert found[pair(TEMPERATURE, PARTICLES)] == ("none", 0)
    calls = len(wiki.batches())
    await run(service, ingest, [])
    assert asked(wiki, since=calls) == [BAD]  # only that pair is asked again
