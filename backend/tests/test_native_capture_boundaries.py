"""Native capture tail and privacy at the public HTTP/WebSocket boundary."""
from __future__ import annotations

import asyncio
import time
from collections.abc import Iterator
from concurrent.futures import CancelledError
from contextlib import contextmanager
from threading import Event
from typing import Any

import httpx
import pytest
from starlette.testclient import TestClient

from audiohelper.gateways import soniox
from audiohelper.secrets import MemorySecretStore
from tests.test_native_live_ws import AUTH, packet
from tests.test_native_soniox_ws import ProviderSocket


def test_submillisecond_tail_is_saved_exactly_and_resume_keeps_samples(app: Any) -> None:
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as http:
        sid = http.post("/sessions", headers=AUTH, json={"title": "Short tail"}).json()["id"]
        url = f"ws://127.0.0.1/sessions/{sid}/live/stream"
        with http.websocket_connect(url, headers=AUTH) as ws:
            ws.send_json({"type": "open", "sample_rate": 16000})
            assert ws.receive_json()["type"] == "stream.opened"
            ws.send_bytes(packet(0, 0, 1))
            assert ws.receive_json() == {
                "type": "audio.saved", "sequence": 0, "saved_samples": 1, "duplicate": False,
            }
            ws.send_json({"type": "end", "action": "pause"})
            assert ws.receive_json()["saved_samples"] == 1
        assert http.get(f"/sessions/{sid}/audio/0", headers=AUTH).content[44:] == b"\x01\x00"
        with http.websocket_connect(url, headers=AUTH) as ws:
            ws.send_json({"type": "open", "sample_rate": 16000})
            opened = ws.receive_json()
            assert (opened["saved_samples"], opened["next_sequence"]) == (1, 1)
            ws.send_bytes(packet(1, 1, 15))
            assert ws.receive_json()["saved_samples"] == 16
            ws.send_json({"type": "end"})
            assert ws.receive_json()["saved_samples"] == 16
        manifest = http.get(f"/sessions/{sid}/audio", headers=AUTH).json()
        assert [(c["start_ms"], c["end_ms"]) for c in manifest["chunks"]] == [(0, 0), (0, 1)]


@pytest.mark.parametrize("remove_key", [False, True])
@pytest.mark.parametrize("connecting", [False, True])
def test_revoking_consent_closes_provider_but_keeps_local_capture(
    app: Any, secrets: MemorySecretStore, monkeypatch: pytest.MonkeyPatch, connecting: bool, remove_key: bool,
) -> None:
    socket = ProviderSocket()
    started = asyncio.Event()
    cancelled = asyncio.Event()

    async def connect(*args: Any, **kwargs: Any) -> ProviderSocket:
        started.set()
        if connecting:
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()
        return socket

    monkeypatch.setattr(soniox, "connect", connect)
    secrets.set("soniox", "fixture-key-not-real")
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as http:
        assert http.put("/settings", headers=AUTH, json={"cloud_consent": True}).status_code == 200
        sid = http.post("/sessions", headers=AUTH, json={"title": "Revoke"}).json()["id"]
        with http.websocket_connect(f"ws://127.0.0.1/sessions/{sid}/live/stream", headers=AUTH) as ws:
            ws.send_json({"type": "open", "sample_rate": 16000})
            ws.receive_json()
            assert http.portal is not None
            http.portal.call(asyncio.wait_for, started.wait(), 1)
            if not connecting:
                deadline = time.monotonic() + 1
                while http.get(f"/sessions/{sid}/live", headers=AUTH).json()["transcription"] != "streaming":
                    assert time.monotonic() < deadline, "provider did not become ready"
                ws.send_bytes(packet(0, 0))
                assert ws.receive_json()["saved_samples"] == 1600

                async def wait_sent() -> None:
                    async with asyncio.timeout(1):
                        while not socket.audio:
                            await asyncio.sleep(0)
                http.portal.call(wait_sent)
            response = http.put("/settings", headers=AUTH, json=(
                {"provider_keys": {"soniox": ""}} if remove_key else {"cloud_consent": False}
            ))
            assert response.status_code == 200
            assert cancelled.is_set() if connecting else socket.closed
            assert http.get(f"/sessions/{sid}/live", headers=AUTH).json()["transcription"] == "unavailable"
            next_sequence = 0 if connecting else 1
            ws.send_bytes(packet(next_sequence, next_sequence * 1600))
            assert ws.receive_json()["saved_samples"] == (next_sequence + 1) * 1600
            # Repeated revoke and regrant must not resurrect this cloud worker.
            assert http.put("/settings", headers=AUTH, json={"cloud_consent": False}).status_code == 200
            assert http.put("/settings", headers=AUTH, json={"cloud_consent": True}).status_code == 200
            assert http.get(f"/sessions/{sid}/live", headers=AUTH).json()["transcription"] == "unavailable"
            ws.send_json({"type": "end"})
            assert ws.receive_json()["transcription_complete"] is False
        assert socket.audio == ([] if connecting else [packet(0, 0)[20:]])
        assert http.get(f"/sessions/{sid}/audio/0", headers=AUTH).content[44:] == packet(0, 0)[20:]


@pytest.mark.parametrize("cancel_request", [False, True])
def test_consent_write_settles_before_cancel_or_unrelated_update(
    app: Any, secrets: MemorySecretStore, monkeypatch: pytest.MonkeyPatch, cancel_request: bool,
) -> None:
    socket = ProviderSocket()
    started = asyncio.Event()

    async def connect(*args: Any, **kwargs: Any) -> ProviderSocket:
        started.set()
        return socket

    monkeypatch.setattr(soniox, "connect", connect)
    secrets.set("soniox", "fixture-key-not-real")
    saved, release, finished = Event(), Event(), Event()
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as http:
        assert http.put("/settings", headers=AUTH, json={"cloud_consent": True}).status_code == 200
        sid = http.post("/sessions", headers=AUTH, json={"title": "Cancel revoke"}).json()["id"]
        with http.websocket_connect(f"ws://127.0.0.1/sessions/{sid}/live/stream", headers=AUTH) as ws:
            ws.send_json({"type": "open", "sample_rate": 16000})
            assert ws.receive_json()["type"] == "stream.opened"
            assert http.portal is not None
            http.portal.call(asyncio.wait_for, started.wait(), 1)
            deadline = time.monotonic() + 1
            while http.get(f"/sessions/{sid}/live", headers=AUTH).json()["transcription"] != "streaming":
                assert time.monotonic() < deadline, "provider did not become ready"

            original_write = app.state.runtime.db.write

            @contextmanager
            def delayed_write() -> Iterator[Any]:
                # Actual SQLite commit; delay its return to the off-loop caller.
                with original_write() as db:
                    yield db
                if not saved.is_set():
                    saved.set()
                    assert release.wait(3), "test did not release disk completion"

            monkeypatch.setattr(app.state.runtime.db, "write", delayed_write)
            requests: list[asyncio.Task[Any]] = []

            async def update() -> None:
                task = asyncio.current_task()
                assert task is not None
                requests.append(task)
                try:
                    async with httpx.AsyncClient(
                        transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1",
                        headers=AUTH,
                    ) as client:
                        response = await client.put("/settings", json={"cloud_consent": False})
                        assert response.status_code == 200
                finally:
                    finished.set()

            future = http.portal.start_task_soon(update)
            other = None
            try:
                assert saved.wait(2), "settings write did not commit"
                if cancel_request:
                    http.portal.call(requests[0].cancel)
                else:
                    async def unrelated_update() -> None:
                        async with httpx.AsyncClient(
                            transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1",
                            headers=AUTH,
                        ) as client:
                            response = await client.put("/settings", json={"output_language": "en"})
                            assert response.status_code == 200
                    other = http.portal.start_task_soon(unrelated_update)
                    # A portal barrier lets the second request reach its first await.
                    http.portal.call(asyncio.sleep, 0)
            finally:
                release.set()
            assert finished.wait(2), "settings request did not settle"
            if cancel_request:
                with pytest.raises(CancelledError):
                    future.result(timeout=2)
            else:
                future.result(timeout=2)
                assert other is not None
                other.result(timeout=2)
            assert socket.closed
            assert http.get("/settings", headers=AUTH).json()["cloud_consent"] is False
            ws.send_bytes(packet(0, 0))
            assert ws.receive_json()["saved_samples"] == 1600
            ws.send_json({"type": "end"})
            assert ws.receive_json()["type"] == "stream.stopped"
        assert socket.audio == []


@pytest.mark.parametrize("consent", [False, True])
def test_native_cloud_consent_gates_provider_but_not_local_saving(
    app: Any, secrets: MemorySecretStore, monkeypatch: pytest.MonkeyPatch, consent: bool,
) -> None:
    calls: list[ProviderSocket] = []

    async def connect(*args: Any, **kwargs: Any) -> ProviderSocket:
        socket = ProviderSocket()
        calls.append(socket)
        return socket

    monkeypatch.setattr(soniox, "connect", connect)
    secrets.set("soniox", "fixture-key-not-real")
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as http:
        assert http.put("/settings", headers=AUTH, json={"cloud_consent": consent}).status_code == 200
        sid = http.post("/sessions", headers=AUTH, json={"title": "Consent"}).json()["id"]
        with http.websocket_connect(f"ws://127.0.0.1/sessions/{sid}/live/stream", headers=AUTH) as ws:
            ws.send_json({"type": "open", "sample_rate": 16000})
            assert ws.receive_json()["transcription"] == ("connecting" if consent else "unavailable")
            ws.send_bytes(packet(0, 0))
            assert ws.receive_json()["saved_samples"] == 1600
            ws.send_json({"type": "end"})
            assert ws.receive_json()["saved_samples"] == 1600
        assert bool(calls) is consent
        assert http.get(f"/sessions/{sid}/audio/0", headers=AUTH).content[44:] == packet(0, 0)[20:]
