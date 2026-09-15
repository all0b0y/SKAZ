"""Native recording state through the existing authenticated session API."""
from __future__ import annotations

from typing import Any

import httpx

from tests.conftest import make_wav


async def test_native_snapshot_and_legacy_upload_isolation(client: httpx.AsyncClient, app: Any) -> None:
    session_id = (await client.post("/sessions", json={"title": "Native"})).json()["id"]
    store = app.state.runtime.live_store
    connection = store.open(session_id, sample_rate=16000, model="stt-rt-v5")
    store.append_audio(connection.id, sequence=0, start_sample=0, pcm=b"\x00\x00" * 1600)
    response = await client.get(f"/sessions/{session_id}/live")
    assert response.status_code == 200
    assert response.json()["saved_samples"] == 1600
    assert "path" not in response.text
    denied = await client.get(f"/sessions/{session_id}/live", headers={"Authorization": ""})
    assert denied.status_code == 401
    legacy = await client.post(
        f"/sessions/{session_id}/audio/store",
        params={"sequence": 1, "start_ms": 100, "end_ms": 200},
        content=make_wav(.1), headers={"Content-Type": "audio/wav"},
    )
    assert legacy.status_code == 409
    assert (await client.get(f"/sessions/{session_id}/live")).json()["saved_samples"] == 1600


async def test_missing_native_snapshot_is_not_an_empty_success(client: httpx.AsyncClient) -> None:
    assert (await client.get("/sessions/missing/live")).status_code == 404
