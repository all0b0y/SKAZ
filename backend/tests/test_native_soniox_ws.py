"""Production local WS and Soniox gateway, fake external socket only."""
from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest
from starlette.testclient import TestClient

from skaz.gateways import soniox
from skaz.secrets import MemorySecretStore
from tests.test_native_live_ws import AUTH, packet


class ProviderSocket:
    def __init__(self) -> None:
        self.responses: asyncio.Queue[str] = asyncio.Queue()
        self.audio: list[bytes] = []
        self.closed = False

    async def send(self, message: str | bytes) -> None:
        if isinstance(message, str) and message:
            return
        if message:
            self.audio.append(message)
        else:
            duration = sum(len(frame) // 32 for frame in self.audio)
            await self.responses.put(json.dumps({
                "tokens": [{"text": "Hello", "start_ms": 0, "end_ms": duration,
                            "confidence": 0.99, "is_final": True, "language": "en"}],
                "final_audio_proc_ms": duration, "total_audio_proc_ms": duration, "finished": True,
            }))

    async def recv(self) -> str:
        return await self.responses.get()

    async def close(self) -> None:
        self.closed = True


def test_auth_failure_warns_once_and_allows_explicit_retry(
    app: Any, secrets: MemorySecretStore, monkeypatch: pytest.MonkeyPatch,
) -> None:
    attempts = 0
    socket = ProviderSocket()

    async def connect(*args: Any, **kwargs: Any) -> ProviderSocket:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            denied = ProviderSocket()
            await denied.responses.put(json.dumps({"error_code": 401}))
            return denied
        return socket

    monkeypatch.setattr(soniox, "connect", connect)
    secrets.set("soniox", "fixture-key-not-real")
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as http:
        http.put("/settings", headers=AUTH, json={"cloud_consent": True})
        sid = http.post("/sessions", headers=AUTH, json={"title": "Retry"}).json()["id"]
        url = f"ws://127.0.0.1/sessions/{sid}/live/stream"
        with http.websocket_connect(url, headers=AUTH) as ws:
            ws.send_json({"type": "open", "sample_rate": 16000})
            assert ws.receive_json()["type"] == "stream.opened"
            # The warning names the provider's sanitized reason, never raw provider text.
            assert ws.receive_json() == {
                "type": "transcription.failed", "reason": "Soniox request failed (HTTP 401).",
            }
            ws.send_bytes(packet(0, 0))  # the captured tail still receives an ACK
            assert ws.receive_json()["type"] == "audio.saved"
            ws.send_json({"type": "end"})
            assert ws.receive_json()["type"] == "stream.stopped"
        assert attempts == 1
        with http.websocket_connect(url, headers=AUTH) as ws:
            ws.send_json({"type": "open", "sample_rate": 16000})
            opened = ws.receive_json()
            assert opened["transcription"] == "connecting"
            assert http.portal is not None
            http.portal.call(asyncio.sleep, 0)
            ws.send_bytes(packet(opened["next_sequence"], opened["saved_samples"]))
            assert ws.receive_json()["type"] == "audio.saved"
            ws.send_json({"type": "end"})
            assert ws.receive_json()["type"] == "stream.stopped"
        assert attempts == 2
        assert http.get(f"/sessions/{sid}", headers=AUTH).json()["segments"][0]["text"] == "Hello"


def test_native_ws_forwards_once_and_persists_final_before_stop(
    app: Any, secrets: MemorySecretStore, monkeypatch: pytest.MonkeyPatch,
) -> None:
    sockets: list[ProviderSocket] = []

    async def connect(*args: Any, **kwargs: Any) -> ProviderSocket:
        socket = ProviderSocket()
        sockets.append(socket)
        return socket

    monkeypatch.setattr(soniox, "connect", connect)
    secrets.set("soniox", "fixture-key-not-real")
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as http:
        assert http.put("/settings", headers=AUTH, json={"cloud_consent": True}).status_code == 200
        sid = http.post("/sessions", headers=AUTH, json={"title": "Native"}).json()["id"]
        url = f"ws://127.0.0.1/sessions/{sid}/live/stream"
        with http.websocket_connect(url, headers=AUTH) as ws:
            ws.send_json({"type": "open", "sample_rate": 16000})
            assert ws.receive_json()["transcription"] == "connecting"
            # A portal barrier waits for provider setup, not an arbitrary sleep.
            assert http.portal is not None
            http.portal.call(asyncio.sleep, 0)
            ws.send_bytes(packet(0, 0))
            assert ws.receive_json()["type"] == "audio.saved"
            ws.send_bytes(packet(0, 0))
            assert ws.receive_json()["duplicate"] is True
            ws.send_json({"type": "end"})
            assert ws.receive_json()["transcription_complete"] is True
        assert sockets[0].audio == [packet(0, 0)[20:]]
        assert sockets[0].closed
        detail = http.get(f"/sessions/{sid}", headers=AUTH).json()
        assert [(s["text"], s["start_ms"], s["end_ms"]) for s in detail["segments"]] == [
            ("Hello", 0, 100),
        ]
        snapshot = http.get(f"/sessions/{sid}/live", headers=AUTH).json()
        assert snapshot["connections"][-1]["status"] == "finished"


@pytest.mark.parametrize("mode", ["transcription", "translation"])
def test_connect_delay_retains_audio_without_blocking_storage(
    app: Any, secrets: MemorySecretStore, monkeypatch: pytest.MonkeyPatch,
    mode: str,
) -> None:
    ready = asyncio.Event()
    socket = ProviderSocket()

    async def connect(*args: Any, **kwargs: Any) -> ProviderSocket:
        await ready.wait()
        return socket

    monkeypatch.setattr(soniox, "connect", connect)
    secrets.set("soniox", "fixture-key-not-real")
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as http:
        assert http.put("/settings", headers=AUTH, json={"cloud_consent": True}).status_code == 200
        sid = http.post("/sessions", headers=AUTH, json={"title": "Delayed"}).json()["id"]
        assert (
            http.put(
                "/settings",
                headers=AUTH,
                json={
                    "native_recording_mode": mode,
                    "translation_target_language": "de",
                    "used_languages": ["ru", "en"],
                },
            ).status_code
            == 200
        )
        with http.websocket_connect(f"ws://127.0.0.1/sessions/{sid}/live/stream", headers=AUTH) as ws:
            ws.send_json({"type": "open", "sample_rate": 16000})
            ws.receive_json()
            ws.send_bytes(packet(0, 0))
            assert ws.receive_json()["saved_samples"] == 1600
            assert socket.audio == []
            assert (
                http.put(
                    "/settings",
                    headers=AUTH,
                    json={
                        "native_recording_mode": "transcription" if mode == "translation" else "translation",
                        "translation_target_language": "fr",
                        "used_languages": ["fr"],
                    },
                ).status_code
                == 200
            )
            assert http.portal is not None
            http.portal.call(ready.set)
            http.portal.call(asyncio.sleep, 0)
            # A local transport replay remains idempotent across ASR rotation.
            ws.send_bytes(packet(0, 0))
            assert ws.receive_json().get("duplicate") is True
            ws.send_bytes(packet(1, 1600))
            assert ws.receive_json()["saved_samples"] == 3200
            ws.send_json({"type": "end"})
            assert ws.receive_json()["transcription_complete"] is True
        assert b"".join(socket.audio) == packet(0, 0)[20:] + packet(1, 1600)[20:]
        detail = http.get(f"/sessions/{sid}", headers=AUTH).json()
        assert [(s["start_ms"], s["end_ms"]) for s in detail["segments"]] == [(0, 200)]
        snapshot = http.get(f"/sessions/{sid}/live", headers=AUTH).json()
        assert len(snapshot["connections"]) == 1
        assert snapshot["connections"][0]["status"] == "finished"
        assert snapshot["gaps"] == []
        assert snapshot["transcription"] == "inactive"
        assert snapshot["recording_mode"] == mode
        assert snapshot["translation_target_language"] == "de"
        assert snapshot["used_languages"] == ["ru", "en"]


def test_delete_active_stream_closes_provider_before_removing_data(
    app: Any, secrets: MemorySecretStore, monkeypatch: pytest.MonkeyPatch,
) -> None:
    socket = ProviderSocket()

    async def connect(*args: Any, **kwargs: Any) -> ProviderSocket:
        return socket

    monkeypatch.setattr(soniox, "connect", connect)
    secrets.set("soniox", "fixture-key-not-real")
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as http:
        assert http.put("/settings", headers=AUTH, json={"cloud_consent": True}).status_code == 200
        sid = http.post("/sessions", headers=AUTH, json={"title": "Delete"}).json()["id"]
        with http.websocket_connect(f"ws://127.0.0.1/sessions/{sid}/live/stream", headers=AUTH) as ws:
            ws.send_json({"type": "open", "sample_rate": 16000})
            ws.receive_json()
            ws.send_bytes(packet(0, 0))
            ws.receive_json()
            assert http.delete(f"/sessions/{sid}", headers=AUTH).status_code == 200
            assert socket.closed
            assert http.get(f"/sessions/{sid}", headers=AUTH).status_code == 404




class MillisecondProviderSocket(ProviderSocket):
    """Reports progress in whole milliseconds, as the provider protocol does."""

    def __init__(self, rate: int) -> None:
        super().__init__()
        self.rate = rate

    async def send(self, message: str | bytes) -> None:
        if isinstance(message, str) and message:
            return
        if message:
            self.audio.append(message)
            return
        duration = sum(len(frame) // 2 for frame in self.audio) * 1000 // self.rate
        await self.responses.put(json.dumps({
            "tokens": [{"text": "Hello", "start_ms": 0, "end_ms": duration,
                        "confidence": 0.99, "is_final": True, "language": "en"}],
            "final_audio_proc_ms": duration, "total_audio_proc_ms": duration, "finished": True,
        }))


def test_stop_after_a_tail_shorter_than_a_millisecond_is_complete(
    app: Any, secrets: MemorySecretStore, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The recorder flushes an arbitrary-length tail on Stop (Web Audio quanta are 128
    samples). A provider clock in whole milliseconds cannot name its last fraction
    of a millisecond; that rounding is not untranscribed audio."""
    socket = MillisecondProviderSocket(48_000)

    async def connect(*args: Any, **kwargs: Any) -> ProviderSocket:
        return socket

    monkeypatch.setattr(soniox, "connect", connect)
    secrets.set("soniox", "fixture-key-not-real")
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as http:
        http.put("/settings", headers=AUTH, json={"cloud_consent": True})
        sid = http.post("/sessions", headers=AUTH, json={"title": "Tail"}).json()["id"]
        with http.websocket_connect(f"ws://127.0.0.1/sessions/{sid}/live/stream", headers=AUTH) as ws:
            ws.send_json({"type": "open", "sample_rate": 48_000})
            assert ws.receive_json()["transcription"] == "connecting"
            ws.send_bytes(packet(0, 0, 4800))
            assert ws.receive_json()["saved_samples"] == 4800
            ws.send_bytes(packet(1, 4800, 1_000))  # ~20.8 ms: not a whole millisecond
            assert ws.receive_json()["saved_samples"] == 5800
            assert http.portal is not None
            http.portal.call(asyncio.sleep, 0.05)
            ws.send_json({"type": "end"})
            assert ws.receive_json()["transcription_complete"] is True
        snapshot = http.get(f"/sessions/{sid}/live", headers=AUTH).json()
        assert snapshot["connections"][0]["status"] == "finished"
        assert snapshot["gaps"] == []


class RoundingUpProviderSocket(MillisecondProviderSocket):
    async def send(self, message: str | bytes) -> None:
        if isinstance(message, str) and message:
            return
        if message:
            self.audio.append(message)
            return
        samples = sum(len(frame) // 2 for frame in self.audio)
        duration = -(-samples * 1000 // self.rate)  # ceil: the provider rounds its clock up
        await self.responses.put(json.dumps({
            "tokens": [{"text": "Hello", "start_ms": 0, "end_ms": duration,
                        "confidence": 0.99, "is_final": True, "language": "en"}],
            "final_audio_proc_ms": duration, "total_audio_proc_ms": duration, "finished": True,
        }))


def _record_and_stop(http: Any, socket: ProviderSocket, rate: int, sizes: list[int]) -> dict[str, Any]:
    sid = http.post("/sessions", headers=AUTH, json={"title": "Stop"}).json()["id"]
    with http.websocket_connect(f"ws://127.0.0.1/sessions/{sid}/live/stream", headers=AUTH) as ws:
        ws.send_json({"type": "open", "sample_rate": rate})
        assert ws.receive_json()["type"] == "stream.opened"
        start = 0
        for sequence, size in enumerate(sizes):
            ws.send_bytes(packet(sequence, start, size))
            assert ws.receive_json()["type"] == "audio.saved"
            start += size
        assert http.portal is not None
        http.portal.call(asyncio.sleep, 0.05)
        ws.send_json({"type": "end"})
        return dict(ws.receive_json())


def test_stop_is_complete_when_the_provider_rounds_its_last_millisecond_up(
    app: Any, secrets: MemorySecretStore, monkeypatch: pytest.MonkeyPatch,
) -> None:
    socket = RoundingUpProviderSocket(48_000)

    async def connect(*args: Any, **kwargs: Any) -> ProviderSocket:
        return socket

    monkeypatch.setattr(soniox, "connect", connect)
    secrets.set("soniox", "fixture-key-not-real")
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as http:
        http.put("/settings", headers=AUTH, json={"cloud_consent": True})
        stopped = _record_and_stop(http, socket, 48_000, [4800, 1_000])
    assert stopped.get("transcription_detail") is None, stopped
    assert stopped["transcription_complete"] is True
    assert "transcription_detail" not in stopped


def test_incomplete_stop_names_its_reason(
    app: Any, secrets: MemorySecretStore, monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Silent(ProviderSocket):
        async def send(self, message: str | bytes) -> None:
            if isinstance(message, bytes) and message:
                self.audio.append(message)  # never answers the end of stream

    socket = Silent()

    async def connect(*args: Any, **kwargs: Any) -> ProviderSocket:
        return socket

    monkeypatch.setattr(soniox, "connect", connect)
    monkeypatch.setattr("skaz.native_stream.FINISH_TIMEOUT_S", 0.3)
    monkeypatch.setattr(soniox, "FINALIZATION_TIMEOUT_S", 0.2)
    secrets.set("soniox", "fixture-key-not-real")
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as http:
        http.put("/settings", headers=AUTH, json={"cloud_consent": True})
        stopped = _record_and_stop(http, socket, 16_000, [1600])
    assert stopped["transcription_complete"] is False
    assert stopped["transcription_detail"].startswith("Soniox")
