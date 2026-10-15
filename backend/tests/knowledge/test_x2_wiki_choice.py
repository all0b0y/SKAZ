"""Final review M1 (decision 15): the "to wiki" switch of a new material is the user's.

Settings → Wiki only give its default. The flag travels with the add request; ``AutoIngest.wants``
honours it — documents through their source event, imports (ready later) through the kept choice.
"""

from __future__ import annotations

import asyncio
from typing import Any

import httpx

from skaz.knowledge.service import KnowledgeService
from skaz.knowledge.sources.service import SourceEvent

from .ingest_support import ScriptedWiki, add_material, block, cite, notes, settle
from .test_wiring import wired

TEXT = "Entropy is a measure of the disorder of a system."


def wiki_with_notes() -> ScriptedWiki:
    good = block("from_source", "Entropy measures disorder.", cite(1, "a measure of the disorder"))
    return ScriptedWiki(notes=[notes(("Entropy", [good]))] * 4)


async def nothing_started(ingest: Any, material_id: str) -> bool:
    await asyncio.sleep(0.1)
    return not ingest.list_jobs(material_id=material_id)


async def test_unticked_stays_out_although_settings_add_automatically(ready: KnowledgeService) -> None:
    ingest, sources = wired(ready, wiki_with_notes())
    ingest.update_settings(auto_add_text=True, auto_add_files_links=True)
    result = sources.add_text(TEXT, "fld-inbox", "Held back", to_wiki=False)
    assert await nothing_started(ingest, result.material_id)

    default = sources.add_text(TEXT, "fld-inbox", "Default")  # no choice: the settings decide
    await settle(lambda: bool(ingest.list_jobs(material_id=default.material_id)))


async def test_ticked_goes_in_although_settings_do_not_add(ready: KnowledgeService) -> None:
    ingest, sources = wired(ready, wiki_with_notes())
    ingest.update_settings(auto_add_text=False, auto_add_files_links=False)
    result = sources.add_text(TEXT, "fld-inbox", "Wanted", to_wiki=True)
    await settle(lambda: bool(ingest.list_jobs(material_id=result.material_id)))


async def test_an_import_keeps_the_choice_until_it_is_finished(ready: KnowledgeService) -> None:
    from skaz.knowledge.wiring import AutoIngest

    ingest, _sources = wired(ready, wiki_with_notes())
    ingest.update_settings(auto_add_files_links=True)
    auto = AutoIngest(ready, ingest)
    material_id = add_material(ready, "Физика", "Lecture audio")  # a speech material, no event yet
    auto.remember(material_id, False)
    assert not auto.wants(SourceEvent("material_ready", material_id))  # the finished import
    # Used once: a later "ready" of the same material (a resumed recording) follows the settings again.
    assert auto.wants(SourceEvent("material_ready", material_id))
    auto.remember(material_id, True)
    ingest.update_settings(auto_add_files_links=False)
    assert auto.wants(SourceEvent("material_ready", material_id))


async def test_the_flag_over_http(kb_app: Any, kb_client: httpx.AsyncClient) -> None:
    await kb_client.post("/kb/library", json={})
    runtime = kb_app.state.runtime
    runtime.kb_ingest.update_settings(auto_add_text=True)
    response = await kb_client.post("/kb/materials/text", json={
        "text": TEXT, "folder_id": "fld-inbox", "title": "Over HTTP", "to_wiki": False})
    assert response.status_code == 201, response.text
    material_id = response.json()["material"]["id"]
    assert await nothing_started(runtime.kb_ingest, material_id)
    bad = await kb_client.post("/kb/materials/text",
                               json={"text": TEXT, "folder_id": "fld-inbox", "to_wiki": "x"})
    assert bad.status_code == 422


async def test_auto_ingest_keeps_a_reference_to_the_task_it_starts(ready: KnowledgeService) -> None:
    """Review Low: a bare ``loop.create_task`` may be collected mid-run; AutoIngest holds it until done."""
    ingest, sources = wired(ready, wiki_with_notes())
    from skaz.knowledge.wiring import AutoIngest

    auto = AutoIngest(ready, ingest)
    material_id = add_material(ready, "Физика", "Kept task")
    auto.remember(material_id, True)
    auto(SourceEvent("material_ready", material_id))
    assert len(auto.running) == 1
    await settle(lambda: not auto.running)
