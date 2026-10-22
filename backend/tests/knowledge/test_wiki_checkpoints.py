"""Checkpoint reuse through HTTP and the external model seam, with authored model events only."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import httpx

from skaz.knowledge.agents.engine import AgentTurn, Completed, Failed, ModelOption, TextDelta
from skaz.knowledge.agents.fake import FakeEngine, ScriptItem
from skaz.knowledge.ingest import prompts
from tests.knowledge.ingest_support import W2_EMPTY_ANSWERS, PatternDetector, add_material, settle
from tests.knowledge.test_ingest_pipeline import CONCEPTS_OK, NOTES_OK


@dataclass
class Case:
    runtime: Any
    engine: FakeEngine
    material_id: str

    def notes_turns(self) -> list[AgentTurn]:
        return [turn for turn in self.engine.turns if turn.response_schema is not None
                and turn.response_schema["title"] == prompts.NOTES_SCHEMA_TITLE]

    def checkpoint_rows(self) -> tuple[int, int]:
        with self.runtime.kb.db.read() as connection:
            heads = connection.execute("SELECT COUNT(*) FROM wiki_checkpoints WHERE material_id=?",
                                       (self.material_id,)).fetchone()[0]
            answers = connection.execute("SELECT COUNT(*) FROM wiki_checkpoint_answers WHERE material_id=?",
                                         (self.material_id,)).fetchone()[0]
        return int(heads), int(answers)


async def _failed_once(kb_app: Any, kb_client: httpx.AsyncClient, profile: dict[str, Any]) -> Case:
    """The first ingest fails on Concepts with a model limit; Notes were already answered."""
    await kb_client.post("/kb/library", json={})
    runtime = kb_app.state.runtime
    concept_attempts = 0

    def answer(turn: AgentTurn) -> list[ScriptItem]:
        nonlocal concept_attempts
        assert turn.response_schema is not None
        title = turn.response_schema["title"]
        if title == prompts.CONCEPTS_SCHEMA_TITLE:
            concept_attempts += 1
            if concept_attempts == 1:
                return [Failed("", "limit", "Authored fixture: this turn reached a model limit.")]
            result = CONCEPTS_OK
        elif title == prompts.NOTES_SCHEMA_TITLE:
            result = NOTES_OK
        else:
            result = W2_EMPTY_ANSWERS.get(str(title), '{"choice":0}')
        return [TextDelta("", result), Completed("")]

    engine = FakeEngine("codex", script=answer,
                        models=[ModelOption("checkpoint-model", "Checkpoint model", ("low", "high"), "low")])
    runtime.kb_ingest.engines = lambda _engine: engine
    runtime.kb_ingest.detector = PatternDetector()
    saved = await kb_client.put("/kb/settings/wiki", json={"wiki_engine": "codex", **profile})
    assert saved.status_code == 200, saved.text
    material_id = add_material(runtime.kb, "Physics", "Checkpoint material", kind="pdf")
    first = (await kb_client.post(f"/kb/materials/{material_id}/ingest")).json()
    await settle(lambda: not runtime.kb_ingest.active_jobs())
    assert (await kb_client.get(f"/kb/jobs/{first['id']}")).json()["state"] == "failed"
    return Case(runtime, engine, material_id)


async def _retry(case: Case, kb_client: httpx.AsyncClient) -> dict[str, Any]:
    retry = (await kb_client.post(f"/kb/materials/{case.material_id}/ingest")).json()
    await settle(lambda: not case.runtime.kb_ingest.active_jobs())
    done: dict[str, Any] = (await kb_client.get(f"/kb/jobs/{retry['id']}")).json()
    assert done["state"] == "done", done["error"]
    return done


async def test_retry_reuses_the_finished_notes_after_the_concept_model_hit_a_limit(
    kb_app: Any, kb_client: httpx.AsyncClient,
) -> None:
    case = await _failed_once(kb_app, kb_client, {"wiki_model": "checkpoint-model", "wiki_effort": "low"})
    done = await _retry(case, kb_client)
    assert len(case.notes_turns()) == 1  # the ready notes are not generated again on Retry
    assert done["execution"]["usage"]["cache_hits"] == 1
    assert done["execution"]["usage"]["calls"] == 1


async def test_another_reasoning_level_after_a_stop_keeps_the_finished_notes_and_says_who_wrote_them(
    kb_app: Any, kb_client: httpx.AsyncClient,
) -> None:
    # User decision 2026-10-20 (C1-f, item 4): after the model stopped, another choice continues
    # from the finished work instead of starting the material over.
    case = await _failed_once(kb_app, kb_client, {"wiki_model": "checkpoint-model", "wiki_effort": "low"})
    await kb_client.put("/kb/settings/wiki", json={"wiki_effort": "high"})
    done = await _retry(case, kb_client)
    assert len(case.notes_turns()) == 1  # the finished notes are kept
    assert done["execution"]["usage"]["cache_hits"] == 1
    concepts = [turn for turn in case.engine.turns if turn.response_schema is not None
                and turn.response_schema["title"] == prompts.CONCEPTS_SCHEMA_TITLE]
    assert concepts[-1].effort == "high"  # the rest is written by the new choice
    journal = " ".join(entry["message"] for entry in done["journal"])
    assert "written by Codex · checkpoint-model · low" in journal
    assert "continues with Codex · checkpoint-model · high" in journal


async def test_a_finished_material_added_again_with_another_reasoning_level_starts_over(
    kb_app: Any, kb_client: httpx.AsyncClient,
) -> None:
    case = await _failed_once(kb_app, kb_client, {"wiki_model": "checkpoint-model", "wiki_effort": "low"})
    await _retry(case, kb_client)
    await kb_client.put("/kb/settings/wiki", json={"wiki_effort": "high"})
    again = await _retry(case, kb_client)
    assert len(case.notes_turns()) == 2
    assert again["execution"]["usage"]["cache_hits"] == 0
    assert case.notes_turns()[1].effort == "high"


async def test_the_same_choice_added_again_after_it_finished_reuses_its_answers(
    kb_app: Any, kb_client: httpx.AsyncClient,
) -> None:
    case = await _failed_once(kb_app, kb_client, {"wiki_model": "checkpoint-model", "wiki_effort": "low"})
    await _retry(case, kb_client)
    again = await _retry(case, kb_client)
    assert len(case.notes_turns()) == 1
    assert again["execution"]["usage"]["cache_hits"] == 2  # Notes and Concepts, nothing paid again


async def test_the_agents_default_model_is_never_cached(kb_app: Any, kb_client: httpx.AsyncClient) -> None:
    case = await _failed_once(kb_app, kb_client, {})
    done = await _retry(case, kb_client)
    assert len(case.notes_turns()) == 2  # the default may change without SKAZ knowing
    assert done["execution"]["usage"]["cache_hits"] == 0
    assert case.checkpoint_rows() == (0, 0)


async def test_deleting_the_material_deletes_its_saved_answers(
    kb_app: Any, kb_client: httpx.AsyncClient,
) -> None:
    case = await _failed_once(kb_app, kb_client, {"wiki_model": "checkpoint-model", "wiki_effort": "low"})
    heads, answers = case.checkpoint_rows()
    assert heads == 1 and answers >= 1
    deleted = await kb_client.delete(f"/kb/materials/{case.material_id}")
    assert deleted.status_code in (200, 204), deleted.text
    assert case.checkpoint_rows() == (0, 0)
