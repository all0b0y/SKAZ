"""A restarted backend has no live capture, so no session may still claim one.

Before this, a session left in ``recording`` by a crash, a force quit or a session
that was created but never recorded stayed "Recording" in the list forever.
"""

from __future__ import annotations

from pathlib import Path

import httpx

from audiohelper.app import create_app
from audiohelper.config import AppConfig
from audiohelper.secrets import MemorySecretStore

TOKEN = "test-token"


async def _with_app(config: AppConfig, action):  # type: ignore[no-untyped-def]
    app = create_app(config, secret_store=MemorySecretStore())
    try:
        async with app.router.lifespan_context(app), httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8765",
            headers={"Authorization": f"Bearer {TOKEN}"},
        ) as client:
            return await action(client)
    finally:
        app.state.runtime.close()


async def test_restart_releases_sessions_left_recording(tmp_path: Path) -> None:
    config = AppConfig(token=TOKEN, data_dir=tmp_path / "data", request_timeout_s=5.0)

    async def seed(client: httpx.AsyncClient) -> dict[str, str]:
        left = (await client.post("/sessions", json={"title": "left recording"})).json()
        saved = (await client.post("/sessions", json={"title": "saved"})).json()
        await client.patch(f"/sessions/{saved['id']}", json={"status": "stopped"})
        return {"left": left["id"], "saved": saved["id"]}

    ids = await _with_app(config, seed)

    async def statuses(client: httpx.AsyncClient) -> dict[str, str]:
        listed = (await client.get("/sessions")).json()["sessions"]
        return {item["id"]: item["status"] for item in listed}

    after = await _with_app(config, statuses)
    assert after[ids["left"]] == "paused"
    assert after[ids["saved"]] == "stopped"
