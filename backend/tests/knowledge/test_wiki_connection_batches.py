"""C1-a: connections are found automatically, in batches, and only for new or changed data.

The writing agent is an authored ``FakeEngine`` script (``AuthoredWiki``): it reads the batch
prompt SKAZ sends and answers with the statement numbers it finds there. These tests prove the
planning, the batching, the cache of checked pairs, invalidation and resumption — NOT the
quality of a real model's connections and NOT any saving of a real subscription.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

import pytest

from skaz.knowledge.agents.engine import AgentTurn, Completed, Failed, TextDelta
from skaz.knowledge.agents.fake import Gate, ScriptItem
from skaz.knowledge.decisions.protocol import Answer, Question, YesNoAnswer
from skaz.knowledge.ingest import prompts
from skaz.knowledge.markdown.page import Block, parse_page, render_page
from skaz.knowledge.markdown.source import FragmentInput
from skaz.knowledge.service import KnowledgeService
from skaz.knowledge.store.database import KnowledgeDatabase
from skaz.knowledge.store.schema import MODULES
from skaz.knowledge.wiki import connections as connections_module

from .ingest_support import ScriptedWiki, add_material, block, cite, concept, concepts, notes
from .wiki_support import CONNECTIONS, LECTURE_NOTES, Batch, ingest_done, settle_wiki, wired

ENTROPY, TEMPERATURE, PARTICLES, GAS = "Энтропия", "Температура", "Частицы", "Газ"

#: One lecture, three concept pages that share it: three candidate pairs.
LECTURE_CONCEPTS = concepts(
    concept(ENTROPY, None, [
        block("from_source", "Мера беспорядка системы.", cite(1, "Энтропия — это мера беспорядка системы.")),
        block("from_source", "Энтропия газа растёт с температурой.", cite(3, "энтропия газа тоже растёт")),
    ]),
    concept(TEMPERATURE, None, [
        block("from_source", "Показывает энергию частиц.", cite(2, "среднюю кинетическую энергию частиц")),
    ]),
    concept(PARTICLES, None, [
        block("from_source", "У частиц есть кинетическая энергия.", cite(2, "кинетическую энергию частиц")),
    ]),
)
#: A later material in another folder with one new page, "Газ"; the old "Энтропия" mentions gas.
GAS_FRAGMENTS = [FragmentInput(text="Газ состоит из движущихся молекул.")]
GAS_STATEMENT = block("from_source", "Газ состоит из молекул.", cite(1, "Газ состоит из движущихся молекул."))
GAS_NOTES = notes((GAS, [GAS_STATEMENT]))
GAS_CONCEPTS = concepts(concept(GAS, None, [GAS_STATEMENT]))


Author = Callable[[Batch], list[dict[str, Any]]]


class AuthoredWiki(ScriptedWiki):
    """``ScriptedWiki`` whose connection answers are authored from the batch prompt they get."""

    def __init__(self, author: Author | None = None, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.author: Author = author or (lambda _batch: [])
        #: Connection turn numbers (1-based) that end with an authored model limit.
        self.fail_on: set[int] = set()
        self.connection_calls = 0
        #: Holds every connection answer until set (a connection run kept busy).
        self.hold: asyncio.Event | None = None
        #: Every connection answer is not in the expected format while set.
        self.garbled = False

    def _answer(self, turn: AgentTurn) -> list[ScriptItem]:
        assert turn.response_schema is not None
        if turn.response_schema["title"] != CONNECTIONS:
            return super()._answer(turn)
        self.connection_calls += 1
        if self.connection_calls in self.fail_on:
            return [Failed("", "limit", "Authored fixture: the model limit was reached.")]
        if self.garbled:  # an answer that is not the expected JSON (the repair turn gets the same)
            return [TextDelta("", "Sorry, here are my thoughts instead of JSON."), Completed("")]
        found = self.author(Batch.read(turn.messages[0].content))
        held: list[ScriptItem] = [Gate(self.hold)] if self.hold is not None else []
        return [*held, TextDelta("", json.dumps({"connections": found}, ensure_ascii=False)), Completed("")]

    def batches(self) -> list[Batch]:
        return [Batch.read(turn.messages[0].content) for turn in self.turns(CONNECTIONS)]


def asked(wiki: AuthoredWiki, since: int = 0) -> list[frozenset[str]]:
    """Every pair sent to the agent after the first ``since`` connection turns (repeats kept)."""
    return [pair for batch in wiki.batches()[since:] for pair in batch.unordered()]


def pair(a: str, b: str) -> frozenset[str]:
    return frozenset((a, b))


ALL_THREE = {pair(ENTROPY, TEMPERATURE), pair(ENTROPY, PARTICLES), pair(TEMPERATURE, PARTICLES)}


def ids(kb: KnowledgeService) -> dict[str, str]:
    return {page.title: page.id for page in kb.pages(kind="concept")}


def links(kb: KnowledgeService, title: str) -> list[str]:
    record = kb.page_repo.get(ids(kb)[title])
    assert record is not None
    document = parse_page((kb.library_root / record.rel_path).read_text(encoding="utf-8"))
    return [item.body for item in document.blocks() if item.id.startswith("c-link-")]


def connection_edges(service: Any) -> set[frozenset[str]]:
    """Connection edges between concept pages (a connection's citation links reach its materials too)."""
    concepts = set(ids(service.kb).values())
    return {frozenset((edge.source, edge.target)) for edge in service.graph.edges()
            if edge.kind == "connection" and {edge.source, edge.target} <= concepts}


def connection_jobs(ingest: Any) -> list[Any]:
    return [job for job in ingest.list_jobs() if job.kind == "connections"]


async def added(ingest: Any, service: Any, material_id: str) -> None:
    """Add a material to the wiki and wait for the connection run that follows it."""
    before = len(connection_jobs(ingest))
    await ingest_done(ingest, material_id)
    for _ in range(500):  # the follow-up starts just after the ingest job reads as finished
        if len(connection_jobs(ingest)) > before:
            break
        await asyncio.sleep(0.01)
    await settle_wiki(service, ingest)


async def lecture(kb: KnowledgeService, author: Author | None = None,
                  answer: Callable[[Question], Answer] | None = None) -> tuple[AuthoredWiki, Any, Any, str]:
    wiki = AuthoredWiki(author, notes=[LECTURE_NOTES], concepts=[LECTURE_CONCEPTS])
    ingest, service = wired(kb, wiki, answer)
    material = add_material(kb, "Физика", "Лекция 8")
    await added(ingest, service, material)
    return wiki, ingest, service, material


async def run(service: Any, ingest: Any, titles: list[str] | None) -> Any:
    scope = None if titles is None else [ids(service.kb)[title] for title in titles]
    job = await service.find_connections(scope)
    await service.jobs.wait(job.id)
    return ingest.job(job.id)


# -- (1) one material: its pairs in one batch, not one call per page ----------------------------------


def entropy_temperature(batch: Batch) -> list[dict[str, Any]]:
    found = batch.connect(ENTROPY, TEMPERATURE, "газа растёт", "энергию частиц",
                          "Рост температуры увеличивает беспорядок.")
    return [found] if found else []


async def test_a_new_material_checks_all_its_pairs_in_one_batched_call(ready: KnowledgeService) -> None:
    wiki, _ingest, service, material = await lecture(ready, entropy_temperature)
    # Three new concept pages (a per-page search made one call each), three candidate pairs: one call.
    assert len(wiki.turns(CONNECTIONS)) == 1
    [batch] = wiki.batches()
    assert batch.unordered() == ALL_THREE  # every pair covered, each exactly once
    assert len(batch.pairs) == 3
    # Each page's statements are listed once although the page is in two pairs (stable numbers).
    assert sorted(batch.pages.values()) == sorted([ENTROPY, TEMPERATURE, PARTICLES])
    # The written result is what the per-page search wrote: on the first page of the pair, both sides
    # cited with their checked quotes, plus the link to the other page; one connection edge.
    [written] = links(ready, ENTROPY) or links(ready, TEMPERATURE)
    assert "Рост температуры увеличивает беспорядок." in written
    holder = ENTROPY if links(ready, ENTROPY) else TEMPERATURE
    other = TEMPERATURE if holder == ENTROPY else ENTROPY
    assert written.endswith(f"[[Wiki/Concepts/{other}|{other}]]")
    record = ready.page_repo.get(ids(ready)[holder])
    assert record is not None
    document = parse_page((ready.library_root / record.rel_path).read_text(encoding="utf-8"))
    link = next(item for item in document.blocks() if item.id.startswith("c-link-"))
    assert link.kind == "connection" and link.owner == "agent"
    assert {(item.material_id, item.seg) for item in link.cites} == {(material, 3), (material, 2)}
    assert connection_edges(service) == {frozenset((ids(ready)[ENTROPY], ids(ready)[TEMPERATURE]))}


# -- (2) nothing changed: no model call -----------------------------------------------------------


async def test_running_again_with_nothing_changed_calls_no_model(ready: KnowledgeService) -> None:
    questions: list[Question] = []

    def unsure(question: Question) -> Answer:
        if getattr(question, "question", None) == connections_module.QUESTION:
            questions.append(question)
        return YesNoAnswer(0.5)

    wiki, ingest, service, material = await lecture(ready, answer=unsure)
    assert len(wiki.turns(CONNECTIONS)) == 1 and len(questions) == 3
    record = await run(service, ingest, [ENTROPY, TEMPERATURE, PARTICLES])
    assert record.state == "done", record.error
    record = await run(service, ingest, None)  # "Find connections now" over the whole wiki
    assert record.state == "done", record.error
    assert len(wiki.turns(CONNECTIONS)) == 1  # the three unchanged negative checks were reused
    assert len(questions) == 3  # nor is the decision layer asked again
    assert any("reused" in entry.message for entry in record.journal)
    # Adding the same material to the wiki again, unchanged: its pages' statements are the same.
    wiki.queues[prompts.NOTES_SCHEMA_TITLE].append(LECTURE_NOTES)
    wiki.queues[prompts.CONCEPTS_SCHEMA_TITLE].append(LECTURE_CONCEPTS)
    await added(ingest, service, material)
    assert len(wiki.turns(CONNECTIONS)) == 1


# -- (3) a cached "no connection" holds only for the exact statements checked ---------------------


async def test_a_cached_negative_is_rechecked_when_either_side_changes(ready: KnowledgeService) -> None:
    wiki, ingest, service, _material = await lecture(ready)
    assert set(asked(wiki)) == ALL_THREE
    # The user rewrites the statement of "Температура": only the pairs with that page are asked again.
    page = ids(ready)[TEMPERATURE]
    [statement] = [item for item in ready.page(page).entries if item.kind == "from_source"]
    service.update_block(page, statement.id, "Температура показывает среднюю энергию частиц.")
    await run(service, ingest, [ENTROPY, TEMPERATURE, PARTICLES])
    assert sorted(asked(wiki, since=1), key=sorted) == sorted(
        [pair(ENTROPY, TEMPERATURE), pair(TEMPERATURE, PARTICLES)], key=sorted)
    # Now the other side of the remaining pair changes: that pair is asked, the others are reused.
    page = ids(ready)[PARTICLES]
    [statement] = [item for item in ready.page(page).entries if item.kind == "from_source"]
    service.update_block(page, statement.id, "Частицы движутся и обладают кинетической энергией.")
    calls = len(wiki.turns(CONNECTIONS))
    # The scope is one page; the edited "Частицы" waits too (a manual edit, 2026-10-21, 5): both of
    # its pairs changed, the unchanged pair of "Энтропия" with "Температура" is reused.
    await run(service, ingest, [ENTROPY])
    assert sorted(asked(wiki, since=calls), key=sorted) == sorted(
        [pair(ENTROPY, PARTICLES), pair(TEMPERATURE, PARTICLES)], key=sorted)


# -- (4) a new page is checked against the old ones -----------------------------------------------


async def test_a_new_page_is_checked_against_old_pages(ready: KnowledgeService) -> None:
    wiki, ingest, service, _material = await lecture(ready)
    wiki.queues[prompts.NOTES_SCHEMA_TITLE].append(GAS_NOTES)
    wiki.queues[prompts.CONCEPTS_SCHEMA_TITLE].append(GAS_CONCEPTS)
    wiki.author = lambda batch: [found] if (found := batch.connect(
        GAS, ENTROPY, "состоит из молекул", "газа растёт",
        "Энтропия газа зависит от движения молекул.")) else []
    await added(ingest, service, add_material(ready, "Химия", "Учебник", GAS_FRAGMENTS, kind="book"))
    # The old pages' cached checks did not hide the new page: "Газ" was checked against "Энтропия",
    # and none of the old, unchanged pairs was asked again.
    assert asked(wiki, since=1) == [pair(GAS, ENTROPY)]
    assert links(ready, GAS) and links(ready, GAS)[0].endswith(f"[[Wiki/Concepts/{ENTROPY}|{ENTROPY}]]")
    assert frozenset((ids(ready)[GAS], ids(ready)[ENTROPY])) in connection_edges(service)


# -- (5) deleting or changing a source -------------------------------------------------------------


async def test_deleting_a_source_takes_its_connections_down_and_its_checks_are_redone(
        ready: KnowledgeService) -> None:
    wiki, ingest, service, lecture_id = await lecture(ready)
    wiki.queues[prompts.NOTES_SCHEMA_TITLE].append(GAS_NOTES)
    wiki.queues[prompts.CONCEPTS_SCHEMA_TITLE].append(
        concepts(
            concept(GAS, None, [block("from_source", "Газ состоит из молекул.",
                                      cite(1, "Газ состоит из движущихся молекул."))]),
            # The book also says something about "Энтропия": that page changes too.
            concept(ENTROPY, None, [block("from_source", "Энтропия газа связана с молекулами.",
                                          cite(1, "Газ состоит из движущихся молекул."))]),
        )
    )
    wiki.queues.setdefault(prompts.MATCH_SCHEMA_TITLE, []).append(json.dumps({"choice": 1}))
    wiki.author = lambda batch: [found] if (found := batch.connect(
        GAS, ENTROPY, "состоит из молекул", "Мера беспорядка",
        "Беспорядок газа — это беспорядок молекул.")) else []
    await added(ingest, service, add_material(ready, "Химия", "Учебник", GAS_FRAGMENTS, kind="book"))
    gas, entropy = ids(ready)[GAS], ids(ready)[ENTROPY]
    assert frozenset((gas, entropy)) in connection_edges(service)
    connections_before = len(wiki.turns(CONNECTIONS))

    # Deleting the lecture: the connection rested on its statement, so it goes (both sides or none).
    service.delete_material(lecture_id)
    assert links(ready, GAS) == []
    assert frozenset((gas, entropy)) not in connection_edges(service)
    # "Энтропия" stays on the book alone; its statements changed, so the old "no connection"
    # conclusions about it are not reused: the pair is asked again. The deletion left the changed
    # pages waiting, so the next run checks them even when it was started for other pages.
    wiki.author = lambda _batch: []
    record = await run(service, ingest, [])
    assert record.state == "done", record.error
    assert asked(wiki, since=connections_before) == [pair(GAS, ENTROPY)]
    # Unchanged since: reused.
    await run(service, ingest, [ENTROPY, GAS])
    assert len(wiki.turns(CONNECTIONS)) == connections_before + 1


# -- (6) batches are bounded by size; nothing is dropped -------------------------------------------


async def test_a_batch_over_the_size_bound_is_split_without_losing_a_pair(
        ready: KnowledgeService, monkeypatch: pytest.MonkeyPatch) -> None:
    # A bound smaller than any single pair: every pair goes alone, none is dropped.
    monkeypatch.setattr(connections_module, "MAX_BATCH_CHARS", 1)
    wiki, ingest, _service, _material = await lecture(ready)
    batches = wiki.batches()
    assert len(batches) == 3 and all(len(batch.pairs) == 1 for batch in batches)
    assert sorted(asked(wiki), key=sorted) == sorted(ALL_THREE, key=sorted)
    [job] = connection_jobs(ingest)
    assert job.counters["connection_pairs"] == 3 and job.counters["connection_batches"] == 3
    assert job.counters["connection_pairs_checked"] == 3


async def test_the_batch_bound_counts_the_prompt_size(
        ready: KnowledgeService, monkeypatch: pytest.MonkeyPatch) -> None:
    # Room for about two pages of statements: the three pairs need at least two batches.
    monkeypatch.setattr(connections_module, "MAX_BATCH_CHARS", 700)
    wiki, _ingest, _service, _material = await lecture(ready)
    batches = wiki.batches()
    assert len(batches) >= 2
    assert all(len(turn.messages[0].content) <= 700 or len(batch.pairs) == 1
               for turn, batch in zip(wiki.turns(CONNECTIONS), batches, strict=True))
    assert sorted(asked(wiki), key=sorted) == sorted(ALL_THREE, key=sorted)


# -- (7) the model stops mid-way: finished batches stay, the rest continues ------------------------


async def test_a_model_failure_keeps_finished_batches_and_the_rest_continues(
        ready: KnowledgeService, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(connections_module, "MAX_BATCH_CHARS", 1)
    wiki = AuthoredWiki(entropy_temperature, notes=[LECTURE_NOTES, GAS_NOTES],
                        concepts=[LECTURE_CONCEPTS, GAS_CONCEPTS])
    wiki.fail_on = {2}
    ingest, service = wired(ready, wiki)
    ingest.update_settings(engine="codex", model="fake-model")  # one pinned wiki model
    await added(ingest, service, add_material(ready, "Физика", "Лекция 8"))
    [job] = connection_jobs(ingest)
    assert job.state == "failed"
    assert job.error == "The agent stopped: Authored fixture: the model limit was reached."
    assert any("1 of 3" in entry.message for entry in job.journal)  # said plainly, not hidden
    assert len(wiki.turns(CONNECTIONS)) == 2  # it stopped at the failure: no third call, no other model
    first = asked(wiki)[0]

    # The next automatic run (another material added) continues the unfinished pairs too.
    await added(ingest, service, add_material(ready, "Химия", "Учебник", GAS_FRAGMENTS, kind="book"))
    later = asked(wiki, since=2)
    assert first not in later  # the finished batch was not paid for again
    assert set(ALL_THREE - {first}) <= set(later)  # the failed and the never-sent pairs were checked
    assert pair(GAS, ENTROPY) in later
    assert len(later) == len(set(later))
    assert {turn.model for turn in wiki.turns(CONNECTIONS)} == {"fake-model"}  # never another model
    if first == pair(ENTROPY, TEMPERATURE) or pair(ENTROPY, TEMPERATURE) in later:
        assert frozenset((ids(ready)[ENTROPY], ids(ready)[TEMPERATURE])) in connection_edges(service)
    # Nothing is left to continue: once more, no call.
    calls = len(wiki.turns(CONNECTIONS))
    await run(service, ingest, [ENTROPY, TEMPERATURE, PARTICLES, GAS])
    assert len(wiki.turns(CONNECTIONS)) == calls


# -- two materials back to back: the second one's pages are not skipped ---------------------------


async def test_a_material_finished_during_a_connection_run_still_gets_its_connections(
        ready: KnowledgeService) -> None:
    wiki = AuthoredWiki(notes=[LECTURE_NOTES, GAS_NOTES], concepts=[LECTURE_CONCEPTS, GAS_CONCEPTS])
    wiki.hold = asyncio.Event()
    ingest, service = wired(ready, wiki)
    await ingest_done(ingest, add_material(ready, "Физика", "Лекция 8"))
    for _ in range(500):  # the lecture's connection run is waiting for its answer …
        if any(turn.response_schema is not None and turn.response_schema["title"] == CONNECTIONS
               for turn in wiki.engine.turns):
            break
        await asyncio.sleep(0.01)
    assert service.jobs.running("connections")
    # … while the next material is added: its pages wait for that run instead of being skipped.
    await ingest_done(ingest, add_material(ready, "Химия", "Учебник", GAS_FRAGMENTS, kind="book"))
    await asyncio.sleep(0.05)  # the book's follow-up is waiting, not refused
    wiki.hold.set()
    for _ in range(500):
        if len(connection_jobs(ingest)) >= 2:
            break
        await asyncio.sleep(0.01)
    await settle_wiki(service, ingest)
    assert len(connection_jobs(ingest)) == 2
    assert set(asked(wiki)) >= ALL_THREE
    assert pair(GAS, ENTROPY) in asked(wiki)
    assert all(job.state == "done" for job in ingest.list_jobs() if job.kind == "connections")


# -- (8) a remembered "no connection" doesn't take a candidate slot (2026-10-21, 2) ---------------


async def test_a_remembered_negative_does_not_take_a_candidate_slot(
        ready: KnowledgeService, monkeypatch: pytest.MonkeyPatch) -> None:
    wiki, ingest, service, _material = await lecture(ready)
    assert set(asked(wiki)) == ALL_THREE  # every pair is remembered as "no connection"
    entropy = ready.page_repo.get(ids(ready)[ENTROPY])
    assert entropy is not None
    first, second = service.connections.candidates(entropy)
    # As if the pair with the second candidate had never been checked (a library from before C1-a).
    a, b = sorted((entropy.id, second.id))
    with ready.db.write() as connection:
        connection.execute("DELETE FROM wiki_connection_checks WHERE page_a = ? AND page_b = ?", (a, b))
    # One slot per page: the first candidate is a remembered "no", so the slot goes to the second.
    monkeypatch.setattr(connections_module, "MAX_CANDIDATES", 1)
    record = await run(service, ingest, [ENTROPY])
    assert record.state == "done", record.error
    assert asked(wiki, since=1) == [pair(ENTROPY, second.title)]
    assert first.title != second.title


# -- (9) an answer not in the expected format: three tries, then skipped (2026-10-21, 3) -----------


def pending(kb: KnowledgeService) -> set[str]:
    titles = {page_id: title for title, page_id in ids(kb).items()}
    with kb.db.read() as connection:
        rows = connection.execute("SELECT page_id FROM wiki_connection_pending").fetchall()
    return {titles.get(row[0], row[0]) for row in rows}


async def test_a_pair_without_a_well_formed_answer_is_tried_three_times_then_skipped(
        ready: KnowledgeService) -> None:
    wiki = AuthoredWiki(notes=[LECTURE_NOTES], concepts=[LECTURE_CONCEPTS])
    wiki.garbled = True
    ingest, service = wired(ready, wiki)
    await added(ingest, service, add_material(ready, "Физика", "Лекция 8"))  # attempt 1
    assert len(wiki.batches()) == 2  # the answer and its one repair turn
    assert all(item & pending(ready) for item in ALL_THREE)  # every pair's asking page waits
    second = await run(service, ingest, [])  # the pending pages continue: attempt 2
    assert second.state == "done", second.error
    assert set(asked(wiki, since=2)) == ALL_THREE
    third = await run(service, ingest, [])  # attempt 3: given up, said in the journal
    assert third.state == "done", third.error
    assert set(asked(wiki, since=4)) == ALL_THREE
    assert any("3 times" in entry.message and "skipped" in entry.message for entry in third.journal)
    assert pending(ready) == set()
    # Not asked again, neither for these pages nor by a whole-wiki run.
    calls = len(wiki.batches())
    await run(service, ingest, [ENTROPY, TEMPERATURE, PARTICLES])
    await run(service, ingest, None)
    assert len(wiki.batches()) == calls
    # Until a page's statements change: then its pairs are asked again (three new tries).
    wiki.garbled = False
    page = ids(ready)[TEMPERATURE]
    [statement] = [item for item in ready.page(page).entries if item.kind == "from_source"]
    service.update_block(page, statement.id, "Температура показывает среднюю энергию частиц.")
    await run(service, ingest, [TEMPERATURE])
    assert sorted(asked(wiki, since=calls), key=sorted) == sorted(
        [pair(ENTROPY, TEMPERATURE), pair(TEMPERATURE, PARTICLES)], key=sorted)


# -- (10) a connection the user deleted is never suggested again (2026-10-21, 4) -----------------


def holder_of_link(kb: KnowledgeService) -> tuple[str, str]:
    """(page title, block id) of the one connection written."""
    [(title, block_id)] = [
        (title, item.id) for title, page_id in ids(kb).items()
        for item in kb.page(page_id).entries if item.id.startswith("c-link-")
    ]
    return title, block_id


async def test_a_connection_the_user_deleted_is_never_suggested_again(ready: KnowledgeService) -> None:
    wiki, ingest, service, _material = await lecture(ready, entropy_temperature)
    holder, block_id = holder_of_link(ready)
    # The user deletes the agent's connection block on the page (the block's Delete).
    service.delete_note(ids(ready)[holder], block_id)
    assert links(ready, holder) == [] and connection_edges(service) == set()
    calls = len(wiki.batches())
    record = await run(service, ingest, None)
    assert record.state == "done", record.error
    assert len(wiki.batches()) == calls and links(ready, holder) == []
    # Not even after both pages' statements change: only the other pairs are asked.
    for title, text in ((ENTROPY, "Энтропия — мера беспорядка, она растёт с температурой газа."),
                        (TEMPERATURE, "Температура показывает среднюю энергию частиц.")):
        page = ids(ready)[title]
        statement = next(item for item in ready.page(page).entries if item.kind == "from_source")
        service.update_block(page, statement.id, text)
    await run(service, ingest, None)
    assert pair(ENTROPY, TEMPERATURE) not in asked(wiki, since=calls)
    assert set(asked(wiki, since=calls)) == ALL_THREE - {pair(ENTROPY, TEMPERATURE)}
    assert links(ready, ENTROPY) == [] and links(ready, TEMPERATURE) == []


async def test_a_connection_deleted_in_obsidian_is_remembered_and_the_page_waits(
        ready: KnowledgeService) -> None:
    wiki, ingest, service, _material = await lecture(ready, entropy_temperature)
    holder, block_id = holder_of_link(ready)
    watcher = service.watcher
    assert watcher.poll() == 0  # snapshot
    record = ready.page_repo.get(ids(ready)[holder])
    assert record is not None
    path = ready.library_root / record.rel_path
    document = parse_page(path.read_text(encoding="utf-8"))
    kept = [part for part in document.parts if not (isinstance(part, Block) and part.id == block_id)]
    path.write_text(render_page(replace(document, parts=kept)), encoding="utf-8")
    assert watcher.poll() == 1
    assert holder in pending(ready)  # an edit outside SKAZ is a manual edit too
    calls = len(wiki.batches())
    await run(service, ingest, [])
    assert pair(ENTROPY, TEMPERATURE) not in asked(wiki, since=calls)
    assert links(ready, holder) == []


# -- (11) a manual edit puts the page in the queue at once (2026-10-21, 5) ------------------------


async def test_a_manual_edit_puts_the_page_in_the_connection_queue(ready: KnowledgeService) -> None:
    wiki, ingest, service, _material = await lecture(ready)
    assert pending(ready) == set()
    page = ids(ready)[TEMPERATURE]
    [statement] = [item for item in ready.page(page).entries if item.kind == "from_source"]
    service.update_block(page, statement.id, "Температура показывает среднюю энергию частиц.")
    assert pending(ready) == {TEMPERATURE}
    service.add_note(ids(ready)[PARTICLES], "Моя заметка о частицах.", after_block_id=None, section=None)
    assert pending(ready) == {TEMPERATURE, PARTICLES}
    # The next automatic run (here one with no pages of its own) checks the edited page's pairs.
    calls = len(wiki.batches())
    record = await run(service, ingest, [])
    assert record.state == "done", record.error
    assert sorted(asked(wiki, since=calls), key=sorted) == sorted(
        [pair(ENTROPY, TEMPERATURE), pair(TEMPERATURE, PARTICLES)], key=sorted)
    assert pending(ready) == set()


# -- storage: an older database gains the tables ----------------------------------------------------


def test_an_older_database_gains_the_connection_check_tables(tmp_path: Path) -> None:
    path = tmp_path / "knowledge.sqlite3"
    older = KnowledgeDatabase(path, modules=tuple(m for m in MODULES if m.NAME != "wiki_connections"))
    older.close()
    current = KnowledgeDatabase(path)
    try:
        with current.read() as connection:
            rows = connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
            tables = {row[0] for row in rows}
            version = connection.execute(
                "SELECT version FROM schema_versions WHERE name='wiki_connections'").fetchone()
    finally:
        current.close()
    assert {"wiki_connection_checks", "wiki_connection_pending"} <= tables
    assert version is not None and version[0] == 2


#: The tables of ``wiki_connections`` v1, as an older build created them.
V1_SQL = """
CREATE TABLE IF NOT EXISTS wiki_connection_checks (
    page_a     TEXT NOT NULL,
    page_b     TEXT NOT NULL,
    input_key  TEXT NOT NULL,
    outcome    TEXT NOT NULL CHECK (outcome IN ('none', 'declined')),
    checked_at TEXT NOT NULL,
    PRIMARY KEY (page_a, page_b),
    CHECK (page_a < page_b)
);
CREATE TABLE IF NOT EXISTS wiki_connection_pending (
    page_id  TEXT PRIMARY KEY,
    added_at TEXT NOT NULL
);
"""


def test_a_v1_database_keeps_its_checks_and_gains_attempts_and_removed_pairs(tmp_path: Path) -> None:
    path = tmp_path / "knowledge.sqlite3"
    v1 = cast(Any, SimpleNamespace(NAME="wiki_connections", VERSION=1, SQL=V1_SQL))
    older = KnowledgeDatabase(path, modules=tuple(v1 if m.NAME == "wiki_connections" else m for m in MODULES))
    with older.write() as connection:
        connection.execute("INSERT INTO wiki_connection_checks VALUES ('p-a', 'p-b', 'k1', 'none', 't')")
        connection.execute("INSERT INTO wiki_connection_pending VALUES ('p-a', 't')")
    older.close()
    current = KnowledgeDatabase(path)
    try:
        with current.write() as connection:
            version = connection.execute(
                "SELECT version FROM schema_versions WHERE name='wiki_connections'").fetchone()
            kept = connection.execute(
                "SELECT page_a, page_b, input_key, outcome, attempts FROM wiki_connection_checks").fetchall()
            pending = connection.execute("SELECT page_id FROM wiki_connection_pending").fetchall()
            connection.execute("INSERT INTO wiki_connection_checks(page_a, page_b, input_key, outcome, "
                               "attempts, checked_at) VALUES ('p-a', 'p-c', '', 'removed', 0, 't')")
            connection.execute("INSERT INTO wiki_connection_checks(page_a, page_b, input_key, outcome, "
                               "attempts, checked_at) VALUES ('p-b', 'p-c', 'k2', 'unanswered', 2, 't')")
    finally:
        current.close()
    assert version is not None and version[0] == 2
    assert [tuple(row) for row in kept] == [("p-a", "p-b", "k1", "none", 0)]
    assert [row[0] for row in pending] == ["p-a"]
