"""Native recording state through the existing authenticated session API."""
from __future__ import annotations

from typing import Any

import httpx

from tests.sessions_support import create_session


async def test_native_snapshot_is_authenticated_and_has_no_paths(client: httpx.AsyncClient, app: Any) -> None:
    session_id = create_session(client, "Native")
    store = app.state.runtime.live_store
    connection = store.open(session_id, sample_rate=16000, model="stt-rt-v5")
    store.append_audio(connection.id, sequence=0, start_sample=0, pcm=b"\x00\x00" * 1600)
    response = await client.get(f"/sessions/{session_id}/live")
    assert response.status_code == 200
    assert response.json()["saved_samples"] == 1600
    assert "path" not in response.text
    denied = await client.get(f"/sessions/{session_id}/live", headers={"Authorization": ""})
    assert denied.status_code == 401


async def test_missing_native_snapshot_is_not_an_empty_success(client: httpx.AsyncClient) -> None:
    assert (await client.get("/sessions/missing/live")).status_code == 404
