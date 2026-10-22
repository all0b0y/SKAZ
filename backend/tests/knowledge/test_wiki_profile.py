"""Wiki's model selection through its public HTTP interface; never a real model call."""
from __future__ import annotations

import asyncio
from typing import Any

import httpx
import pytest

from skaz.knowledge.agents.engine import ModelOption, Usage
from skaz.knowledge.ingest import prompts
from tests.knowledge.ingest_support import PatternDetector, ScriptedWiki, add_material, settle
from tests.knowledge.test_ingest_pipeline import CONCEPTS_OK, NOTES_OK


async def test_wiki_has_its_own_persisted_model_and_reasoning(kb_client: httpx.AsyncClient) -> None:
    response = await kb_client.put("/kb/settings/wiki", json={
        "wiki_engine": "codex", "wiki_model": "test-wiki-model", "wiki_effort": "high",
    })
    assert response.status_code == 200, response.text
    selected = response.json()
    assert (selected["wiki_engine"], selected["wiki_model"], selected["wiki_effort"]) == (
        "codex", "test-wiki-model", "high",
    )
    changed = await kb_client.put("/kb/settings/wiki", json={"wiki_language": "ru"})
    assert changed.status_code == 200
    saved = (await kb_client.get("/kb/settings/wiki")).json()
    assert saved["wiki_model"] == "test-wiki-model" and saved["wiki_effort"] == "high"


async def test_ingest_pins_wiki_profile_instead_of_following_a_later_setting(
    kb_app: Any, kb_client: httpx.AsyncClient,
) -> None:
    await kb_client.post("/kb/library", json={})
    runtime = kb_app.state.runtime
    gate = asyncio.Event()
    wiki = ScriptedWiki(notes=[NOTES_OK], concepts=[CONCEPTS_OK], gate=gate,
                        models=[ModelOption("profile-model", "Profile model", ("low", "high"), "low")])
    runtime.kb_ingest.engines = lambda _engine: wiki.engine
    runtime.kb_ingest.detector = PatternDetector()
    await kb_client.put("/kb/settings/wiki", json={
        "wiki_engine": "codex", "wiki_model": "profile-model", "wiki_effort": "high",
    })
    material_id = add_material(runtime.kb, "Physics", "Profile test", kind="pdf")
    started = await kb_client.post(f"/kb/materials/{material_id}/ingest")
    assert started.status_code == 202
    await settle(lambda: bool(wiki.engine.active_runs()))
    # The already running operation must not switch model half way through.
    await kb_client.put("/kb/settings/wiki", json={"wiki_model": "next-model", "wiki_effort": "low"})
    gate.set()
    await settle(lambda: not runtime.kb_ingest.active_jobs())
    job = (await kb_client.get(f"/kb/jobs/{started.json()['id']}")).json()
    assert job["state"] == "done", job["error"]
    turns = wiki.turns(prompts.NOTES_SCHEMA_TITLE) + wiki.turns(prompts.CONCEPTS_SCHEMA_TITLE)
    assert len(turns) == 2
    assert {(turn.model, turn.effort) for turn in turns} == {("profile-model", "high")}
    execution = job["execution"]
    assert execution["profile"] == {
        "engine": "codex", "model": "profile-model", "effort": "high", "language": "en",
    }
    assert execution["usage"]["calls"] == 2
    assert execution["usage"]["unknown_usage_calls"] == 2
    assert execution["usage"]["input_tokens"] is None  # unknown is never reported as free
    assert execution["usage"]["output_tokens"] is None
    assert execution["usage"]["instruction_characters"] > 0
    assert "Энтропия" not in str(execution)  # aggregate metadata, never material text
    await settle(lambda: not runtime.kb_wiki.busy)
    assert all((turn.model, turn.effort) == ("profile-model", "high") for turn in wiki.engine.turns)
    followups = [item for item in (await kb_client.get("/kb/jobs")).json()
                 if item["kind"] in ("connections", "folder_overview")]
    assert followups
    assert all(item["execution"]["root_job_id"] == job["id"] for item in followups)


async def test_each_wiki_agent_gets_back_its_last_model_and_reasoning(
    kb_client: httpx.AsyncClient,
) -> None:
    """Models screen v2 (2026-10-20): switching the wiki agent restores what was chosen for it last."""
    await kb_client.put("/kb/settings/wiki", json={
        "wiki_engine": "codex", "wiki_model": "one-model", "wiki_effort": "high",
    })
    claude = (await kb_client.put("/kb/settings/wiki", json={"wiki_engine": "claude_code"})).json()
    assert claude["wiki_model"] is None and claude["wiki_effort"] is None  # nothing chosen for it yet
    await kb_client.put("/kb/settings/wiki", json={"wiki_model": "opus", "wiki_effort": "low"})
    back = (await kb_client.put("/kb/settings/wiki", json={"wiki_engine": "codex"})).json()
    assert (back["wiki_model"], back["wiki_effort"]) == ("one-model", "high")
    assert back["wiki_remembered"] == {
        "codex": {"model": "one-model", "effort": "high"}, "claude_code": {"model": "opus", "effort": "low"},
    }
    again = (await kb_client.put("/kb/settings/wiki", json={"wiki_engine": "claude_code"})).json()
    assert (again["wiki_model"], again["wiki_effort"]) == ("opus", "low")
    # An explicit model with the agent wins over the memory; reasoning without a model is still refused.
    picked = (await kb_client.put("/kb/settings/wiki", json={
        "wiki_engine": "codex", "wiki_model": "two-model", "wiki_effort": None,
    })).json()
    assert (picked["wiki_model"], picked["wiki_effort"]) == ("two-model", None)
    await kb_client.put("/kb/settings/wiki", json={"wiki_engine": None})
    bad = await kb_client.put("/kb/settings/wiki", json={"wiki_effort": "high"})
    assert bad.status_code == 422
    saved = (await kb_client.get("/kb/settings/wiki")).json()
    assert saved["wiki_engine"] is None and saved["wiki_model"] is None
    assert saved["wiki_remembered"]["codex"] == {"model": "two-model", "effort": None}


async def test_model_ids_are_not_silently_trimmed(kb_client: httpx.AsyncClient) -> None:
    invalid = await kb_client.put("/kb/settings/wiki", json={
        "wiki_engine": "codex", "wiki_model": " model-with-leading-space", "wiki_effort": "high",
    })
    assert invalid.status_code == 422
    saved = (await kb_client.get("/kb/settings/wiki")).json()
    assert saved["wiki_model"] is None


@pytest.mark.parametrize(("model", "effort"), [("missing-model", "high"), ("profile-model", "maximum")])
async def test_unavailable_wiki_selection_never_calls_a_substitute_model(
    kb_app: Any, kb_client: httpx.AsyncClient, model: str, effort: str,
) -> None:
    await kb_client.post("/kb/library", json={})
    runtime = kb_app.state.runtime
    wiki = ScriptedWiki(notes=[NOTES_OK], concepts=[CONCEPTS_OK],
                        models=[ModelOption("profile-model", "Profile model", ("low", "high"), "low")])
    runtime.kb_ingest.engines = lambda _engine: wiki.engine
    runtime.kb_ingest.detector = PatternDetector()
    await kb_client.put("/kb/settings/wiki", json={
        "wiki_engine": "codex", "wiki_model": model, "wiki_effort": effort,
    })
    material_id = add_material(runtime.kb, "Physics", "Unavailable profile", kind="pdf")
    response = await kb_client.post(f"/kb/materials/{material_id}/ingest")
    await settle(lambda: not runtime.kb_ingest.active_jobs())
    job = (await kb_client.get(f"/kb/jobs/{response.json()['id']}")).json()
    assert job["state"] == "failed"
    assert job["error_code"] == "AGENT_UNAVAILABLE"
    assert wiki.engine.turns == []
    assert job["execution"]["usage"]["calls"] == 0


async def test_provider_reported_usage_is_accounted_without_saving_source_text(
    kb_app: Any, kb_client: httpx.AsyncClient,
) -> None:
    await kb_client.post("/kb/library", json={})
    runtime = kb_app.state.runtime
    wiki = ScriptedWiki(notes=[NOTES_OK], concepts=[CONCEPTS_OK], usage=Usage(10, 5))
    runtime.kb_ingest.engines = lambda _engine: wiki.engine
    runtime.kb_ingest.detector = PatternDetector()
    material_id = add_material(runtime.kb, "Physics", "Usage test", kind="pdf")
    response = await kb_client.post(f"/kb/materials/{material_id}/ingest")
    await settle(lambda: not runtime.kb_ingest.active_jobs())
    execution = (await kb_client.get(f"/kb/jobs/{response.json()['id']}")).json()["execution"]
    assert execution["usage"]["calls"] == 2
    assert execution["usage"]["input_tokens"] == 20
    assert execution["usage"]["output_tokens"] == 10
    assert execution["usage"]["unknown_usage_calls"] == 0
    assert len(execution["stages"]) == 2
    assert execution["observed_model"] is None  # the fake reports usage, not an actual model id


async def test_a_queued_material_keeps_the_profile_selected_when_it_was_queued(
    kb_app: Any, kb_client: httpx.AsyncClient,
) -> None:
    await kb_client.post("/kb/library", json={})
    runtime = kb_app.state.runtime
    gate = asyncio.Event()
    wiki = ScriptedWiki(notes=[NOTES_OK] * 5, concepts=[CONCEPTS_OK] * 5, gate=gate,
                        models=[ModelOption("queue-model", "Queue model", ("low", "high"), "low")])
    runtime.kb_ingest.engines = lambda _engine: wiki.engine
    runtime.kb_ingest.detector = PatternDetector()
    await kb_client.put("/kb/settings/wiki", json={
        "wiki_engine": "codex", "wiki_model": "queue-model", "wiki_effort": "high",
    })
    ids = [add_material(runtime.kb, "Physics", f"Queued material {index}", kind="pdf") for index in range(5)]
    queued = None
    try:
        for material_id in ids:
            response = await kb_client.post(f"/kb/materials/{material_id}/ingest")
            assert response.status_code == 202
            queued = response.json()
        assert queued is not None and queued["state"] == "queued"
        assert queued["execution"]["profile"]["model"] == "queue-model"
        await kb_client.put("/kb/settings/wiki", json={"wiki_model": "new-setting", "wiki_effort": "low"})
    finally:
        gate.set()
    await settle(lambda: not runtime.kb_ingest.active_jobs())
    done = (await kb_client.get(f"/kb/jobs/{queued['id']}")).json()
    assert done["state"] == "done", done["error"]
    assert done["execution"]["profile"]["model"] == "queue-model"
    assert all((turn.model, turn.effort) == ("queue-model", "high") for turn in wiki.engine.turns)
