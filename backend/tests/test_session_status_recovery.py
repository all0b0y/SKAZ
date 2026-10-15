"""A restarted backend has no live capture, so no session may still claim one.

Before this, a session left in ``recording`` by a crash, a force quit or a session
that was created but never recorded stayed "Recording" in the list forever. The
sessions are recordings' technical sessions; their status is read from the
repository (the list route of the old interface is gone).
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any, TypeVar

import httpx

from skaz import repository as repo
from skaz.app import create_app
from skaz.config import AppConfig
from skaz.secrets import MemorySecretStore
from tests.sessions_support import create_session

TOKEN = "test-token"
T = TypeVar("T")


async def _with_app(config: AppConfig, action: Callable[[Any, httpx.AsyncClient], Awaitable[T]]) -> T:
    app = create_app(config, secret_store=MemorySecretStore())
    try:
        async with app.router.lifespan_context(app), httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8765",
            headers={"Authorization": f"Bearer {TOKEN}"},
        ) as client:
            return await action(app, client)
    finally:
        app.state.runtime.close()


async def test_restart_releases_sessions_left_recording(tmp_path: Path) -> None:
    config = AppConfig(token=TOKEN, data_dir=tmp_path / "data", request_timeout_s=5.0)

    async def seed(app: Any, client: httpx.AsyncClient) -> dict[str, str]:
        left = create_session(app, "left recording")
        saved = create_session(app, "saved")
        await client.patch(f"/sessions/{saved}", json={"status": "stopped"})
        return {"left": left, "saved": saved}

    ids = await _with_app(config, seed)

    async def statuses(app: Any, _client: httpx.AsyncClient) -> dict[str, str]:
        return {item.id: item.status for item in repo.list_sessions(app.state.runtime.db)}

    after = await _with_app(config, statuses)
    assert after[ids["left"]] == "paused"
    assert after[ids["saved"]] == "stopped"
