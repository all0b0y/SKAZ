"""WR2 + WR3 over HTTP and the model seam, with authored model events only (no real model).

WR2 (decision 9b): a continuation is a new short request — Concepts: the same part, the finished
titles and the rule; Notes: the source from the last cited fragment with an overlap, the finished
section titles and the last section in full — never the previous answer replayed.
WR3 (decision 9c): repeats merge (never stop the job); 3 items in a row that add nothing new are a
loop: cut before the run, never kept, one continuation, a second loop right away fails honestly.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

import httpx

from skaz.knowledge.agents.engine import AgentTurn, Completed, ModelOption, TextDelta
from skaz.knowledge.agents.fake import FakeEngine, ScriptItem
from skaz.knowledge.ingest import prompts
from skaz.knowledge.markdown.source import FragmentInput
from tests.knowledge.ingest_support import (
    W2_EMPTY_ANSWERS,
    PatternDetector,
    add_material,
    block,
    cite,
    concept,
    concepts,
    notes,
    settle,
)
from tests.knowledge.test_ingest_pipeline import wiki_dir

SOURCE = [
    "Энтропия изолированной системы не убывает со временем, это второе начало термодинамики.",
    "Температура показывает среднюю кинетическую энергию частиц газа в сосуде.",
    "Ещё раз: энтропия изолированной системы не убывает со временем, это второе начало термодинамики.",
    "Давление газа возникает из-за ударов частиц о стенки сосуда.",
    "Объём газа при постоянном давлении растёт вместе с температурой.",
    "Теплоёмкость показывает, сколько тепла нужно для нагрева тела на один градус.",
    "Внутренняя энергия идеального газа зависит только от его температуры.",
    "Работа газа при расширении равна произведению давления на изменение объёма.",
]
FRAGMENTS = [FragmentInput(text=text, start_ms=n * 10_000, end_ms=n * 10_000 + 9_000, speaker="1")
             for n, text in enumerate(SOURCE)]

LAW = "Энтропия изолированной системы не убывает со временем, и это второе начало термодинамики."
LAW_AGAIN = "Энтропия изолированной системы не убывает со временем — и это второе начало термодинамики!"
QUOTE = "изолированной системы не убывает"
ENTROPY = concept("Энтропия", "entropy", [block("from_source", LAW, cite(1, QUOTE))])
ENTROPY_AGAIN = concept("Энтропия", None, [block("from_source", LAW_AGAIN, cite(3, QUOTE))])
ENTROPY_THIRD = concept("Энтропия", None, [block("from_source", LAW, cite(1, QUOTE))])
TEMPERATURE = concept("Температура", None, [block(
    "from_source", "Температура показывает среднюю кинетическую энергию частиц газа в сосуде.",
    cite(2, "среднюю кинетическую энергию частиц"))])
PRESSURE = concept("Давление", None, [block(
    "from_source", "Давление газа возникает из-за ударов частиц о стенки сосуда.", cite(4, "ударов частиц"))])
VOLUME = concept("Объём", None, [block(
    "from_source", "Объём газа при постоянном давлении растёт вместе с температурой.",
    cite(5, "растёт вместе"))])
NOTES = notes(("Термодинамика", [
    block("from_source", "Второе начало термодинамики.", cite(1, "второе начало"))]))


def whole(text: str) -> list[ScriptItem]:
    items: list[ScriptItem] = [TextDelta("", text[i:i + 11]) for i in range(0, len(text), 11)]
    return [*items, Completed("")]


@dataclass
class World:
    runtime: Any
    engine: FakeEngine
    material_id: str

    def turns(self, title: str) -> list[AgentTurn]:
        return [turn for turn in self.engine.turns
                if turn.response_schema is not None and turn.response_schema["title"] == title]

    def page(self, name: str) -> str:
        return (wiki_dir(self.runtime.kb) / "Concepts" / f"{name}.md").read_text(encoding="utf-8")

    def kept_answers(self) -> list[dict[str, Any]]:
        with self.runtime.kb.db.read() as connection:
            rows = connection.execute("SELECT response FROM wiki_checkpoint_answers WHERE material_id=?",
                                      (self.material_id,)).fetchall()
        return [json.loads(row[0]) for row in rows]


async def _world(kb_app: Any, kb_client: httpx.AsyncClient, *, notes_answers: list[str] | None = None,
                 concept_answers: list[str] | None = None,
                 models: list[ModelOption] | None = None) -> World:
    await kb_client.post("/kb/library", json={})
    runtime = kb_app.state.runtime
    queues = {prompts.NOTES_SCHEMA_TITLE: list(notes_answers or [NOTES]),
              prompts.CONCEPTS_SCHEMA_TITLE: list(concept_answers or [])}

    def answer(turn: AgentTurn) -> list[ScriptItem]:
        assert turn.response_schema is not None
        title = str(turn.response_schema["title"])
        queue = queues.get(title)
        if queue:
            return whole(queue.pop(0))
        if title == prompts.CONCEPTS_SCHEMA_TITLE:
            return whole(concepts())
        if title == prompts.NOTES_SCHEMA_TITLE:
            return whole(NOTES)
        return whole(W2_EMPTY_ANSWERS.get(title, '{"choices": []}'))

    engine = FakeEngine("codex", script=answer,
                        models=models or [ModelOption("wr-model", "WR", ("low",), "low")])
    runtime.kb_ingest.engines = lambda _engine: engine
    runtime.kb_ingest.detector = PatternDetector()
    saved = await kb_client.put("/kb/settings/wiki",
                                json={"wiki_engine": "codex", "wiki_model": "wr-model", "wiki_effort": "low",
                                      "write_notes_automatically": True})
    assert saved.status_code == 200, saved.text
    material_id = add_material(runtime.kb, "Physics", "Термодинамика", FRAGMENTS, kind="pdf")
    return World(runtime, engine, material_id)


async def _ingest(world: World, kb_client: httpx.AsyncClient) -> dict[str, Any]:
    job = (await kb_client.post(f"/kb/materials/{world.material_id}/ingest")).json()
    await settle(lambda: not world.runtime.kb_ingest.active_jobs())
    done: dict[str, Any] = (await kb_client.get(f"/kb/jobs/{job['id']}")).json()
    return done


def _journal(job: dict[str, Any]) -> str:
    return " ".join(entry["message"] for entry in job["journal"])


def _written_concepts(turn: AgentTurn) -> str:
    assert [m.role for m in turn.messages] == ["user"]
    content = turn.messages[0].content
    assert content.startswith("Continue listing the concepts in part 1 of 1")
    assert prompts.CONCEPTS_CONTINUE_RULE in content
    assert '"title_in_wiki_language"' not in content and '"more": true' not in content
    return content.split("Concepts already written for this part")[1].split(prompts.CONCEPTS_CONTINUE_RULE)[0]


# -- WR2 ----------------------------------------------------------------------------------------


async def test_a_concepts_continuation_lists_the_written_titles_and_sends_the_same_part(
    kb_app: Any, kb_client: httpx.AsyncClient,
) -> None:
    world = await _world(kb_app, kb_client, concept_answers=[
        concepts(ENTROPY, TEMPERATURE, more=True), concepts(PRESSURE)])
    done = await _ingest(world, kb_client)
    assert done["state"] == "done", done["error"]
    first, second = world.turns(prompts.CONCEPTS_SCHEMA_TITLE)
    written = _written_concepts(second)
    assert "Энтропия (entropy)" in written and "Температура" in written
    content = second.messages[0].content
    assert all(f"[seg-{n}] " in content for n in range(1, 9))  # the same part, whole
    assert first.messages[0].content.startswith("List the concepts in part 1 of 1")
    assert world.page("Давление")


async def test_a_notes_continuation_resumes_at_the_last_cited_fragment_with_an_overlap(
    kb_app: Any, kb_client: httpx.AsyncClient,
) -> None:
    head = notes(("Начало", [block("from_source", "Энтропия не убывает.", cite(1, "не убывает"))]),
                 ("Газ", [block("from_source", "Температура и энергия частиц.", cite(2, "энергию частиц")),
                          block("from_source", "Теплоёмкость и нагрев.", cite(6, "нужно для нагрева"))]),
                 more=True)
    tail = notes(("Работа", [block("from_source", "Работа при расширении.", cite(8, "при расширении"))]))
    world = await _world(kb_app, kb_client, notes_answers=[head, tail])
    done = await _ingest(world, kb_client)
    assert done["state"] == "done", done["error"]
    second = world.turns(prompts.NOTES_SCHEMA_TITLE)[1]
    assert [m.role for m in second.messages] == ["user"]
    content = second.messages[0].content
    # The highest cited fragment is 6: the source goes on from 4 (three fragments of overlap).
    assert [n for n in range(1, 9) if f"[seg-{n}] " in content] == [4, 5, 6, 7, 8]
    written = content.split("Sections already written for this part")[1].split("The last section")[0]
    assert "Начало" in written and "Газ" in written
    last = content.split("The last section written, in full")[1]
    assert "Температура и энергия частиц." in last and "Теплоёмкость и нагрев." in last
    assert '"sections"' not in content


# -- WR3: the duplicate filter ------------------------------------------------------------------


async def test_a_repeated_concept_merges_and_its_restated_statement_keeps_both_places(
    kb_app: Any, kb_client: httpx.AsyncClient,
) -> None:
    world = await _world(kb_app, kb_client, concept_answers=[
        concepts(ENTROPY, TEMPERATURE, ENTROPY_AGAIN, PRESSURE)])
    done = await _ingest(world, kb_client)
    assert done["state"] == "done", done["error"]  # the title rule of C1-f stopped here
    page = world.page("Энтропия (entropy)")
    assert page.count("изолированной системы не убывает") == 1  # one statement, not two
    assert "#^seg-1|" in page and "#^seg-3|" in page  # the second place in the source is kept
    assert "Repeats merged into statements already kept: 1" in _journal(done)


async def test_a_quote_shared_by_two_concepts_stays_on_both_pages(
    kb_app: Any, kb_client: httpx.AsyncClient,
) -> None:
    law = concept("Второе начало термодинамики", None, [
        block("from_source", LAW, cite(1, "изолированной системы не убывает"))])
    world = await _world(kb_app, kb_client, concept_answers=[concepts(ENTROPY, law)])
    done = await _ingest(world, kb_client)
    assert done["state"] == "done", done["error"]
    assert LAW in world.page("Энтропия (entropy)") and LAW in world.page("Второе начало термодинамики")
    assert "Repeats merged" not in _journal(done)


async def test_scattered_repeats_between_new_concepts_never_stop_the_answer(
    kb_app: Any, kb_client: httpx.AsyncClient,
) -> None:
    world = await _world(kb_app, kb_client, concept_answers=[
        concepts(ENTROPY, TEMPERATURE, ENTROPY_AGAIN, PRESSURE, TEMPERATURE, VOLUME, ENTROPY_THIRD)])
    done = await _ingest(world, kb_client)
    assert done["state"] == "done", done["error"]
    assert len(world.turns(prompts.CONCEPTS_SCHEMA_TITLE)) == 1
    assert "repeating itself" not in _journal(done)
    assert world.page("Температура").count("среднюю кинетическую энергию") == 1


# -- WR3: the loop detector ---------------------------------------------------------------------

LOOPING = concepts(ENTROPY, TEMPERATURE, ENTROPY_AGAIN, TEMPERATURE, ENTROPY_THIRD, PRESSURE, more=True)
LOOPING_AGAIN = concepts(TEMPERATURE, ENTROPY_AGAIN, TEMPERATURE, more=True)


async def test_a_concept_loop_is_cut_before_the_run_never_kept_and_continued_once(
    kb_app: Any, kb_client: httpx.AsyncClient,
) -> None:
    world = await _world(kb_app, kb_client, concept_answers=[LOOPING, concepts(PRESSURE, VOLUME)])
    done = await _ingest(world, kb_client)
    assert done["state"] == "done", done["error"]
    turns = world.turns(prompts.CONCEPTS_SCHEMA_TITLE)
    assert len(turns) == 2
    written = _written_concepts(turns[1])
    assert "Энтропия (entropy)" in written and "Температура" in written and "Давление" not in written
    journal = _journal(done)
    assert "3 concepts in a row added nothing new (“Энтропия”, “Температура”, “Энтропия”)" in journal
    assert "изолированной" not in journal  # counts and titles only
    # The looping items never reached the checkpoint; nor did "Давление" written after the run.
    kept = [[item["title_in_wiki_language"] for item in answer["concepts"]] for answer in world.kept_answers()
            if "concepts" in answer]
    assert ["Энтропия", "Температура"] in kept
    assert all(titles.count("Энтропия") <= 1 for titles in kept)
    assert world.page("Давление") and world.page("Объём")


async def test_a_second_concept_loop_right_away_fails_and_another_model_continues_from_kept_items(
    kb_app: Any, kb_client: httpx.AsyncClient,
) -> None:
    world = await _world(kb_app, kb_client, concept_answers=[LOOPING, LOOPING_AGAIN, concepts(PRESSURE)],
                         models=[ModelOption("wr-model", "WR", ("low",), "low"),
                                 ModelOption("other-model", "Other", ("low",), "low")])
    failed = await _ingest(world, kb_client)
    assert failed["state"] == "failed" and failed["can_retry"] is True
    assert failed["error"].startswith("The model kept repeating itself while writing the concepts")
    assert ("The 2 concepts before that are kept: Retry or another model in Settings → Models"
            in failed["error"])
    world.runtime.kb.rescan()  # SKAZ restarted: the startup scan keeps the answers (WR1)
    chosen = await kb_client.put("/kb/settings/wiki",
                                 json={"wiki_model": "other-model", "wiki_effort": "low"})
    assert chosen.status_code == 200, chosen.text
    done = await _ingest(world, kb_client)
    assert done["state"] == "done", done["error"]
    retry = world.turns(prompts.CONCEPTS_SCHEMA_TITLE)[-1]
    assert retry.model == "other-model"
    written = _written_concepts(retry)  # Retry sends the continuation, not the first request again
    assert "Энтропия (entropy)" in written and "Температура" in written
    assert len(world.turns(prompts.CONCEPTS_SCHEMA_TITLE)) == 3
    assert "2 concepts written by Codex · wr-model · low" in _journal(done)
    assert world.page("Давление")
