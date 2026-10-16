"""Page file actions for the main process (decision B20): the page file route.

``GET /kb/wiki/pages/{id}/file`` is called by Electron main only (Show in Finder, Open in Obsidian);
the IPC policy refuses it to the renderer.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import httpx

from .ingest_support import ScriptedWiki, add_material
from .test_corrections import CONCEPTS, NOTES, SPEECH
from .wiki_support import ingest_done, settle_wiki, wired


async def test_page_file_is_the_absolute_path_inside_the_library(
    kb_app: Any, kb_client: httpx.AsyncClient
) -> None:
    await kb_client.post("/kb/library", json={})
    runtime = kb_app.state.runtime
    material_id = add_material(runtime.kb, "Физика", "Лекция 8", SPEECH)
    ingest, service = wired(runtime.kb, ScriptedWiki(notes=[NOTES], concepts=[CONCEPTS]), None, runtime)
    await ingest_done(ingest, material_id)
    await settle_wiki(service, ingest)
    page = runtime.kb.pages()[0]
    answer = (await kb_client.get(f"/kb/wiki/pages/{page.id}/file")).json()
    path = Path(answer["path"])
    assert path.is_absolute() and path.is_file()
    assert path == runtime.kb.library_root / page.rel_path
    assert (await kb_client.get("/kb/wiki/pages/pg-missing/file")).status_code == 404
