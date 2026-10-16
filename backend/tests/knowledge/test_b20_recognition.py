"""Settings → Models → Recognition check and "Check recognition again" (decision B20).

``FakeEngine`` scripts the agents (``ScriptedWiki``): this proves which agent, model and effort
the check uses, that Off skips it honestly and that the re-check job behaves — not a model's
judgement of what was said.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from skaz.knowledge.agents.fake import FakeEngine
from skaz.knowledge.corrections.check import OFF_LINE
from skaz.knowledge.service import KnowledgeService
from skaz.knowledge.wiki.service import AgentNotReady

from .ingest_support import ScriptedWiki, add_material, wait_finished
from .test_corrections import CHECK, CONCEPTS, NOTES, SPEECH, decide
from .wiki_support import RECOGNITION, correction, corrections, ingest_done, settle_wiki, wired


def journal(ingest: Any, job_id: str) -> str:
    return " ".join(entry.message for entry in ingest.job(job_id).journal)


async def test_off_skips_the_check_and_says_so(ready: KnowledgeService) -> None:
    material_id = add_material(ready, "Физика", "Лекция 8", SPEECH)
    wiki = ScriptedWiki(notes=[NOTES], concepts=[CONCEPTS], answers={RECOGNITION: [CHECK]})
    ingest, service = wired(ready, wiki, decide)
    service.update_recognition(engine="off", model=None, effort=None)
    job_id = await ingest_done(ingest, material_id)
    assert wiki.turns(RECOGNITION) == []
    assert OFF_LINE in journal(ingest, job_id)
    # Not marked as checked: turning it on later and "Check recognition again" still work.
    assert not service.store.path(material_id).exists()


async def test_a_chosen_agent_checks_with_its_model_and_effort(ready: KnowledgeService) -> None:
    material_id = add_material(ready, "Физика", "Лекция 8", SPEECH)
    wiki = ScriptedWiki(notes=[NOTES], concepts=[CONCEPTS])
    checker = ScriptedWiki(answers={RECOGNITION: [CHECK]})
    checker.engine = FakeEngine("claude_code", script=checker._answer)
    ingest, service = wired(ready, wiki, decide)
    ingest.engines = lambda engine_id: checker.engine if engine_id == "claude_code" else wiki.engine
    service.update_recognition(engine="claude_code", model="claude-sonnet-5", effort="low")
    await ingest_done(ingest, material_id)
    await settle_wiki(service, ingest)

    assert wiki.turns(RECOGNITION) == []  # the wiki's agent wrote the notes, not the check
    [turn] = checker.turns(RECOGNITION)
    assert (turn.model, turn.effort, turn.tools) == ("claude-sonnet-5", "low", None)
    states = {entry.before: entry.state for entry in service.store.read_or_empty(material_id).corrections}
    assert states == {"Энтропея": "applied", "кинетическую": "doubtful"}


async def test_a_chosen_agent_that_is_missing_is_never_replaced(ready: KnowledgeService) -> None:
    material_id = add_material(ready, "Физика", "Лекция 8", SPEECH)
    wiki = ScriptedWiki(notes=[NOTES], concepts=[CONCEPTS], answers={RECOGNITION: [CHECK]})
    ingest, service = wired(ready, wiki, decide)
    ingest.engines = lambda engine_id: None if engine_id == "hermes" else wiki.engine
    service.update_recognition(engine="hermes", model=None, effort=None)
    job_id = await ingest_done(ingest, material_id)
    assert wiki.turns(RECOGNITION) == []
    assert "The recognition check was skipped: Hermes Agent" in journal(ingest, job_id)


def test_settings_rules(ready: KnowledgeService) -> None:
    wiki = ScriptedWiki()
    _ingest, service = wired(ready, wiki)
    assert service.recognition_settings().engine == "same_as_wiki"
    chosen = service.update_recognition(engine="codex", model="gpt-5.5", effort="high")
    assert (chosen.engine, chosen.model, chosen.effort) == ("codex", "gpt-5.5", "high")
    with pytest.raises(Exception, match="Choose an agent first"):
        service.update_recognition(engine="same_as_wiki", model="gpt-5.5", effort=None)
    with pytest.raises(Exception, match="Unknown choice"):
        service.update_recognition(engine="gemini", model=None, effort=None)
    with pytest.raises(Exception, match="Unknown model"):
        service.update_recognition(engine="codex", model="bad name; rm", effort=None)
    back = service.update_recognition(engine="same_as_wiki", model=None, effort=None)
    assert (back.engine, back.model, back.effort) == ("same_as_wiki", None, None)


async def test_check_recognition_again_runs_on_demand_and_refreshes_the_wiki(ready: KnowledgeService) -> None:
    material_id = add_material(ready, "Физика", "Лекция 8", SPEECH)
    second = corrections(correction(2, "кинетическую", "кинетичную"), correction(1, "Энтропея", "Энтропия"))
    wiki = ScriptedWiki(
        notes=[NOTES, NOTES], concepts=[CONCEPTS, CONCEPTS],
        answers={RECOGNITION: [json.dumps({"corrections": []}), second]},
    )
    ingest, service = wired(ready, wiki, lambda _q: decide_all(_q))
    await ingest_done(ingest, material_id)
    await settle_wiki(service, ingest)
    assert service.store.read_or_empty(material_id).corrections == []

    job = await service.check_recognition_again(material_id)
    assert job.kind == "corrections" and job.material_id == material_id and job.step == "checking_recognition"
    await service.jobs.wait(job.id)
    finished = ingest.job(job.id)
    assert finished.state == "done", finished.error
    assert len(wiki.turns(RECOGNITION)) == 2
    states = {entry.before: entry.state for entry in service.store.read_or_empty(material_id).corrections}
    assert states == {"Энтропея": "applied", "кинетическую": "applied"}
    # The Notes quoted "среднюю кинетическую энергию": that statement was taken down, a refresh started.
    assert "taken down" in journal(ingest, job.id)
    refresh = [item for item in ingest.list_jobs(material_id=material_id) if item.kind == "refresh"]
    assert refresh
    await wait_finished(ingest, refresh[0].id)


def decide_all(_question: Any) -> Any:
    from skaz.knowledge.decisions.protocol import YesNoAnswer

    return YesNoAnswer(0.95)


async def test_check_recognition_again_refuses_honestly(ready: KnowledgeService) -> None:
    speech_id = add_material(ready, "Физика", "Лекция 8", SPEECH)
    text_id = add_material(ready, "Физика", "Статья", SPEECH, kind="text")
    wiki = ScriptedWiki()
    ingest, service = wired(ready, wiki)
    with pytest.raises(Exception, match="Only recordings"):
        await service.check_recognition_again(text_id)
    service.update_recognition(engine="off", model=None, effort=None)
    with pytest.raises(Exception, match="is off"):
        await service.check_recognition_again(speech_id)
    service.update_recognition(engine="hermes", model=None, effort=None)
    ingest.engines = lambda engine_id: None if engine_id == "hermes" else wiki.engine
    with pytest.raises(AgentNotReady, match="needs a connected agent"):
        await service.check_recognition_again(speech_id)
    assert not [job for job in ingest.list_jobs(material_id=speech_id) if job.kind == "corrections"]


async def test_recognition_settings_and_recheck_over_http(kb_app: Any, kb_client: httpx.AsyncClient) -> None:
    await kb_client.post("/kb/library", json={})
    assert (await kb_client.get("/kb/settings/recognition")).json() == {
        "engine": "same_as_wiki", "model": None, "effort": None,
    }
    chosen = {"engine": "codex", "model": "gpt-5.5", "effort": "high"}
    put = await kb_client.put("/kb/settings/recognition", json=chosen)
    assert put.status_code == 200 and put.json() == {"engine": "codex", "model": "gpt-5.5", "effort": "high"}
    bad = await kb_client.put("/kb/settings/recognition", json={"engine": "off", "model": "gpt-5.5"})
    assert bad.status_code == 422
    assert (await kb_client.put("/kb/settings/recognition", json={"engine": "nope"})).status_code == 422

    runtime = kb_app.state.runtime
    material_id = add_material(runtime.kb, "Физика", "Лекция 8", SPEECH)
    await kb_client.put("/kb/settings/recognition", json={"engine": "off"})
    refused = await kb_client.post(f"/kb/materials/{material_id}/recognition-check")
    assert refused.status_code == 409 and "off" in refused.json()["detail"]
    await kb_client.put("/kb/settings/recognition", json={"engine": "same_as_wiki"})
    wiki = ScriptedWiki(answers={RECOGNITION: [CHECK]})
    wired(runtime.kb, wiki, decide, runtime)
    started = await kb_client.post(f"/kb/materials/{material_id}/recognition-check")
    assert started.status_code == 202, started.text
    body = started.json()
    assert body["kind"] == "corrections" and body["material_id"] == material_id
    await runtime.kb_wiki.jobs.wait(body["id"])
    done = (await kb_client.get(f"/kb/jobs/{body['id']}")).json()
    assert done["state"] == "done", done
    assert (await kb_client.post("/kb/materials/mat-missing/recognition-check")).status_code == 404
