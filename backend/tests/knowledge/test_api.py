"""``/kb/*`` over ASGI with the bearer token, the way the renderer calls it."""
from __future__ import annotations

from pathlib import Path
from typing import Any

import httpx
from starlette.testclient import TestClient

from skaz.app import create_app
from skaz.config import AppConfig
from skaz.knowledge.markdown.page import Block, Cite, PageDocument, PageMeta
from skaz.knowledge.markdown.source import FragmentInput
from skaz.secrets import MemorySecretStore
from tests.conftest import TOKEN

COLLISION = "An item with this name already exists. Choose another name."


async def test_kb_routes_require_the_token(kb_app: Any) -> None:
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=kb_app),
                                 base_url="http://127.0.0.1:8765") as anonymous:
        for path in ("/kb/library", "/kb/folders", "/kb/materials", "/kb/wiki/pages", "/kb/search?q=x",
                     "/kb/notifications"):
            assert (await anonymous.get(path)).status_code == 401, path


async def test_library_lifecycle_and_folders(kb_client: httpx.AsyncClient, documents: Path) -> None:
    library = (await kb_client.get("/kb/library")).json()
    assert library == {"state": "not_configured", "root": None, "suggested_root": str(documents / "SKAZ"),
                       "reason": None, "library_id": None}
    assert (await kb_client.post("/kb/folders", json={"name": "Физика"})).status_code == 503

    connected = (await kb_client.post("/kb/library", json={})).json()
    assert connected["state"] == "ready" and connected["root"] == str(documents / "SKAZ")

    created = await kb_client.post("/kb/folders", json={"name": "Физика"})
    assert created.status_code == 201
    folder = created.json()
    assert folder["name"] == "Физика" and folder["system"] is False and folder["material_count"] == 0

    clash = await kb_client.post("/kb/folders", json={"name": "физика"})
    assert clash.status_code == 409 and clash.json() == {"detail": COLLISION}
    bad = await kb_client.post("/kb/folders", json={"name": "a/b"})
    assert bad.status_code == 422 and "Choose another name." in bad.json()["detail"]

    renamed = await kb_client.patch(f"/kb/folders/{folder['id']}", json={"name": "Термодинамика"})
    assert renamed.status_code == 200 and renamed.json()["name"] == "Термодинамика"
    names = [item["name"] for item in (await kb_client.get("/kb/folders")).json()]
    assert names == ["Inbox", "Термодинамика"]

    inbox = (await kb_client.get("/kb/folders")).json()[0]
    assert (await kb_client.delete(f"/kb/folders/{inbox['id']}")).status_code == 409
    assert (await kb_client.delete(f"/kb/folders/{folder['id']}")).status_code == 204
    assert (await kb_client.delete(f"/kb/folders/{folder['id']}")).status_code == 404
    assert (await kb_client.post("/kb/library", json={"path": "relative/path"})).status_code == 409


async def test_materials_pages_search_notifications(kb_app: Any, kb_client: httpx.AsyncClient) -> None:
    await kb_client.post("/kb/library", json={})
    kb = kb_app.state.runtime.kb
    folder = kb.create_folder("Физика")
    material = kb.create_material(folder.id, "Лекция 8", "recording", [
        FragmentInput(text="Энтропия — мера беспорядка.", start_ms=0, end_ms=4_000, speaker="1"),
        FragmentInput(text="Second fragment.", start_ms=4_000, end_ms=9_000, speaker="2"),
    ], languages=("ru",))
    material_id = material.manifest.id
    kb.create_page(PageDocument(
        meta=PageMeta(skaz_id="pg-1", kind="concept", title="Энтропия", language="ru", folders=(folder.id,),
                      sources=(material_id,)),
        parts=[Block.create("c-1", "from_source", "Энтропия — мера беспорядка.",
                            cites=(Cite(material_id, 1), Cite("mat-gone", 3)))],
    ))
    kb.notify("discrepancy", "Two sources disagree", requires_action=True)

    params = {"folder_id": folder.id, "kind": "recording"}
    listed = (await kb_client.get("/kb/materials", params=params)).json()
    assert [item["id"] for item in listed] == [material_id]
    assert listed[0]["fragment_count"] == 2
    assert (await kb_client.get("/kb/materials", params={"kind": "pdf"})).json() == []
    assert (await kb_client.get("/kb/materials", params={"kind": "nope"})).status_code == 422

    detail = (await kb_client.get(f"/kb/materials/{material_id}")).json()
    assert [f["id"] for f in detail["fragments"]] == ["seg-1", "seg-2"]
    assert detail["fragments"][1]["start_ms"] == 4_000 and detail["fragments"][1]["speaker"] == "2"
    assert (await kb_client.get("/kb/materials/mat-missing")).status_code == 404

    pages = (await kb_client.get("/kb/wiki/pages", params={"kind": "concept", "folder_id": folder.id})).json()
    assert [page["id"] for page in pages] == ["pg-1"]
    page = (await kb_client.get("/kb/wiki/pages/pg-1")).json()
    block = page["blocks"][0]
    assert block["kind"] == "from_source" and block["owner"] == "agent" and block["marked"] is True
    assert block["citations"][0] == {
        "material_id": material_id, "seg": 1, "available": True, "material_title": "Лекция 8",
        "start_ms": 0, "end_ms": 4_000, "page": None,
    }
    assert block["citations"][1]["available"] is False

    found = (await kb_client.get("/kb/search", params={"q": "беспорядка"})).json()
    assert found["fragments"][0]["material_id"] == material_id
    assert any(part["match"] for part in found["fragments"][0]["snippet"])
    assert found["blocks"][0]["page_id"] == "pg-1"
    assert (await kb_client.get("/kb/search", params={"q": "x", "limit": 0})).status_code == 422

    feed = (await kb_client.get("/kb/notifications")).json()
    assert [item["kind"] for item in feed] == ["discrepancy"]
    dismissed = (await kb_client.post(f"/kb/notifications/{feed[0]['id']}/dismiss")).json()
    assert dismissed["dismissed_at"] is not None
    assert (await kb_client.get("/kb/notifications")).json() == []
    assert (await kb_client.post("/kb/notifications/ntf-missing/dismiss")).status_code == 404


def test_startup_reopens_the_connected_library_and_never_creates_one(tmp_path: Path) -> None:
    documents = tmp_path / "Documents"
    documents.mkdir()
    config = AppConfig(token=TOKEN, data_dir=tmp_path / "data", documents_dir=documents,
                       documents_sandbox=documents)
    headers = {"Authorization": f"Bearer {TOKEN}"}
    with TestClient(create_app(config, secret_store=MemorySecretStore()), base_url="http://127.0.0.1",
                    headers=headers) as client:
        assert client.get("/kb/library").json()["state"] == "not_configured"
        assert list(documents.iterdir()) == []
        assert client.post("/kb/library", json={}).json()["state"] == "ready"
        client.post("/kb/folders", json={"name": "Курс"})
    # Added outside SKAZ between launches (Obsidian/Finder): picked up by the startup scan.
    (documents / "SKAZ" / "Materials" / "Курс").rename(documents / "SKAZ" / "Materials" / "Курс 2")
    with TestClient(create_app(config, secret_store=MemorySecretStore()), base_url="http://127.0.0.1",
                    headers=headers) as client:
        assert client.get("/kb/library").json()["state"] == "ready"
        assert [f["name"] for f in client.get("/kb/folders").json()] == ["Inbox", "Курс 2"]
