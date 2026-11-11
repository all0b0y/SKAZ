"""WR6 at the scripted engine seam: explicit Notes, durable scope, no sleeps."""
from __future__ import annotations

import sqlite3
from typing import Any

import httpx
import pytest

from skaz.knowledge.agents.engine import AgentTurn, Failed
from skaz.knowledge.agents.fake import FakeEngine, ScriptItem
from skaz.knowledge.ingest import prompts
from skaz.knowledge.ingest.service import IngestBusy, IngestService
from skaz.knowledge.service import KnowledgeService
from skaz.knowledge.store.schema import ingest as ingest_schema

from .ingest_support import PatternDetector, ScriptedWiki, add_material
from .test_ingest_pipeline import CONCEPTS_OK, NOTES_OK
from .test_wr5_engine_queue import drain


@pytest.fixture
def kb(ready: KnowledgeService) -> KnowledgeService:
    return ready


def make_ingest(kb: KnowledgeService, wiki: ScriptedWiki) -> IngestService:
    return IngestService(kb, engines=lambda _: wiki.engine, detector=PatternDetector())


def concept_bytes(kb: KnowledgeService) -> dict[str, bytes]:
    return {p.id: (kb.library_root / p.rel_path).read_bytes() for p in kb.pages(kind="concept")}


async def seed(kb: KnowledgeService) -> tuple[IngestService, ScriptedWiki, str]:
    wiki = ScriptedWiki(concepts=[CONCEPTS_OK])
    ingest = make_ingest(kb, wiki)
    material = add_material(kb, "WR6", "Lecture", kind="recording")
    job = await ingest.request_ingest(material)
    await drain(ingest)
    assert ingest.job(job.id).state == "done", ingest.job(job.id).error
    return ingest, wiki, material


def test_upgrade_keeps_old_jobs_full() -> None:
    connection = sqlite3.connect(":memory:")
    connection.executescript("CREATE TABLE ingest_jobs(job_id TEXT PRIMARY KEY, counters TEXT, "
                             "journal TEXT, error_code TEXT); INSERT INTO ingest_jobs(job_id) VALUES('old');")
    connection.executescript(ingest_schema.UPGRADES[3])
    assert connection.execute("SELECT scope FROM ingest_jobs").fetchone() == ("full",)
    assert ingest_schema.VERSION == 3


async def test_default_off_calls_only_concepts_and_material_is_in_wiki(kb: KnowledgeService) -> None:
    ingest, wiki, material = await seed(kb)
    assert ingest.settings().write_notes_automatically is False
    assert not wiki.turns(prompts.NOTES_SCHEMA_TITLE)
    assert len(wiki.turns(prompts.CONCEPTS_SCHEMA_TITLE)) == 1
    assert not kb.pages(kind="note")
    from skaz.knowledge.sources.material_info import wiki_states
    state = wiki_states(kb.db, [material])[material]
    assert state.state == "in_wiki" and state.note_page_id is None and state.concept_count == 2
    log = (kb.library_root / "Wiki/log.md").read_text()
    assert "Notes written" not in log and "Notes rewritten" not in log
    await ingest.close()


async def test_no_concept_statement_is_an_honest_failure_when_notes_off(kb: KnowledgeService) -> None:
    wiki = ScriptedWiki(notes=[NOTES_OK])
    ingest = make_ingest(kb, wiki)
    material = add_material(kb, "WR6", "Empty concepts", kind="pdf")
    job = await ingest.request_ingest(material)
    await drain(ingest)
    assert ingest.job(job.id).state == "failed"
    assert "No concept statement passed the source check" in (ingest.job(job.id).error or "")
    assert not wiki.turns(prompts.NOTES_SCHEMA_TITLE)
    assert not kb.pages()
    await ingest.close()


async def test_opt_in_writes_notes_and_off_keeps_existing_notes(kb: KnowledgeService) -> None:
    wiki = ScriptedWiki(notes=[NOTES_OK], concepts=[CONCEPTS_OK, CONCEPTS_OK])
    ingest = make_ingest(kb, wiki)
    ingest.update_settings(write_notes_automatically=True)
    material = add_material(kb, "WR6", "Opt in", kind="pdf")
    first = await ingest.request_ingest(material)
    await drain(ingest)
    assert ingest.job(first.id).state == "done"
    page = kb.pages(kind="note")[0]
    before = (kb.library_root / page.rel_path).read_bytes()
    ingest.update_settings(write_notes_automatically=False)
    second = await ingest.request_ingest(material)
    await drain(ingest)
    assert ingest.job(second.id).state == "done"
    assert (kb.library_root / page.rel_path).read_bytes() == before
    assert len(wiki.turns(prompts.NOTES_SCHEMA_TITLE)) == 1
    await ingest.close()


async def test_write_notes_only_preserves_concepts_and_skips_recognition_and_followups(kb: KnowledgeService) -> None:
    ingest, wiki, material = await seed(kb)
    before = concept_bytes(kb)
    wiki.queues[prompts.NOTES_SCHEMA_TITLE] = [NOTES_OK]
    wiki.engine.turns.clear()
    calls: list[str] = []
    ingest.finished_listeners.append(lambda mid, _: calls.append(mid))

    class Recognition:
        async def check(self, request: Any) -> bool:
            pytest.fail("Notes-only must not check recognition")

    ingest.recognition = Recognition()
    job = await ingest.request_notes(material)
    await drain(ingest)
    assert ingest.job(job.id).scope == "notes"
    assert ingest.job(job.id).state == "done", ingest.job(job.id).error
    assert [t.response_schema["title"] for t in wiki.engine.turns if t.response_schema] == [prompts.NOTES_SCHEMA_TITLE]
    assert concept_bytes(kb) == before
    assert len(kb.pages(kind="note")) == 1 and not calls
    note = (kb.library_root / kb.pages(kind="note")[0].rel_path).read_text()
    assert all(p.title in note for p in kb.pages(kind="concept"))
    with pytest.raises(IngestBusy):
        await ingest.request_notes(material)
    await ingest.close()


@pytest.mark.parametrize("restart", [False, True])
async def test_notes_quota_continue_retains_scope_and_budget(kb: KnowledgeService, restart: bool) -> None:
    ingest, _, material = await seed(kb)
    before = concept_bytes(kb)
    good = ScriptedWiki(notes=[NOTES_OK])
    first = True

    def answer(turn: AgentTurn) -> list[ScriptItem]:
        nonlocal first
        if first:
            first = False
            return [Failed("", "limit", "private quota detail")]
        return good._answer(turn)

    engine = FakeEngine("codex", script=answer)
    ingest.engines = lambda _: engine
    job = await ingest.request_notes(material)
    await drain(ingest)
    paused = ingest.job(job.id)
    assert paused.state == "paused" and paused.scope == "notes"
    assert paused.execution is not None
    if restart:
        await ingest.close()
        ingest = IngestService(kb, engines=lambda _: engine, detector=PatternDetector())
    continued = await ingest.continue_job(job.id)
    await drain(ingest)
    done = ingest.job(continued.id)
    assert done.state == "done" and done.scope == "notes", done.error
    assert done.execution is not None
    assert done.execution.root_job_id == paused.execution.root_job_id
    assert done.execution.budget_characters == paused.execution.budget_characters
    assert concept_bytes(kb) == before
    assert all(t.response_schema and t.response_schema["title"] == prompts.NOTES_SCHEMA_TITLE for t in engine.turns)
    await ingest.close()


async def test_retry_and_restart_recovery_keep_notes_scope(kb: KnowledgeService) -> None:
    ingest, wiki, material = await seed(kb)
    before = concept_bytes(kb)
    ingest.slots = lambda: 0  # type: ignore[method-assign]
    job = await ingest.request_notes(material)
    ingest.jobs.finish(job.id, "failed", error="Stopped fake")
    retry = await ingest.request_from_user(material)
    assert ingest.job(retry.id).scope == "notes"
    # Simulate a process leaving a running row. Startup must requeue it with its scope intact.
    ingest.jobs.queue_slots["codex"] = 1
    assert ingest.jobs.claim_next() is not None
    await ingest.close()
    wiki.queues[prompts.NOTES_SCHEMA_TITLE] = [NOTES_OK]
    wiki.engine.turns.clear()
    recovered = make_ingest(kb, wiki)
    recovered.resume()
    await drain(recovered)
    assert recovered.job(retry.id).state == "done"
    assert recovered.job(retry.id).scope == "notes"
    assert concept_bytes(kb) == before
    assert not wiki.turns(prompts.CONCEPTS_SCHEMA_TITLE)
    await recovered.close()


async def test_notes_http_and_settings_contract(kb_app: Any, kb_client: httpx.AsyncClient) -> None:
    await kb_client.post("/kb/library", json={})
    runtime = kb_app.state.runtime
    ingest = runtime.kb_ingest
    wiki = ScriptedWiki(notes=[NOTES_OK], concepts=[CONCEPTS_OK])
    ingest.engines = lambda _: wiki.engine
    ingest.detector = PatternDetector()
    assert (await kb_client.get("/kb/settings/wiki")).json()["write_notes_automatically"] is False
    updated = await kb_client.put("/kb/settings/wiki", json={"write_notes_automatically": True})
    assert updated.status_code == 200 and updated.json()["write_notes_automatically"] is True
    await kb_client.put("/kb/settings/wiki", json={"write_notes_automatically": False})
    material = add_material(runtime.kb, "WR6", "HTTP", kind="pdf")
    assert (await kb_client.post(f"/kb/materials/{material}/notes")).status_code == 409
    initial = await ingest.request_ingest(material)
    await drain(ingest)
    assert ingest.job(initial.id).state == "done"
    response = await kb_client.post(f"/kb/materials/{material}/notes")
    assert response.status_code == 202
    await drain(ingest)
    assert ingest.job(response.json()["id"]).scope == "notes"
    assert ingest.job(response.json()["id"]).state == "done"
    assert (await kb_client.post(f"/kb/materials/{material}/notes")).status_code == 409
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=kb_app), base_url="http://test") as client:
        assert (await client.post(f"/kb/materials/{material}/notes")).status_code == 401
