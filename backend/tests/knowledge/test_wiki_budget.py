"""C1-d over HTTP and the model seam, with authored model events only (no real model).

The wiki budget of one material counts the characters sent to and received from the model for
all of its processing (Notes, Concepts, matching, follow-up overview/connections). When it is
reached the job pauses, keeps its finished verified work, publishes nothing unfinished, and
Continue resumes from the checkpoint with another budget portion. Decided by the user 2026-10-20.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

import httpx

from skaz.knowledge.agents.engine import AgentTurn, Completed, ModelOption, TextDelta
from skaz.knowledge.agents.fake import FakeEngine, ScriptItem
from skaz.knowledge.ingest import prompts
from skaz.knowledge.ingest.settings import PROVISIONAL_BUDGET_CHARACTERS, WIKI_BUDGET
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
from tests.knowledge.test_ingest_pipeline import CONCEPTS_OK, NOTES_OK, wiki_dir

ONE = ("Энтропия", [block("from_source", "Энтропия определяется как мера беспорядка системы.",
                          cite(1, "мера беспорядка системы"))])
TWO = ("Температура", [block("from_source", "Температура связана со средней кинетической энергией частиц.",
                             cite(2, "среднюю кинетическую энергию частиц"))])
THREE = ("Рост энтропии", [block("from_source", "Если температура растёт, энтропия газа тоже растёт.",
                                 cite(3, "энтропия газа тоже растёт"))])
#: An explanation long enough to cross a 50 000-character budget on its own.
LONG = "Очень длинное пояснение. " * 2_600


def section(item: tuple[str, list[dict[str, Any]]]) -> str:
    return json.dumps({"title": item[0], "blocks": item[1]}, ensure_ascii=False)


def chunks(text: str, size: int = 400) -> list[ScriptItem]:
    return [TextDelta("", text[i:i + size]) for i in range(0, len(text), size)]


def whole(text: str) -> list[ScriptItem]:
    return [TextDelta("", text), Completed("")]


@dataclass
class World:
    runtime: Any
    engine: FakeEngine
    material_id: str

    def turns(self, title: str) -> list[AgentTurn]:
        return [turn for turn in self.engine.turns
                if turn.response_schema is not None and turn.response_schema["title"] == title]


async def _world(kb_app: Any, kb_client: httpx.AsyncClient, *, notes_answers: list[list[ScriptItem]],
                 concepts_answers: list[list[ScriptItem]] | None = None,
                 budget: int | None = None) -> World:
    await kb_client.post("/kb/library", json={})
    runtime = kb_app.state.runtime
    notes_queue = list(notes_answers)
    concepts_queue = list(concepts_answers or [])

    def answer(turn: AgentTurn) -> list[ScriptItem]:
        assert turn.response_schema is not None
        title = turn.response_schema["title"]
        if title == prompts.NOTES_SCHEMA_TITLE:
            return notes_queue.pop(0)
        if title == prompts.CONCEPTS_SCHEMA_TITLE:
            return concepts_queue.pop(0) if concepts_queue else whole(CONCEPTS_OK)
        return whole(W2_EMPTY_ANSWERS.get(str(title), '{"choice":0}'))

    engine = FakeEngine("codex", script=answer,
                        models=[ModelOption("budget-model", "Budget", ("low",), "low")])
    runtime.kb_ingest.engines = lambda _engine: engine
    runtime.kb_ingest.detector = PatternDetector()
    profile: dict[str, Any] = {"wiki_engine": "codex", "wiki_model": "budget-model", "wiki_effort": "low"}
    if budget is not None:
        profile["wiki_budget_characters"] = budget
    saved = await kb_client.put("/kb/settings/wiki", json=profile)
    assert saved.status_code == 200, saved.text
    material_id = add_material(runtime.kb, "Physics", "Лекция 8", kind="pdf")
    return World(runtime, engine, material_id)


async def _settled(world: World) -> None:
    await settle(lambda: not world.runtime.kb_ingest.active_jobs() and not world.runtime.kb_wiki.busy)


async def _ingest(world: World, kb_client: httpx.AsyncClient) -> dict[str, Any]:
    response = await kb_client.post(f"/kb/materials/{world.material_id}/ingest")
    assert response.status_code == 202, response.text
    job = response.json()
    await _settled(world)
    done: dict[str, Any] = (await kb_client.get(f"/kb/jobs/{job['id']}")).json()
    return done


async def _material_wiki(world: World, kb_client: httpx.AsyncClient) -> dict[str, Any]:
    wiki: dict[str, Any] = (await kb_client.get(f"/kb/materials/{world.material_id}")).json()["wiki"]
    return wiki


def _notes_page(world: World) -> Any:
    return wiki_dir(world.runtime.kb) / "Notes" / "Лекция 8.md"


def _headings(world: World) -> list[str]:
    note = _notes_page(world).read_text(encoding="utf-8")
    return [line[3:] for line in note.splitlines() if line.startswith("## ") and line != "## Concepts"]


async def test_the_budget_setting_has_a_provisional_default_and_can_be_changed(
    kb_app: Any, kb_client: httpx.AsyncClient,
) -> None:
    await kb_client.post("/kb/library", json={})
    read = (await kb_client.get("/kb/settings/wiki")).json()
    assert read["wiki_budget_characters"] == PROVISIONAL_BUDGET_CHARACTERS == 2_000_000
    saved = await kb_client.put("/kb/settings/wiki", json={"wiki_budget_characters": 1_500_000})
    assert saved.status_code == 200 and saved.json()["wiki_budget_characters"] == 1_500_000
    assert (await kb_client.put("/kb/settings/wiki", json={"wiki_budget_characters": 5})).status_code == 422
    # The profile choice is untouched by a budget change.
    assert saved.json()["wiki_engine"] == read["wiki_engine"]


async def test_reaching_the_budget_mid_answer_pauses_keeps_finished_sections_and_continue_resumes(
    kb_app: Any, kb_client: httpx.AsyncClient,
) -> None:
    runaway = ('{"sections": [' + section(ONE) + ", " + section(TWO) + ", "
               + section(("Длинный", [block("explanation", LONG)])) + '], "more": false}')
    rest = json.dumps({"sections": [json.loads(section(THREE))], "more": False}, ensure_ascii=False)
    world = await _world(kb_app, kb_client, budget=50_000,
                         notes_answers=[[*chunks(runaway), Completed("")], [*chunks(rest), Completed("")]])
    paused = await _ingest(world, kb_client)
    assert paused["state"] == "paused", paused["error"]
    assert paused["error_code"] == "BUDGET_REACHED"
    assert paused["label"] == "Paused · budget reached"
    assert "50K characters" in paused["error"]
    assert paused["can_retry"] is False
    # Nothing unfinished is published; the job journal says what is kept.
    assert not _notes_page(world).exists()
    journal = " ".join(entry["message"] for entry in paused["journal"])
    assert "2 finished sections are kept" in journal
    # The stopped answer is charged for what it streamed, not as zero.
    usage = paused["execution"]["usage"]
    assert 0 < usage["output_characters"] < len(runaway)
    wiki = await _material_wiki(world, kb_client)
    assert wiki["state"] == "paused" and wiki["error_code"] == "BUDGET_REACHED"

    # Continue: another budget portion; the kept sections are not generated again.
    done = await _ingest(world, kb_client)
    assert done["state"] == "done", done["error"]
    assert done["execution"]["root_job_id"] == done["id"]
    resumed = world.turns(prompts.NOTES_SCHEMA_TITLE)[-1]
    kept = json.loads(resumed.messages[1].content)
    assert [s["title"] for s in kept["sections"]] == ["Энтропия", "Температура"] and kept["more"] is True
    assert len(world.turns(prompts.NOTES_SCHEMA_TITLE)) == 2
    assert _headings(world) == ["Энтропия", "Температура", "Рост энтропии"]
    assert (await _material_wiki(world, kb_client))["state"] == "in_wiki"


async def test_a_step_is_never_sent_once_the_budget_is_spent_and_continue_does_not_pay_for_done_parts(
    kb_app: Any, kb_client: httpx.AsyncClient,
) -> None:
    long_notes = notes(ONE, ("Пояснение", [block("explanation", LONG)]))
    world = await _world(kb_app, kb_client, budget=50_000, notes_answers=[whole(long_notes)])
    paused = await _ingest(world, kb_client)
    assert paused["state"] == "paused", paused["error"]
    assert world.turns(prompts.CONCEPTS_SCHEMA_TITLE) == []  # refused before it was sent
    done = await _ingest(world, kb_client)
    assert done["state"] == "done", done["error"]
    assert len(world.turns(prompts.NOTES_SCHEMA_TITLE)) == 1  # the finished notes come from the checkpoint
    assert done["execution"]["usage"]["cache_hits"] >= 1


async def test_a_budget_smaller_than_one_request_fails_with_a_way_out_instead_of_pausing_forever(
    kb_app: Any, kb_client: httpx.AsyncClient,
) -> None:
    world = await _world(kb_app, kb_client, notes_answers=[whole(NOTES_OK)])
    # Below the API minimum, as a value stored directly could be.
    world.runtime.kb.settings.set(WIKI_BUDGET, 1_000)
    failed = await _ingest(world, kb_client)
    assert failed["state"] == "failed"
    assert "Wiki budget per material" in failed["error"] and "Settings → Models" in failed["error"]
    assert world.turns(prompts.NOTES_SCHEMA_TITLE) == []


async def test_follow_up_work_over_the_budget_pauses_the_material_and_continue_runs_only_that_work(
    kb_app: Any, kb_client: httpx.AsyncClient,
) -> None:
    heavy = concepts(concept("Энтропия", "entropy", [
        block("from_source", "Мера беспорядка системы.", cite(1, "Энтропия — это мера беспорядка системы.")),
        block("explanation", LONG),
    ]))
    world = await _world(kb_app, kb_client, budget=50_000, notes_answers=[whole(NOTES_OK)],
                         concepts_answers=[whole(heavy)])
    done = await _ingest(world, kb_client)
    assert done["state"] == "done", done["error"]
    assert _notes_page(world).exists()
    jobs = (await kb_client.get("/kb/jobs")).json()
    follow_ups = [job for job in jobs if job["kind"] in ("folder_overview", "connections")]
    paused = [job for job in follow_ups if job["state"] == "paused"]
    assert paused, [(job["kind"], job["state"], job["error"]) for job in follow_ups]
    assert all(job["error_code"] == "BUDGET_REACHED" for job in paused)
    assert all(job["execution"]["root_job_id"] == done["id"] for job in paused)
    wiki = await _material_wiki(world, kb_client)
    assert wiki["state"] == "paused"

    turns_before = len(world.engine.turns)
    response = await kb_client.post(f"/kb/materials/{world.material_id}/ingest")
    assert response.status_code == 202, response.text
    continued = response.json()
    assert continued["kind"] in {job["kind"] for job in paused}
    await _settled(world)
    # Only the paused follow-up work ran again: no new Notes or Concepts answers.
    new_titles = {str(turn.response_schema["title"]) for turn in world.engine.turns[turns_before:]
                  if turn.response_schema is not None}
    assert not new_titles & {prompts.NOTES_SCHEMA_TITLE, prompts.CONCEPTS_SCHEMA_TITLE}
    assert (await _material_wiki(world, kb_client))["state"] == "in_wiki"
