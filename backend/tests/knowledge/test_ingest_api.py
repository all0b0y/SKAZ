"""``/kb/materials/{id}/ingest``, ``/kb/jobs``, ``/kb/settings/wiki`` over ASGI with the bearer token."""
from __future__ import annotations

import asyncio
from typing import Any

import httpx

from skaz.knowledge.ingest.service import IngestService
from tests.knowledge.ingest_support import PatternDetector, ScriptedWiki, add_material, settle
from tests.knowledge.test_ingest_pipeline import CONCEPTS_OK, NOTES_OK


async def test_ingest_routes_require_the_token(kb_app: Any) -> None:
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=kb_app),
                                 base_url="http://127.0.0.1:8765") as anonymous:
        assert (await anonymous.get("/kb/jobs")).status_code == 401
        assert (await anonymous.get("/kb/settings/wiki")).status_code == 401
        assert (await anonymous.post("/kb/materials/mat-x/ingest")).status_code == 401


async def test_wiki_settings_defaults_and_partial_updates(kb_client: httpx.AsyncClient) -> None:
    defaults = (await kb_client.get("/kb/settings/wiki")).json()
    assert defaults == {"wiki_language": "en", "wiki_language_chosen": False, "wiki_engine": None,
                        "wiki_model": None, "wiki_effort": None, "wiki_remembered": {},
                        "auto_add_files_links": True, "auto_add_text": False,
                        # W2: background connections need the user's permission; corrections are automatic.
                        "background_connections": False, "auto_corrections": True,
                        # C1-d: provisional until measured on the user's real run.
                        "wiki_budget_characters": 2_000_000}
    updated = (await kb_client.put("/kb/settings/wiki", json={"wiki_language": "ru",
                                                              "wiki_engine": "claude_code"})).json()
    assert updated["wiki_language"] == "ru" and updated["wiki_language_chosen"] is True
    assert updated["wiki_engine"] == "claude_code" and updated["auto_add_files_links"] is True
    cleared = (await kb_client.put("/kb/settings/wiki",
                                   json={"wiki_engine": None, "auto_add_text": True})).json()
    assert cleared["wiki_engine"] is None and cleared["auto_add_text"] is True
    assert cleared["wiki_language"] == "ru"
    assert (await kb_client.put("/kb/settings/wiki", json={"wiki_language": "русский"})).status_code == 422
    assert (await kb_client.put("/kb/settings/wiki", json={"wiki_engine": "gpt"})).status_code == 422
    assert (await kb_client.put("/kb/settings/wiki", json={"unknown": 1})).status_code == 422


async def test_ingest_job_lifecycle_over_http(kb_app: Any, kb_client: httpx.AsyncClient) -> None:
    await kb_client.post("/kb/library", json={})
    runtime = kb_app.state.runtime
    ingest: IngestService = runtime.kb_ingest
    material_id = add_material(runtime.kb, "Физика", "Лекция 8")

    # Before the engine registry and the detector are wired, the job fails with a plain reason.
    started = await kb_client.post(f"/kb/materials/{material_id}/ingest")
    assert started.status_code == 202 and started.json()["state"] in ("queued", "running")
    await settle(lambda: not ingest.active_jobs())
    failed = (await kb_client.get(f"/kb/jobs/{started.json()['id']}")).json()
    assert failed["state"] == "failed" and failed["can_retry"] is True and "Retry" not in failed["label"]
    # No agent connected: the failure says which kind of problem it is (G4), the material too.
    assert failed["error_code"] == "AGENT_UNAVAILABLE", failed["error"]
    wiki_view = (await kb_client.get(f"/kb/materials/{material_id}")).json()["wiki"]
    assert (wiki_view["state"], wiki_view["error_code"]) == ("failed", "AGENT_UNAVAILABLE")

    gate = asyncio.Event()
    wiki = ScriptedWiki(notes=[NOTES_OK], concepts=[CONCEPTS_OK], gate=gate)
    ingest.engines = lambda _engine_id: wiki.engine
    ingest.detector = PatternDetector()
    job = (await kb_client.post(f"/kb/materials/{material_id}/ingest")).json()
    await settle(lambda: bool(wiki.engine.active_runs()))
    busy = await kb_client.post(f"/kb/materials/{material_id}/ingest")
    assert busy.status_code == 409
    assert busy.json() == {"detail": "This material is already being added to the wiki."}
    running = (await kb_client.get(f"/kb/jobs/{job['id']}")).json()
    # W2: a recording's first agent turn is the recognition check, before the notes.
    assert running["label"] == "Checking recognition" and running["step"] == "checking_recognition"
    gate.set()
    await settle(lambda: not ingest.active_jobs())
    done = (await kb_client.get(f"/kb/jobs/{job['id']}")).json()
    assert done["state"] == "done" and done["label"] == "Done" and done["can_retry"] is False
    assert done["progress"]["concepts_created"] == 2 and done["progress"]["parts_total"] == 1
    assert done["journal"] and all(set(entry) == {"at", "message"} for entry in done["journal"])

    listed = (await kb_client.get("/kb/jobs", params={"material_id": material_id})).json()
    assert [item["id"] for item in listed] == [job["id"], started.json()["id"]]
    assert (await kb_client.get("/kb/jobs", params={"material_id": "mat-none"})).json() == []
    finished = await kb_client.post(f"/kb/jobs/{job['id']}/cancel")
    assert finished.status_code == 409
    assert (await kb_client.get("/kb/jobs/job-missing")).status_code == 404
    assert (await kb_client.post("/kb/jobs/job-missing/cancel")).status_code == 404
    assert (await kb_client.post("/kb/materials/mat-missing/ingest")).status_code == 404
    pages = (await kb_client.get("/kb/wiki/pages", params={"kind": "concept"})).json()
    assert sorted(page["title"] for page in pages) == ["Температура", "Энтропия (entropy)"]


async def test_cancel_over_http(kb_app: Any, kb_client: httpx.AsyncClient) -> None:
    await kb_client.post("/kb/library", json={})
    runtime = kb_app.state.runtime
    ingest: IngestService = runtime.kb_ingest
    wiki = ScriptedWiki(notes=[NOTES_OK], gate=asyncio.Event())
    ingest.engines = lambda _engine_id: wiki.engine
    ingest.detector = PatternDetector()
    material_id = add_material(runtime.kb, "Физика", "Лекция 8")
    job = (await kb_client.post(f"/kb/materials/{material_id}/ingest")).json()
    await settle(lambda: bool(wiki.engine.active_runs()))
    cancelled = (await kb_client.post(f"/kb/jobs/{job['id']}/cancel")).json()
    assert cancelled["state"] == "cancelled" and cancelled["label"] == "Cancelled" and cancelled["can_retry"]


async def test_library_not_connected_refuses_ingest(kb_client: httpx.AsyncClient) -> None:
    response = await kb_client.post("/kb/materials/mat-x/ingest")
    assert response.status_code == 503
