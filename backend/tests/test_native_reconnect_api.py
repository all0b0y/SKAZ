"""Local WebSocket API with a fake external Soniox socket, no paid calls."""
import asyncio
import json
from typing import Any

import pytest
from starlette.testclient import TestClient

from skaz import native_recovery
from skaz.gateways import soniox
from skaz.secrets import MemorySecretStore
from tests.test_native_live_ws import AUTH, packet
from tests.test_native_soniox_ws import ProviderSocket


def test_initial_transient_failure_retries_without_losing_captured_audio(
    app: Any, secrets: MemorySecretStore, monkeypatch: pytest.MonkeyPatch,
) -> None:
    socket = ProviderSocket()
    calls = 0

    async def connect(*args: Any, **kwargs: Any) -> ProviderSocket:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise OSError("offline fixture")
        return socket

    monkeypatch.setattr(soniox, "connect", connect)
    monkeypatch.setattr(native_recovery, "RETRY_DELAYS", (0, 0, 0))
    secrets.set("soniox", "fixture-key-not-real")
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as http:
        http.put("/settings", headers=AUTH, json={"cloud_consent": True})
        sid = http.post("/sessions", headers=AUTH, json={"title": "Recovery"}).json()["id"]
        with http.websocket_connect(f"ws://127.0.0.1/sessions/{sid}/live/stream", headers=AUTH) as ws:
            ws.send_json({"type": "open", "sample_rate": 16000})
            assert ws.receive_json()["type"] == "stream.opened"
            ws.send_bytes(packet(0, 0))
            assert ws.receive_json()["type"] == "audio.saved"
            assert http.portal is not None

            async def recovered() -> None:
                async with asyncio.timeout(1):
                    while not socket.audio:
                        await asyncio.sleep(.001)
            http.portal.call(recovered)
            ws.send_json({"type": "end"})
            assert ws.receive_json()["transcription_complete"] is True
        assert calls == 2
        assert b''.join(socket.audio) == packet(0, 0)[20:]
        assert http.get(f"/sessions/{sid}/live", headers=AUTH).json()["gaps"] == []


@pytest.mark.parametrize("overflow", [False, True])
def test_timeout_or_full_buffer_ends_recovery_and_clears_pcm(
    app: Any, secrets: MemorySecretStore, monkeypatch: pytest.MonkeyPatch, overflow: bool,
) -> None:
    calls = 0

    async def connect(*args: Any, **kwargs: Any) -> ProviderSocket:
        nonlocal calls
        calls += 1
        await asyncio.Event().wait()
        raise AssertionError("unreachable")

    monkeypatch.setattr(soniox, "connect", connect)
    monkeypatch.setattr(native_recovery, "RETRY_DELAYS", (0, 0, 0))
    monkeypatch.setattr(native_recovery, "OPEN_TIMEOUT_S", 10 if overflow else .01)
    secrets.set("soniox", "fixture-key-not-real")
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as http:
        http.put("/settings", headers=AUTH, json={"cloud_consent": True})
        sid = http.post("/sessions", headers=AUTH, json={"title": "Bound"}).json()["id"]
        with http.websocket_connect(f"ws://127.0.0.1/sessions/{sid}/live/stream", headers=AUTH) as ws:
            ws.send_json({"type": "open", "sample_rate": 16000})
            assert ws.receive_json()["type"] == "stream.opened"
            if overflow:
                for n in range(61):
                    ws.send_bytes(packet(n, n * 8000, 8000))
                    assert ws.receive_json()["type"] == "audio.saved"
            assert ws.receive_json()["type"] == "transcription.failed"
            status = http.get(f"/sessions/{sid}/live/status", headers=AUTH).json()
            assert status["buffered_audio_ms"] == 0
            assert status["state"] == "unavailable"
            assert calls == (1 if overflow else 3)
            ws.send_json({"type": "end"})
            assert ws.receive_json()["transcription_complete"] is False


@pytest.mark.parametrize("action", ["stop", "pause"])
def test_forced_stop_or_pause_cancels_connect_and_clears_audio(
    app: Any, secrets: MemorySecretStore, monkeypatch: pytest.MonkeyPatch, action: str,
) -> None:
    cancelled = asyncio.Event()
    calls = 0

    async def connect(*args: Any, **kwargs: Any) -> ProviderSocket:
        nonlocal calls
        calls += 1
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()
        raise AssertionError("unreachable")

    monkeypatch.setattr(soniox, "connect", connect)
    secrets.set("soniox", "fixture-key-not-real")
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as http:
        http.put("/settings", headers=AUTH, json={"cloud_consent": True})
        sid = http.post("/sessions", headers=AUTH, json={"title": "Cancel"}).json()["id"]
        with http.websocket_connect(f"ws://127.0.0.1/sessions/{sid}/live/stream", headers=AUTH) as ws:
            ws.send_json({"type": "open", "sample_rate": 16000})
            assert ws.receive_json()["type"] == "stream.opened"
            ws.send_bytes(packet(0, 0))
            assert ws.receive_json()["type"] == "audio.saved"
            assert http.get(f"/sessions/{sid}/live/status", headers=AUTH).json()["buffered_audio_ms"] == 100
            ws.send_json({"type": "end", "action": action})
            # Stop waits for the provider to connect and transcribe the captured
            # audio (no clock ends it); the user's "Finish now" cancels the connect.
            progress = ws.receive_json()
            assert progress["type"] == "stream.finalizing" and progress["pending_ms"] == 100
            ws.send_json({"type": "force"})
            result = ws.receive_json()
            while result["type"] == "stream.finalizing":
                result = ws.receive_json()
            assert result["transcription_complete"] is False
            assert result["status"] == ("paused" if action == "pause" else "stopped")
        assert cancelled.is_set() and calls == 1
        assert http.get(f"/sessions/{sid}/live/status", headers=AUTH).json()["buffered_audio_ms"] == 0


@pytest.mark.parametrize("code,expected_calls", [(503, 3), (401, 1), (402, 1), (403, 1)])
def test_retry_exhaustion_and_terminal_errors(
    app: Any, secrets: MemorySecretStore, monkeypatch: pytest.MonkeyPatch,
    code: int, expected_calls: int,
) -> None:
    sockets: list[ProviderSocket] = []

    async def connect(*args: Any, **kwargs: Any) -> ProviderSocket:
        socket = ProviderSocket()
        sockets.append(socket)
        await socket.responses.put(json.dumps({"error_code": code}))
        return socket

    monkeypatch.setattr(soniox, "connect", connect)
    monkeypatch.setattr(native_recovery, "RETRY_DELAYS", (0, 0, 0))
    secrets.set("soniox", "fixture-key-not-real")
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as http:
        http.put("/settings", headers=AUTH, json={"cloud_consent": True})
        sid = http.post("/sessions", headers=AUTH, json={"title": "Failure"}).json()["id"]
        with http.websocket_connect(f"ws://127.0.0.1/sessions/{sid}/live/stream", headers=AUTH) as ws:
            ws.send_json({"type": "open", "sample_rate": 16000})
            assert ws.receive_json()["type"] == "stream.opened"
            assert ws.receive_json()["type"] == "transcription.failed"
            assert len(sockets) == expected_calls
            assert all(s.closed for s in sockets)
            ws.send_json({"type": "end"})
            assert ws.receive_json()["transcription_complete"] is False


def test_midstream_replays_only_unconfirmed_audio_at_original_time(
    app: Any, secrets: MemorySecretStore, monkeypatch: pytest.MonkeyPatch,
) -> None:
    first, second = ProviderSocket(), ProviderSocket()
    sockets = iter((first, second))

    async def connect(*args: Any, **kwargs: Any) -> ProviderSocket:
        return next(sockets)

    monkeypatch.setattr(soniox, "connect", connect)
    monkeypatch.setattr(native_recovery, "RETRY_DELAYS", (0, 0, 0))
    secrets.set("soniox", "fixture-key-not-real")
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as http:
        http.put("/settings", headers=AUTH, json={"cloud_consent": True})
        sid = http.post("/sessions", headers=AUTH, json={"title": "Replay"}).json()["id"]
        with http.websocket_connect(f"ws://127.0.0.1/sessions/{sid}/live/stream", headers=AUTH) as ws:
            ws.send_json({"type": "open", "sample_rate": 16000})
            assert ws.receive_json()["type"] == "stream.opened"
            ws.send_bytes(packet(0, 0))
            assert ws.receive_json()["type"] == "audio.saved"
            assert http.portal is not None

            async def wait_audio(socket: ProviderSocket) -> None:
                async with asyncio.timeout(1):
                    while not socket.audio:
                        await asyncio.sleep(.001)
            http.portal.call(wait_audio, first)
            http.portal.call(first.responses.put, json.dumps({
                "tokens": [{"text": "Before", "start_ms": 0, "end_ms": 50,
                            "confidence": .99, "is_final": True, "language": "en"}],
                "final_audio_proc_ms": 50, "total_audio_proc_ms": 100,
            }))
            http.portal.call(first.responses.put, json.dumps({"error_code": 503}))
            http.portal.call(wait_audio, second)
            ws.send_json({"type": "end"})
            assert ws.receive_json()["transcription_complete"] is True
        assert b"".join(second.audio) == packet(0, 0)[20 + 1600:]
        detail = http.get(f"/sessions/{sid}", headers=AUTH).json()
        assert [(s["text"], s["start_ms"], s["end_ms"]) for s in detail["segments"]] == [
            ("Before", 0, 50), ("Hello", 50, 100),
        ]
        assert http.get(f"/sessions/{sid}/live", headers=AUTH).json()["gaps"] == []
