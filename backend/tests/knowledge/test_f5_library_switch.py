"""QA E15: switching to a library that can't be read serves nothing of the previous library."""
from __future__ import annotations

from pathlib import Path

import httpx

from skaz.knowledge.library.library import INBOX_ID, Library
from skaz.knowledge.markdown.source import FragmentInput
from skaz.knowledge.service import KnowledgeService


def unreadable_library(documents: Path, name: str) -> tuple[Path, Path]:
    root = documents / name
    Library.create(root)
    materials = root / "Materials"
    materials.chmod(0)
    return root, materials


def test_switch_to_unavailable_library_clears_previous_index(ready: KnowledgeService,
                                                            documents: Path) -> None:
    ready.create_material(INBOX_ID, "Probe Big1", "text", [FragmentInput(text="uniqueprobe token")])
    assert ready.search("uniqueprobe").fragments
    root_b, materials_b = unreadable_library(documents, "Other")
    try:
        view = ready.connect(str(root_b))
        assert view.state == "unavailable" and view.root == str(root_b)
        assert ready.materials() == []
        assert ready.folders() == []
        assert ready.pages() == []
        assert not ready.search("uniqueprobe").fragments
    finally:
        materials_b.chmod(0o755)
    # Going back to the first library brings its materials back from its files.
    view = ready.connect(str(documents / "SKAZ"))
    assert view.state == "ready"
    assert [m.title for m in ready.materials()] == ["Probe Big1"]


def test_same_library_unavailable_keeps_its_index(ready: KnowledgeService) -> None:
    ready.create_material(INBOX_ID, "Kept", "text", [FragmentInput(text="kept text")])
    materials = ready.library_root / "Materials"
    materials.chmod(0)
    try:
        assert ready.connect(str(ready.library_root)).state == "unavailable"
        assert [m.title for m in ready.materials()] == ["Kept"]
    finally:
        materials.chmod(0o755)


async def test_api_lists_no_materials_of_the_previous_library(
        kb_client: httpx.AsyncClient, documents: Path) -> None:
    assert (await kb_client.post("/kb/library", json={})).status_code == 200
    created = await kb_client.post("/kb/materials/text",
                                   json={"folder_id": INBOX_ID, "title": "Probe Big1", "text": "body"})
    assert created.status_code == 201, created.text
    root_b, materials_b = unreadable_library(documents, "SKAZ2")
    try:
        switched = await kb_client.post("/kb/library", json={"path": str(root_b)})
        assert switched.json()["state"] == "unavailable"
        listed = await kb_client.get("/kb/materials")
        assert listed.status_code == 200 and listed.json() == []
    finally:
        materials_b.chmod(0o755)
