"""HTTP/storage contracts use real temporary SQLite; never paid provider calls."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from httpx import AsyncClient

from audiohelper import repository as repo
from audiohelper.agent.codex_runtime import CodexRuntime
from audiohelper.codex_schemas import CodexSettings
from audiohelper.db import Database
from audiohelper.gateways.codex_rpc import CodexRpc

AUTH = {"Authorization": "Bearer test-token"}


@pytest.mark.asyncio
async def test_local_chat_api_disabled_without_provider(client: AsyncClient) -> None:
    sid = (await client.post("/sessions", headers=AUTH, json={"title": "A"})).json()["id"]
    stored = (await client.get("/codex/settings", headers=AUTH)).json()
    assert (stored["assistant_enabled"], stored["notes_enabled"]) == (False, False)
    assert (await client.get("/codex/connection", headers=AUTH)).json()["status"] == "unchecked"
    chat = (await client.post("/codex/chats", headers=AUTH, json={"session_id": sid})).json()
    assert chat["scope"] == "session"
    cid = chat["id"]
    assert (await client.get("/codex/chats", headers=AUTH, params={"session_id": sid})).json()[
        "selected_chat_id"
    ] == cid
    assert (
        await client.post(f"/codex/chats/{cid}/messages", headers=AUTH, json={"question": "Hi"})
    ).status_code == 409
    assert (await client.get("/codex/tasks", headers=AUTH)).json() == {"tasks": []}
    assert (await client.patch(f"/codex/chats/{cid}", headers=AUTH, json={"title": "Renamed"})).json()[
        "title"
    ] == "Renamed"
    assert (await client.delete(f"/codex/chats/{cid}", headers=AUTH)).status_code == 409
    assert (await client.delete(f"/codex/chats/{cid}?confirmed=true", headers=AUTH)).json()["deleted"]


@pytest.mark.asyncio
async def test_codex_api_security_and_no_arbitrary_settings(client: AsyncClient) -> None:
    assert (await client.get("/codex/settings", headers={"Authorization": "Bearer wrong"})).status_code in (
        401,
        403,
    )
    assert (await client.put("/codex/settings", headers=AUTH, json={"command": "sh"})).status_code == 422
    assert (
        await client.post("/codex/connection/login", headers=AUTH, json={"consent": False})
    ).status_code == 409
    assert (await client.get("/codex/connection", headers=AUTH)).json()["status"] == "unchecked"


@pytest.mark.asyncio
async def test_service_real_subprocess_roundtrip_and_history(tmp_path: Path) -> None:
    db = Database(tmp_path / "app.sqlite")
    session = repo.create_session(db, "Example")
    service = CodexRuntime(db, tmp_path / "codex")
    # The protocol fixture is an authored responder, not evidence of model quality.
    fixture = Path(__file__).parent / "fixtures/codex_runtime_server.py"
    service.connection.rpc = lambda: CodexRpc(  # type: ignore[method-assign]
        (sys.executable, str(fixture)),
        cwd=tmp_path,
        env={},
    )
    service.connection.view.update(status="connected", models=[{"id": "fixture", "efforts": ["high"]}])
    try:
        await service.configure(
            CodexSettings(
                assistant_enabled=True, notes_enabled=True, assistant_model="fixture", assistant_effort="high"
            )
        )
        chat = service.chats.create(session.id, "session")
        task = await service.submit(chat["id"], "Test")
        await service.dispatcher.idle()
        result = service.queue.get(task["id"])
        assert result.status == "completed"
        assert result.answer
        service._finalize(result)
        service._finalize(result)
        messages = service.chats.messages(chat["id"])
        assert [m["role"] for m in messages] == ["user", "assistant"]
    finally:
        await service.close()
        db.close()


@pytest.mark.asyncio
async def test_revoked_context_prevents_queued_launch(tmp_path: Path) -> None:
    db = Database(tmp_path / "app.sqlite")
    first = repo.create_session(db, "First")
    second = repo.create_session(db, "Second")
    service = CodexRuntime(db, tmp_path / "codex")
    try:
        service.connection.view.update(status="connected", models=[{"id": "fixture", "efforts": ["high"]}])
        await service.configure(
            CodexSettings(
                assistant_enabled=True, notes_enabled=True, assistant_model="fixture", assistant_effort="high"
            )
        )
        chat = service.chats.create(first.id, "all")
        repo.delete_session(db, second.id)
        with pytest.raises(ValueError, match="Source access"):
            await service.submit(chat["id"], "Must not run")
        assert service.queue.list() == []
    finally:
        await service.close()
        db.close()
