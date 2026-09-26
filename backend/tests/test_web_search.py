"""Search egress/approval contracts; HTTP fixtures are not live search acceptance."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import httpx
import pytest

from audiohelper.db import Database
from audiohelper.secrets import MemorySecretStore
from audiohelper.web_search import WebSearch


async def wait_pending(service: WebSearch) -> None:
    async with asyncio.timeout(2):
        while not service.pending():
            await asyncio.sleep(0.001)


def test_query_only_approval_egress(tmp_path: Path) -> None:
    async def run() -> None:
        sent: list[httpx.Request] = []

        def respond(request: httpx.Request) -> httpx.Response:
            sent.append(request)
            return httpx.Response(
                200,
                json={
                    "web": {
                        "results": [
                            {
                                "title": "Source",
                                "url": "https://example.org/source",
                                "description": "Evidence",
                            },
                            {"title": "Bad", "url": "javascript:alert(1)", "description": "unsafe"},
                        ]
                    }
                },
            )

        db = Database(tmp_path / "app.sqlite")
        service = WebSearch(db, MemorySecretStore(), transport_factory=lambda: httpx.MockTransport(respond))
        await service.configure(enabled=True, key="test-key")
        query = '  точный "запрос" & x=y  '
        task = asyncio.create_task(service.request("task", "chat", query, lambda: None))
        await wait_pending(service)
        pending = service.pending()
        assert len(pending) == 1 and sent == []
        identity = pending[0]["id"]
        with pytest.raises(ValueError):
            service.decide(identity, "chat", query.strip(), True)
        assert sent == []
        service.decide(identity, "chat", query, True)
        with pytest.raises(ValueError):
            service.decide(identity, "chat", query, True)
        result = json.loads(await task)
        assert result["results"] == [
            {"title": "Source", "url": "https://example.org/source", "description": "Evidence"}
        ]
        assert len(sent) == 1
        request = sent[0]
        assert request.url.host == "api.search.brave.com"
        assert dict(request.url.params) == {
            "q": query,
            "count": "5",
            "spellcheck": "false",
            "text_decorations": "false",
        }
        assert request.content == b""
        assert request.headers["X-Subscription-Token"] == "test-key"
        assert not any(h in request.headers for h in ("cookie", "referer", "authorization"))
        assert service.pending() == []
        db.close()

    asyncio.run(run())


@pytest.mark.asyncio
async def test_deny_cancel_timeout_and_disable_never_send(tmp_path: Path) -> None:
    sent: list[httpx.Request] = []

    def respond(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        return httpx.Response(200, json={"web": {"results": []}})

    db = Database(tmp_path / "app.sqlite")
    service = WebSearch(db, MemorySecretStore(), transport_factory=lambda: httpx.MockTransport(respond))
    await service.configure(enabled=True, key="fixture")
    for action in ("deny", "cancel", "disable"):
        task = asyncio.create_task(service.request("task", "chat", "query", lambda: None))
        await wait_pending(service)
        p = service.pending()[0]
        if action == "deny":
            service.decide(p["id"], "chat", "query", False)
            assert json.loads(await task)["status"] == "declined"
        elif action == "cancel":
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        else:
            await service.configure(enabled=False)
            assert json.loads(await task)["status"] == "declined"
        assert service.pending() == []
        with pytest.raises(ValueError):
            service.decide(p["id"], "chat", "query", True)
    await service.configure(enabled=True)
    with pytest.raises(TimeoutError):
        await service.request("task", "chat", "query", lambda: None, approval_timeout=0.001)
    assert sent == []
    assert service.pending() == []
    # Approval never survives a restart; the saved preference does.
    reopened = WebSearch(db, service.secrets)
    assert reopened.view()["enabled"] is True and reopened.pending() == []
    db.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [302, 401, 429, 500])
async def test_errors_no_retry_redirect_or_provider_error_leak(tmp_path: Path, status: int) -> None:
    sent: list[httpx.Request] = []

    def respond(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        return httpx.Response(
            status, headers={"location": "https://evil.test"}, content=b"private provider error"
        )

    db = Database(tmp_path / "app.sqlite")
    service = WebSearch(db, MemorySecretStore(), transport_factory=lambda: httpx.MockTransport(respond))
    await service.configure(enabled=True, key="fixture")
    task = asyncio.create_task(service.request("task", "chat", "query", lambda: None))
    await wait_pending(service)
    p = service.pending()[0]
    service.decide(p["id"], "chat", "query", True)
    with pytest.raises(ValueError, match="Search failed; nothing retried"):
        await task
    assert len(sent) == 1 and not service.pending()
    db.close()


@pytest.mark.asyncio
async def test_revocation_and_extra_context_refused(tmp_path: Path) -> None:
    db = Database(tmp_path / "app.sqlite")
    service = WebSearch(db, MemorySecretStore())
    await service.configure(enabled=True, key="fixture")
    revoked = False

    def validate() -> None:
        if revoked:
            raise ValueError("revoked")

    task = asyncio.create_task(service.request("task", "chat", "query", validate))
    await wait_pending(service)
    p = service.pending()[0]
    with pytest.raises(ValueError):
        service.decide(p["id"], "other-chat", "query", True)
    revoked = True
    service.decide(p["id"], "chat", "query", True)
    with pytest.raises(ValueError, match="revoked"):
        await task
    for bad in ("", "\nquery", "x" * 401):
        with pytest.raises(ValueError):
            await service.request("task", "chat", bad, lambda: None)
    db.close()
