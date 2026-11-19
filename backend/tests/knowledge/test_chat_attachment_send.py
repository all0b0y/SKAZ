"""Attachment-only drafts through the real material and chat HTTP endpoints."""
from __future__ import annotations

from collections.abc import Mapping
from hashlib import sha256
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import FastAPI

from skaz.knowledge.agents.engine import EngineId
from skaz.knowledge.agents.fake import FakeEngine
from skaz.knowledge.library.library import INBOX_ID
from tests.knowledge.ingest_support import settle
from tests.knowledge.test_source_visual import make_png
from tests.knowledge.test_visual_transport041_wiring import _setup_routing_matrix


@pytest.fixture
async def engines(kb_app: FastAPI, kb_client: httpx.AsyncClient) -> Mapping[EngineId, FakeEngine]:
    connected = await kb_client.post("/kb/library", json={})
    assert connected.status_code in (200, 201), connected.text
    return _setup_routing_matrix(kb_app.state.runtime)


@pytest.fixture
async def chat_path(kb_client: httpx.AsyncClient, engines: Mapping[EngineId, FakeEngine]) -> str:
    result = await kb_client.post("/kb/chats", json={"engine": "claude_code", "model": "sonnet"})
    assert result.status_code == 201, result.text
    return f"/kb/chats/{result.json()['id']}"


@pytest.mark.parametrize("source", ["clipboard", "picker", "drop"])
async def test_send_saved_image_without_caption(
    kb_app: FastAPI,
    kb_client: httpx.AsyncClient,
    engines: Mapping[EngineId, FakeEngine],
    chat_path: str,
    tmp_path: Path,
    source: str,
) -> None:
    png = make_png(4, 3)
    if source == "clipboard":
        saved = await kb_client.post(
            "/kb/materials/clipboard-image", params={"folder_id": INBOX_ID, "file_name": "chart.png"},
            content=png, headers={"Content-Type": "image/png"},
        )
    else:
        path = tmp_path / "chart.png"
        path.write_bytes(png)
        saved = await kb_client.post("/kb/materials/file", json={
            "path": str(path), "folder_id": INBOX_ID, "selection_source": source, "to_wiki": False,
            "expected_size": len(png), "expected_sha256": sha256(png).hexdigest(),
        })
    assert saved.status_code == 201, saved.text
    material = saved.json()["material"]
    assert material["fragment_count"] == 0
    material_id = material["id"]
    chat_id = chat_path.rsplit("/", 1)[-1]
    body = {"text": "", "attachments": [material_id]}

    preflight = await kb_client.post("/kb/chats/visual-preflight", json={"chat_id": chat_id, **body})
    assert preflight.status_code == 200, preflight.text
    assert preflight.json()["supported"] and preflight.json()["requires_visual"]
    assert (await kb_client.get(chat_path)).json()["messages"] == []
    assert engines["claude_code"].turns == []

    sent = await kb_client.post(f"{chat_path}/messages", json=body)
    assert sent.status_code == 202, sent.text
    await settle(lambda: kb_app.state.runtime.kb_chats.state_of(chat_id) == "idle")
    persisted = (await kb_client.get(chat_path)).json()["messages"]
    assert [item for item in persisted if item["role"] == "user"] == [sent.json()["user"]]
    user_input = sent.json()["user"]["input"]
    assert user_input["text"] == ""
    assert user_input["attachments"] == [material_id]
    (turn,) = engines["claude_code"].turns
    assert [visual.locator.material_id for visual in turn.visuals] == [material_id]
    assert (await kb_client.get("/kb/jobs", params={"material_id": material_id})).json() == []


@pytest.mark.parametrize("body", [
    pytest.param({}, id="missing-text"),
    pytest.param({"text": ""}, id="empty-text"),
    pytest.param({"text": " \t\n "}, id="whitespace"),
    pytest.param({"text": "", "attachments": ["mat-missing"]}, id="unsaved-id"),
    pytest.param({"text": "Describe", "attachments": [""]}, id="malformed-attachment"),
    pytest.param({"text": "Describe", "mentions": [{"type": "material", "id": "", "title": "Chart"}]},
                 id="malformed-mention"),
    pytest.param({"text": "Describe", "quotes": [{"source": "material", "id": "mat-chart", "text": ""}]},
                 id="malformed-quote"),
])
async def test_send_rejects_empty_drafts_and_invalid_references(
    kb_client: httpx.AsyncClient, chat_path: str, body: dict[str, Any],
) -> None:
    sent = await kb_client.post(f"{chat_path}/messages", json=body)
    assert sent.status_code == 422, sent.text
    assert (await kb_client.get(chat_path)).json()["messages"] == []
