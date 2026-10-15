"""Review Low (dead code): ``contextual_local_enabled`` was stored and echoed but nothing read it.

The proof that it had no reader: ``grep -rn contextual_local_enabled backend/src frontend/src electron
scripts`` found only the settings document, its update merge, the ASR revision bump and the
``GET /settings`` echo — no decoder, gate or UI. It is gone; settings documents that still carry it
load as before (the key is ignored).
"""
from __future__ import annotations

import json
from typing import Any

import httpx

from skaz.settings_store import DEFAULT_SETTINGS, StoredSettings


def test_an_old_settings_document_with_the_retired_key_still_loads() -> None:
    doc = {**DEFAULT_SETTINGS.model_dump(), "contextual_local_enabled": True}
    settings = StoredSettings.model_validate(doc)
    assert "contextual_local_enabled" not in json.loads(settings.model_dump_json())


async def test_the_setting_is_neither_shown_nor_accepted(kb_app: Any, kb_client: httpx.AsyncClient) -> None:
    shown = (await kb_client.get("/settings")).json()
    assert "contextual_local_enabled" not in shown
    refused = await kb_client.put("/settings", json={"contextual_local_enabled": True})
    assert refused.status_code == 422
