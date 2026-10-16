"""QA E1: an unhandled backend error answers JSON 500 with an id and leaves the connection usable.

Before, the exception escaped the HTTP middleware; uvicorn answered 500 and then closed the
keep-alive socket, so the bridge's *next* request on it failed with "fetch failed". The test
runs a real uvicorn server and sends both requests over one kept-alive connection.
"""
from __future__ import annotations

import logging
import threading
import time
from collections.abc import Iterator
from typing import Any

import httpx
import pytest
import uvicorn

from tests.conftest import TOKEN


class _Server(uvicorn.Server):
    def install_signal_handlers(self) -> None:  # not the main thread
        pass


@pytest.fixture
def server(kb_app: Any) -> Iterator[str]:
    async def boom() -> None:
        raise OverflowError("Python int too large to convert to SQLite INTEGER")

    kb_app.add_api_route("/kb/test-boom", boom, methods=["POST"])
    config = uvicorn.Config(kb_app, host="127.0.0.1", port=0, lifespan="off", log_level="critical")
    instance = _Server(config)
    thread = threading.Thread(target=instance.run, daemon=True)
    thread.start()
    deadline = time.monotonic() + 10
    while not instance.started and time.monotonic() < deadline:
        time.sleep(0.02)
    assert instance.started
    port = instance.servers[0].sockets[0].getsockname()[1]
    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        instance.should_exit = True
        thread.join(timeout=10)


def test_unhandled_error_is_json_500_with_id_and_next_request_on_same_connection_works(
        server: str, caplog: pytest.LogCaptureFixture) -> None:
    sockets: list[Any] = []

    def remember(request: httpx.Request) -> None:
        stream = request.extensions.get("network_stream")
        if stream is not None:
            sockets.append(stream)

    with caplog.at_level(logging.ERROR), httpx.Client(
            base_url=server, headers={"Authorization": f"Bearer {TOKEN}"}, timeout=5) as client:
        failed = client.post("/kb/test-boom")
        assert failed.status_code == 500
        body = failed.json()
        assert isinstance(body["detail"], str) and body["error_id"] in body["detail"]
        assert "SQLite" not in body["detail"]  # no raw exception text to the UI
        nxt = client.get("/kb/folders")
        assert nxt.status_code in (200, 503), nxt.text  # answered, not a dropped connection
        assert nxt.headers.get("connection", "").lower() != "close"
    # The id in the answer is the id in the log, so a user report can be matched.
    assert any(body["error_id"] in record.getMessage() for record in caplog.records)


async def test_unhandled_error_in_asgi_transport_also_json(kb_app: Any) -> None:
    async def boom() -> None:
        raise RuntimeError("secret detail")

    kb_app.add_api_route("/kb/test-boom2", boom, methods=["GET"])
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=kb_app),
                                 base_url="http://127.0.0.1:8765",
                                 headers={"Authorization": f"Bearer {TOKEN}"}) as client:
        response = await client.get("/kb/test-boom2")  # the exception never reaches the client
    assert response.status_code == 500
    assert "secret" not in response.text and response.json()["error_id"].startswith("err-")
