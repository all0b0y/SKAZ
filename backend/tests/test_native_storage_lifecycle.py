"""Disk stalls and cancellation observed through the native session API."""
from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import pytest
from fastapi import FastAPI
from starlette.testclient import TestClient

from skaz.routes.sessions import delete_session
from tests.sessions_support import create_session, session_detail, session_gone
from tests.test_native_live_ws import AUTH, packet


def test_disk_sync_does_not_block_event_loop(app: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    entered, release = threading.Event(), threading.Event()
    real_accept = app.state.runtime.live_store._accept_transient

    def blocked_accept(*args: Any) -> bool:
        entered.set()
        assert release.wait(3), "test database gate timed out"
        return bool(real_accept(*args))

    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as http:
        sid = create_session(http, "Slow disk")
        with http.websocket_connect(f"ws://127.0.0.1/sessions/{sid}/live/stream", headers=AUTH) as ws:
            ws.send_json({"type": "open", "sample_rate": 16000})
            ws.receive_json()
            with monkeypatch.context() as boundary, ThreadPoolExecutor() as threads:
                boundary.setattr(app.state.runtime.live_store, "_accept_transient", blocked_accept)
                ws.send_bytes(packet(0, 0))
                assert entered.wait(1)
                health = threads.submit(http.get, "/health")
                try:
                    assert health.result(timeout=0.5).status_code == 200
                finally:
                    release.set()
            assert ws.receive_json()["saved_samples"] == 1600
            ws.send_json({"type": "end"})
            assert ws.receive_json()["type"] == "stream.stopped"
        assert http.get(f"/sessions/{sid}/live", headers=AUTH).json()["saved_samples"] == 1600


@pytest.mark.parametrize("operation", ["snapshot", "delete"])
def test_session_request_during_disk_sync_keeps_loop_responsive(
    app: FastAPI, monkeypatch: pytest.MonkeyPatch, operation: str,
) -> None:
    entered, release, request_started = threading.Event(), threading.Event(), threading.Event()
    real_accept = app.state.runtime.live_store._accept_transient

    @app.middleware("http")
    async def mark_request(request: Any, call_next: Any) -> Any:
        if request.headers.get("x-test-disk-race"):
            request_started.set()
        return await call_next(request)

    def blocked_accept(*args: Any) -> bool:
        entered.set()
        assert release.wait(3), "test database gate timed out"
        return bool(real_accept(*args))

    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as http:
        sid = create_session(http, "Disk race")
        with http.websocket_connect(f"ws://127.0.0.1/sessions/{sid}/live/stream", headers=AUTH) as ws:
            ws.send_json({"type": "open", "sample_rate": 16000})
            ws.receive_json()
            with monkeypatch.context() as boundary, ThreadPoolExecutor() as threads:
                boundary.setattr(app.state.runtime.live_store, "_accept_transient", blocked_accept)
                ws.send_bytes(packet(0, 0))
                assert entered.wait(1)
                if operation == "delete":
                    # Deletion runs on the app loop, as the speech area calls it.
                    async def deleting() -> None:
                        request_started.set()
                        await delete_session(sid, app.state.runtime)

                    assert http.portal is not None
                    pending = threads.submit(http.portal.call, deleting)
                else:
                    pending = threads.submit(http.get, f"/sessions/{sid}/live",
                                             headers={**AUTH, "x-test-disk-race": "1"})
                try:
                    assert request_started.wait(1)
                    assert threads.submit(http.get, "/health").result(timeout=0.5).status_code == 200
                    assert not pending.done(), "must wait for the durable transaction"
                finally:
                    release.set()
                result = pending.result(timeout=2)
                assert result is None if operation == "delete" else result.status_code == 200
            if operation == "snapshot":
                assert ws.receive_json()["saved_samples"] == 1600
                ws.send_json({"type": "end"})
                assert ws.receive_json()["type"] == "stream.stopped"
        if operation == "delete":
            assert session_gone(http, sid)
            assert not (app.state.runtime.config.audio_dir / sid).exists()


def test_stopped_ack_waits_for_status_commit_and_allows_immediate_resume(app: Any) -> None:
    entered, release = threading.Event(), threading.Event()

    def slow_status(statement: str) -> None:
        if "UPDATE sessions" in statement and "paused" in statement:
            entered.set()
            release.wait(3)

    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as http:
        sid = create_session(http, "Pause barrier")
        url = f"ws://127.0.0.1/sessions/{sid}/live/stream"
        with http.websocket_connect(url, headers=AUTH) as first:
            first.send_json({"type": "open", "sample_rate": 16000})
            first.receive_json()
            with app.state.runtime.db.read() as db:
                db.set_trace_callback(slow_status)
            with ThreadPoolExecutor() as threads:
                first.send_json({"type": "end", "action": "pause"})
                response = threads.submit(first.receive_json)
                try:
                    assert entered.wait(1)
                    assert not response.done(), "stopped ACK preceded durable status"
                finally:
                    release.set()
                assert response.result(timeout=2)["status"] == "paused"
            assert session_detail(http, sid)["session"]["status"] == "paused"
            with http.websocket_connect(url, headers=AUTH) as second:
                second.send_json({"type": "open", "sample_rate": 16000})
                assert second.receive_json()["type"] == "stream.opened"
                second.send_json({"type": "end"})
                assert second.receive_json()["status"] == "stopped"


def test_transcript_storage_failure_closes_idle_intake_without_next_packet(
    app: Any, secrets: Any, monkeypatch: pytest.MonkeyPatch,
) -> None:
    import json
    import time

    from skaz.gateways import soniox
    from tests.test_native_soniox_ws import ProviderSocket

    provider = ProviderSocket()

    async def connect(*args: Any, **kwargs: Any) -> ProviderSocket:
        return provider

    monkeypatch.setattr(soniox, "connect", connect)
    secrets.set("soniox", "fixture-key-not-real")
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as http:
        assert http.put("/settings", headers=AUTH, json={"cloud_consent": True}).status_code == 200
        sid = create_session(http, "Event failure")
        with http.websocket_connect(f"ws://127.0.0.1/sessions/{sid}/live/stream", headers=AUTH) as ws:
            ws.send_json({"type": "open", "sample_rate": 16000})
            ws.receive_json()
            # Local stream.opened does not assert provider readiness. Observe the
            # public state before injecting a transcript-only disk failure.
            deadline = time.monotonic() + 2
            while http.get(f"/sessions/{sid}/live", headers=AUTH).json()["transcription"] != "streaming":
                assert time.monotonic() < deadline, "fake provider did not become ready"
            ws.send_bytes(packet(0, 0))
            ws.receive_json()
            with app.state.runtime.db.read() as db:
                db.execute("PRAGMA query_only=ON")
            assert http.portal is not None
            http.portal.call(provider.responses.put, json.dumps({
                "tokens": [], "final_audio_proc_ms": 0, "total_audio_proc_ms": 0,
            }))
            with ThreadPoolExecutor() as threads:
                response = threads.submit(ws.receive_json)
                try:
                    assert response.result(timeout=1) == {"type": "stream.error", "code": "storage_failed"}
                finally:
                    with app.state.runtime.db.read() as db:
                        db.execute("PRAGMA query_only=OFF")
                    if not response.done():
                        ws.send_json({"type": "end"})
