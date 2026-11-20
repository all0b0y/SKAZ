"""A saved scan stays available for explicit visual turns through the default routes."""

from hashlib import sha256
from io import BytesIO
from pathlib import Path
from unittest.mock import Mock

import httpx
import pytest
from fastapi import FastAPI
from PIL import Image

from skaz.knowledge.library.library import INBOX_ID
from skaz.knowledge.sources import document_card
from skaz.runtime import Runtime
from tests.knowledge.chat_support import connect
from tests.knowledge.ingest_support import settle
from tests.knowledge.pdf_fixtures import glyph_line, line, make_pdf
from tests.knowledge.test_visual_transport041_wiring import _setup_routing_matrix

SCAN_PAGE = b"q 612 0 0 792 0 0 cm /Im1 Do Q\n"


@pytest.mark.parametrize("source", ["picker", "drop"])
async def test_saved_scan_and_duplicate_can_send_one_selected_page(
    kb_client: httpx.AsyncClient, kb_app: FastAPI, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
    source: str,
) -> None:
    runtime: Runtime = kb_app.state.runtime
    await connect(kb_client, runtime)
    engines = _setup_routing_matrix(runtime)
    path = tmp_path / "scan.pdf"
    data = make_pdf([SCAN_PAGE, SCAN_PAGE.replace(b"612 ", b"550 ")], image=True)
    path.write_bytes(data)
    fingerprint = sha256(data).hexdigest()
    intake = {
        "path": str(path), "folder_id": INBOX_ID, "selection_source": source,
        "expected_size": len(data), "expected_sha256": fingerprint, "to_wiki": False,
    }
    added = await kb_client.post("/kb/materials/file", json=intake)
    assert added.status_code == 201, added.text
    saved = added.json()
    material = saved["material"]
    material_id = material["id"]
    assert material["status"] == "failed" and material["fragment_count"] == 0
    assert saved.get("saved_pdf_page_count") == 2
    duplicate = await kb_client.post("/kb/materials/file", json={
        **intake, "selection_source": "drop" if source == "picker" else "picker",
    })
    assert duplicate.status_code == 200, duplicate.text
    assert duplicate.json()["already_in_library"]
    assert duplicate.json()["material"]["id"] == material_id
    assert duplicate.json()["saved_pdf_page_count"] == 2

    render = Mock(wraps=document_card.card_page_png)
    monkeypatch.setattr(document_card, "card_page_png", render)
    chat = await kb_client.post("/kb/chats", json={"engine": "claude_code", "model": "sonnet"})
    assert chat.status_code == 201, chat.text
    chat_id = chat.json()["id"]
    route = f"/kb/chats/{chat_id}/messages"
    body = {"text": "Describe this", "attachments": [material_id]}
    preflight = await kb_client.post("/kb/chats/visual-preflight", json={"chat_id": chat_id, **body})
    assert preflight.status_code == 200, preflight.text
    decision = preflight.json()
    assert decision["requires_visual"] and not decision["supported"]
    assert decision["title"] == "Specify PDF pages"
    assert decision["locator"]["material_id"] == material_id
    assert not decision["text_only_available"]
    refused = await kb_client.post(route, json=body)
    assert refused.status_code == 422 and refused.json()["code"] == "VISUAL_UNSUPPORTED"
    text_only = await kb_client.post(route, json={**body, "text_only": True})
    assert text_only.status_code == 422 and text_only.json()["code"] == "VISUAL_TEXT_ONLY_UNAVAILABLE"
    render.assert_not_called()
    assert engines["claude_code"].turns == []

    body["text"] = "Describe page 2"
    preflight = await kb_client.post("/kb/chats/visual-preflight", json={"chat_id": chat_id, **body})
    assert preflight.status_code == 200 and preflight.json()["supported"], preflight.text
    assert not preflight.json()["text_only_available"]
    render.assert_not_called()
    assert engines["claude_code"].turns == []
    sent = await kb_client.post(route, json=body)
    assert sent.status_code == 202, sent.text
    await settle(lambda: runtime.kb_chats.state_of(chat_id) == "idle")
    (turn,) = engines["claude_code"].turns
    (visual,) = turn.visuals
    render.assert_called_once()
    assert render.call_args.args[1] == 2
    assert visual.locator.material_id == material_id and visual.locator.page == 2
    with Image.open(BytesIO(visual.approved_bytes)) as image:
        assert image.format == "PNG"
        # Both pages contain a grey scan. Only page 2 has a white right margin.
        grey = image.getpixel((image.width // 2, image.height // 2))
        assert all(120 <= channel <= 136 for channel in grey)
        assert image.getpixel((image.width - 3, image.height // 2)) == (255, 255, 255)
    jobs = await kb_client.get("/kb/jobs", params={"material_id": material_id})
    assert jobs.status_code == 200 and jobs.json() == []


@pytest.mark.parametrize("changed_original", ["missing", "different_bytes"])
async def test_scan_duplicate_requires_an_intact_saved_original(
    kb_client: httpx.AsyncClient, kb_app: FastAPI, tmp_path: Path, changed_original: str,
) -> None:
    runtime: Runtime = kb_app.state.runtime
    await connect(kb_client, runtime)
    path = tmp_path / "scan.pdf"
    data = make_pdf([SCAN_PAGE], image=True)
    path.write_bytes(data)
    body = {"path": str(path), "folder_id": INBOX_ID, "to_wiki": False}
    added = await kb_client.post("/kb/materials/file", json=body)
    assert added.status_code == 201, added.text
    material_id = added.json()["material"]["id"]
    original, = runtime.kb.require().root.rglob(document_card.CARD_NAME)
    if changed_original == "missing":
        original.unlink()
    else:
        saved_card = original.read_bytes()
        modified = saved_card.replace(b'data-width="612', b'data-width="611', 1)
        assert modified != saved_card and len(modified) == len(saved_card)
        original.write_bytes(modified)
    duplicate = await kb_client.post("/kb/materials/file", json=body)
    assert duplicate.status_code == 200, duplicate.text
    saved = duplicate.json()
    assert saved["material"]["id"] == material_id and saved["material"]["status"] == "failed"
    assert saved["already_in_library"] and saved.get("saved_pdf_page_count") is None


async def test_unreadable_pdf_is_refused_and_readable_pdf_keeps_text_readiness(
    kb_client: httpx.AsyncClient, kb_app: FastAPI, tmp_path: Path,
) -> None:
    await connect(kb_client, kb_app.state.runtime)
    path = tmp_path / "report.pdf"
    body = {"path": str(path), "folder_id": INBOX_ID, "to_wiki": False}
    path.write_bytes(b"%PDF-1.7\n%%EOF\n")
    refused = await kb_client.post("/kb/materials/file", json=body)
    assert refused.status_code == 422
    assert "material" not in refused.json()
    path.write_bytes(make_pdf([line("A visible caption.", 690)]))
    added = await kb_client.post("/kb/materials/file", json=body)
    assert added.status_code == 201, added.text
    saved = added.json()
    assert saved["material"]["status"] == "ready" and saved["material"]["fragment_count"] == 1
    assert saved.get("saved_pdf_page_count") is None


@pytest.mark.parametrize("finding_kind", ["hidden_pdf_text", "unreadable_pdf_text"])
async def test_other_failed_pdf_text_extraction_does_not_get_scan_capability(
    kb_client: httpx.AsyncClient, kb_app: FastAPI, tmp_path: Path, finding_kind: str,
) -> None:
    await connect(kb_client, kb_app.state.runtime)
    path = tmp_path / "report.pdf"
    if finding_kind == "hidden_pdf_text":
        path.write_bytes(make_pdf([line("Hidden only.", 700, prefix="3 Tr")]))
    else:
        codes = [((ord(char) * 7) % 90) + 3 for char in "Quarterly results of the fund"]
        path.write_bytes(make_pdf([glyph_line("", 700, codes=codes)], cid_font="unmapped"))
    body = {"path": str(path), "folder_id": INBOX_ID, "to_wiki": False}
    added = await kb_client.post("/kb/materials/file", json=body)
    assert added.status_code == 201, added.text
    saved = added.json()
    material_id = saved["material"]["id"]
    assert saved["material"]["status"] == "failed" and saved["material"]["fragment_count"] == 0
    guard = await kb_client.get(f"/kb/materials/{material_id}/excluded")
    assert guard.status_code == 200 and guard.json()["hidden"][0]["kind"] == finding_kind
    assert saved.get("saved_pdf_page_count") is None
    duplicate = await kb_client.post("/kb/materials/file", json=body)
    assert duplicate.status_code == 200 and duplicate.json()["material"]["id"] == material_id
    assert duplicate.json().get("saved_pdf_page_count") is None
