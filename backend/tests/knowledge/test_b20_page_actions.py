"""Page file actions for the main process (decision B20): the page file route.

``GET /kb/wiki/pages/{id}/file`` is called by Electron main only (Show in Finder, Open in Obsidian);
the IPC policy refuses it to the renderer.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import httpx
import pytest

from skaz.knowledge.errors import NameRejected, NameTaken
from skaz.knowledge.markdown.page import Block, parse_page
from skaz.knowledge.wiki.pages_io import PageChanging

from .ingest_support import ScriptedWiki, add_material
from .test_corrections import CONCEPTS, NOTES, SPEECH
from .wiki_support import ENTROPY_TITLE, TwoSources, ingest_done, settle_wiki, two_sources, wired

_LINK = re.compile(r"\[\[([^\]|#\n]*)(#[^\]|\n]*)?(?:\|([^\]\n]*))?\]\]")


def page_text(world: TwoSources, page_id: str) -> str:
    record = world.kb.page_repo.get(page_id)
    assert record is not None
    return (world.kb.library_root / record.rel_path).read_text("utf-8")


def all_files(world: TwoSources) -> dict[str, bytes]:
    root = world.kb.library_root
    return {str(path.relative_to(root)): path.read_bytes() for path in root.rglob("*.md")}


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


async def test_index_and_log_read_only_with_links(kb_app: Any, kb_client: httpx.AsyncClient) -> None:
    await kb_client.post("/kb/library", json={})
    empty = (await kb_client.get("/kb/wiki/files/index")).json()
    assert empty["name"] == "index" and empty["links"] == [] and empty["text"].strip() in ("", "# Index")
    runtime = kb_app.state.runtime
    material_id = add_material(runtime.kb, "Физика", "Лекция 8", SPEECH)
    ingest, service = wired(runtime.kb, ScriptedWiki(notes=[NOTES], concepts=[CONCEPTS]), None, runtime)
    await ingest_done(ingest, material_id)
    await settle_wiki(service, ingest)
    index = (await kb_client.get("/kb/wiki/files/index")).json()
    assert index["text"].startswith("# Index")
    page_ids = {page.id for page in runtime.kb.pages()}
    linked = {link["page"]["id"] for link in index["links"] if link["page"]}
    assert linked and linked <= page_ids
    log = (await kb_client.get("/kb/wiki/files/log")).json()
    assert log["name"] == "log" and "Лекция 8" in log["text"]
    assert (await kb_client.get("/kb/wiki/files/secrets")).status_code == 422
    assert (await kb_client.get("/kb/wiki/files/..%2Fdata")).status_code in (404, 422)


async def test_rename_rewrites_every_link_atomically_and_keeps_ownership(ready: Any) -> None:
    world = await two_sources(ready, conflict=False)
    temperature = world.concept_id("Температура")
    entropy = world.concept_id(ENTROPY_TITLE)
    # A hand-typed link in the user's own note, by name, with the old name as its label.
    world.service.add_note(
        entropy, "Связано с [[Температура]] и с [[Wiki/Concepts/Температура|температурой]].",
        after_block_id=None, section=None,
    )
    before = {page.id: page_text(world, page.id) for page in world.kb.pages() if page.id != temperature}
    linking = [pid for pid, text in before.items() if "Температура" in text]
    assert entropy in linking

    detail = world.service.rename_page(temperature, "Температура газа")
    assert detail.view.title == "Температура газа"
    root = world.kb.library_root
    assert (root / "Wiki/Concepts/Температура газа.md").is_file()
    assert not (root / "Wiki/Concepts/Температура.md").exists()
    renamed_text = (root / "Wiki/Concepts/Температура газа.md").read_text("utf-8")
    assert parse_page(renamed_text).meta.title == "Температура газа"
    for page in world.kb.pages():
        text = page_text(world, page.id)
        targets = [m.group(1) for m in _LINK.finditer(text)]
        assert "Wiki/Concepts/Температура" not in targets and "Температура" not in targets, page.title
        for block in parse_page(text).blocks():
            if block.owner == "agent" and "Температура газа" in block.body:
                assert block.hash_matches(), (page.title, block.id)  # still the agent's, not "edited"
    note = page_text(world, entropy)
    assert "[[Температура газа]]" in note
    assert "[[Wiki/Concepts/Температура газа|температурой]]" in note  # a label that wasn't the name stays
    # The graph and the index follow; the log says what happened.
    related, mentioned = world.service.graph.neighbours(temperature)
    assert entropy in related + mentioned
    assert "Температура газа" in (root / "Wiki" / "index.md").read_text("utf-8")
    assert "Температура → Температура газа" in (root / "Wiki" / "log.md").read_text("utf-8")


async def test_rename_refuses_taken_and_bad_names_and_rolls_back(
    ready: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    world = await two_sources(ready, conflict=False)
    temperature = world.concept_id("Температура")
    with pytest.raises(NameTaken):
        world.service.rename_page(temperature, ENTROPY_TITLE)
    with pytest.raises(NameRejected):
        world.service.rename_page(temperature, "a/b")
    snapshot = all_files(world)
    library = world.kb.require()
    real = library.rewrite_page
    calls = {"n": 0}

    def flaky(path: Any, expected: bytes, text: str) -> bool:
        calls["n"] += 1
        return False if calls["n"] == 2 else real(path, expected, text)  # another page changed meanwhile

    monkeypatch.setattr(library, "rewrite_page", flaky)
    with pytest.raises(PageChanging):
        world.service.rename_page(temperature, "Температура газа")
    monkeypatch.setattr(library, "rewrite_page", real)
    assert all_files(world) == snapshot  # nothing renamed, nothing rewritten


async def test_delete_preview_then_delete_unlinks_and_keeps_sources(ready: Any) -> None:
    world = await two_sources(ready, conflict=False)
    temperature = world.concept_id("Температура")
    entropy = world.concept_id(ENTROPY_TITLE)
    world.service.add_note(entropy, "См. [[Температура]].", after_block_id=None, section=None)
    world.service.add_note(temperature, "Моя заметка о температуре.", after_block_id=None, section=None)
    source = world.kb.material_repo.get(world.lecture)
    assert source is not None

    plan = world.service.page_delete_preview(temperature)
    assert plan.page.title == "Температура" and plan.user_notes == 1
    by_page = {item.ref.id: item for item in plan.linking}
    assert entropy in by_page and by_page[entropy].in_user_text == 1 and by_page[entropy].links >= 2
    assert (world.lecture, "Лекция 8") in plan.sources
    assert (world.kb.library_root / "Wiki/Concepts/Температура.md").is_file()  # a preview changes nothing

    world.service.delete_page(temperature)
    root = world.kb.library_root
    assert not (root / "Wiki/Concepts/Температура.md").exists()
    assert world.kb.page_repo.get(temperature) is None
    text = page_text(world, entropy)
    assert "Температура" in text and "[[Температура]]" not in text and "Wiki/Concepts/Температура" not in text
    assert "См. Температура." in text  # the user's words keep their text
    for block in parse_page(text).blocks():
        if block.owner == "agent":
            assert block.hash_matches()
    assert isinstance(parse_page(text).blocks()[0], Block)
    assert (root / source.source_file).is_file()  # sources untouched
    assert "Температура" not in (root / "Wiki" / "index.md").read_text("utf-8")
    assert "Page deleted: Температура" in (root / "Wiki" / "log.md").read_text("utf-8")


async def test_page_rename_and_delete_over_http(kb_app: Any, kb_client: httpx.AsyncClient) -> None:
    await kb_client.post("/kb/library", json={})
    runtime = kb_app.state.runtime
    world = await two_sources(runtime.kb, conflict=False, runtime=runtime)
    temperature = world.concept_id("Температура")
    renamed = await kb_client.patch(f"/kb/wiki/pages/{temperature}", json={"title": "Температура газа"})
    assert renamed.status_code == 200 and renamed.json()["title"] == "Температура газа"
    taken = await kb_client.patch(f"/kb/wiki/pages/{temperature}", json={"title": ENTROPY_TITLE})
    assert taken.status_code == 409
    preview = (await kb_client.get(f"/kb/wiki/pages/{temperature}/delete-preview")).json()
    assert preview["page"]["title"] == "Температура газа" and preview["links_unlinked"] >= 1
    assert {item["page"]["title"] for item in preview["linking_pages"]} >= {ENTROPY_TITLE}
    assert [source["title"] for source in preview["sources"]] == ["Лекция 8"]
    deleted = await kb_client.delete(f"/kb/wiki/pages/{temperature}")
    assert deleted.status_code == 200
    assert (await kb_client.get(f"/kb/wiki/pages/{temperature}")).status_code == 404
    assert (await kb_client.delete("/kb/wiki/pages/pg-missing")).status_code == 404
    assert (await kb_client.patch("/kb/wiki/pages/pg-missing", json={"title": "X"})).status_code == 404
