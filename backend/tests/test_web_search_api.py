"""Runtime → subprocess tools → real local HTTP consent → search transport."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from typing import Any

import httpx
import pytest

from audiohelper import repository as repo
from audiohelper.codex_schemas import CodexSettings
from audiohelper.gateways.codex_rpc import CodexRpc
from audiohelper.runtime import Runtime
from audiohelper.web_search import WebSearch


async def pending(client: httpx.AsyncClient) -> dict[str, str]:
    async with asyncio.timeout(4):
        while True:
            rows = (await client.get("/web-search/pending")).json()["requests"]
            if rows:
                return dict(rows[0])
            await asyncio.sleep(0.01)


@pytest.mark.asyncio
async def test_web_settings_auth_strict_schema_and_key_not_returned(client: httpx.AsyncClient) -> None:
    assert (
        await client.get("/web-search/settings", headers={"Authorization": "Bearer wrong"})
    ).status_code == 401
    assert (await client.put("/web-search/settings", json={"enabled": True})).status_code == 409
    assert (
        await client.put("/web-search/settings", json={"enabled": True, "endpoint": "https://evil"})
    ).status_code == 422
    result = await client.put(
        "/web-search/settings", json={"enabled": True, "api_key": "private-fixture-key"}
    )
    assert result.status_code == 200
    assert result.json() == {"provider": "brave", "enabled": True, "has_key": True, "available": True}
    assert "private-fixture-key" not in (await client.get("/web-search/settings")).text
    result = await client.put("/web-search/settings", json={"enabled": False, "api_key": ""})
    assert result.json()["has_key"] is False


@pytest.mark.asyncio
async def test_runtime_search_waits_for_exact_consent_and_followup(
    client: httpx.AsyncClient, app: Any
) -> None:
    runtime: Runtime = app.state.runtime
    sent: list[httpx.Request] = []

    def respond(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        return httpx.Response(
            200,
            json={
                "web": {
                    "results": [
                        {"title": "Source", "url": "https://example.org/source", "description": "Evidence"},
                    ]
                }
            },
        )

    runtime.web_search = WebSearch(
        runtime.db, runtime.secrets, transport_factory=lambda: httpx.MockTransport(respond)
    )
    service = runtime.codex
    service.web_search = runtime.web_search
    fixture = Path(__file__).parent / "fixtures/codex_search_server.py"
    service.connection.rpc = lambda: CodexRpc(  # type: ignore[method-assign]
        (sys.executable, str(fixture)),
        cwd=fixture.parent,
        env={},
    )
    service.connection.view.update(status="connected", models=[{"id": "fixture", "efforts": ["high"]}])
    await service.configure(
        CodexSettings(assistant_enabled=True, assistant_model="fixture", assistant_effort="high")
    )
    await client.put("/web-search/settings", json={"enabled": True, "api_key": "fixture-key"})
    session = repo.create_session(runtime.db, "PRIVATE_SESSION_MARKER")
    chat = service.chats.create(session.id, "session")
    service.chats.append(chat["id"], "user", "PRIVATE_HISTORY_MARKER", [])
    task = await service.submit(chat["id"], "PRIVATE_QUESTION_MARKER")
    try:
        first = await pending(client)
        assert sent == []
        url = f"/web-search/requests/{first['id']}/decision"
        body = {"chat_id": chat["id"], "query": first["query"], "approved": True}
        assert (await client.post(url, json={**body, "query": "rewritten"})).status_code == 409
        assert (await client.post(url, json={**body, "context": "PRIVATE"})).status_code == 422
        assert sent == []
        assert (await client.post(url, json=body)).status_code == 200
        assert (await client.post(url, json=body)).status_code == 409
        second = await pending(client)
        assert second["id"] != first["id"] and len(sent) == 1
        assert (
            await client.post(
                f"/web-search/requests/{second['id']}/decision",
                json={
                    "chat_id": chat["id"],
                    "query": second["query"],
                    "approved": False,
                },
            )
        ).status_code == 200
        await service.dispatcher.idle()
        assert service.queue.get(task["id"]).status == "completed"
        service._finalize(service.queue.get(task["id"]))
        assert "https://example.org/source" in service.chats.messages(chat["id"])[-1]["content"]
        assert len(sent) == 1 and sent[0].url.params["q"] == "approved public query"
        assert "PRIVATE" not in str(sent[0].url) + str(sent[0].headers) + str(sent[0].content)
        # Ordinary Notes never gain a web tool, even while search is enabled.
        meta = service._meta(task["id"])
        meta["kind"] = "notes"
        service._save_meta(task["id"], meta)
        assert [t.name for t in service._tools(service.queue.get(task["id"]))] == ["skaz_read_transcript"]
    finally:
        await service.close()
