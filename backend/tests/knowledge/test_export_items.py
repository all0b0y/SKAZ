"""``POST /kb/export/items`` (0.3.1 F5): chosen chats, wiki pages and materials as ``.md`` into a folder.

Pages and materials keep the layout of the whole-library export (so footnote links still resolve),
chats go to ``Chats/``; the folder rules are those of ``POST /kb/export``. Real library on disk,
real ingest on ``FakeEngine`` answers; no agent, no network.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import httpx

from .test_b20_export import built_library


async def test_items_are_written_where_the_library_export_puts_them_and_unknown_ones_are_skipped(
    kb_app: Any, kb_client: httpx.AsyncClient, documents: Path
) -> None:
    await kb_client.post("/kb/library", json={})
    runtime = kb_app.state.runtime
    material_id = await built_library(runtime.kb, runtime)
    page = runtime.kb.pages()[0]
    material = runtime.kb.material_repo.get(material_id)
    created = await kb_client.post("/kb/chats", json={})
    assert created.status_code == 201, created.text
    chat = created.json()

    dest = documents / "Picked"
    answer = await kb_client.post("/kb/export/items", json={"path": str(dest), "items": [
        {"type": "page", "id": page.id},
        {"type": "material", "id": material_id},
        {"type": "chat", "id": chat["id"]},
        {"type": "page", "id": "no-such-page"},
        {"type": "page", "id": page.id},  # the same item twice is written once
    ]})
    assert answer.status_code == 200, answer.text
    body = answer.json()
    assert [(w["type"], w["id"]) for w in body["written"]] == [
        ("page", page.id), ("material", material_id), ("chat", chat["id"]),
    ]
    files = {w["type"]: w["file"] for w in body["written"]}
    assert files["page"] == page.rel_path
    assert files["material"] == material.source_file
    assert files["chat"].startswith("Chats/") and files["chat"].endswith(".md")
    assert body["skipped"] == [{"type": "page", "id": "no-such-page", "reason": "Page not found."}]

    page_text = (dest / page.rel_path).read_text("utf-8")
    assert page_text.startswith("---\ntitle: ") and "%% skaz:" not in page_text and "skaz_id" not in page_text
    assert (dest / material.source_file).read_text("utf-8").startswith("---\ntitle: ")
    assert (dest / files["chat"]).read_text("utf-8").startswith("# ")
    # Nothing else: no wiki index/log, no other materials, no SKAZ service files.
    written = {str(p.relative_to(dest)) for p in dest.rglob("*") if p.is_file()}
    assert written == {page.rel_path, files["chat"], *{
        str(p.relative_to(runtime.kb.library_root))
        for p in (runtime.kb.library_root / material.rel_dir).iterdir() if p.suffix == ".md"
    }}


async def test_same_folder_rules_as_the_library_export(
    kb_app: Any, kb_client: httpx.AsyncClient, documents: Path
) -> None:
    await kb_client.post("/kb/library", json={})
    runtime = kb_app.state.runtime
    material_id = await built_library(runtime.kb, runtime)
    items = [{"type": "material", "id": material_id}]
    wiki_dir = str(runtime.kb.library_root / "Wiki")
    inside = await kb_client.post("/kb/export/items", json={"path": wiki_dir, "items": items})
    assert inside.status_code == 409 and "outside the SKAZ library" in inside.json()["detail"]
    busy = documents / "Busy"
    busy.mkdir()
    (busy / "keep.txt").write_text("mine")
    refused = await kb_client.post("/kb/export/items", json={"path": str(busy), "items": items})
    assert refused.status_code == 409 and "isn't empty" in refused.json()["detail"]
    ok = await kb_client.post("/kb/export/items", json={"path": str(busy), "items": items, "overwrite": True})
    assert ok.status_code == 200 and len(ok.json()["written"]) == 1
    assert (busy / "keep.txt").read_text() == "mine"
    empty = await kb_client.post("/kb/export/items", json={"path": str(busy), "items": []})
    assert empty.status_code == 422
    many = await kb_client.post("/kb/export/items", json={"path": str(busy), "items": items * 501})
    assert many.status_code == 422
    folder = [{"type": "folder", "id": "x"}]
    odd = await kb_client.post("/kb/export/items", json={"path": str(busy), "items": folder})
    assert odd.status_code == 422
