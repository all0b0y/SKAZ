"""Production local WS and Soniox gateway, fake external socket only."""
from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest
from starlette.testclient import TestClient

from audiohelper.gateways import soniox
from audiohelper.secrets import MemorySecretStore
from tests.test_native_live_ws import AUTH, packet


class ProviderSocket:
    def __init__(self) -> None:
        self.responses: asyncio.Queue[str] = asyncio.Queue()
        self.audio: list[bytes] = []
        self.closed = False

    async def send(self, message: str | bytes) -> None:
        if isinstance(message, str):
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
def test_connect_delay_does_not_block_storage_or_backfill_audio(
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
        assert http.put("/settings", headers=AUTH, json={
            "native_recording_mode": mode, "translation_target_language": "de",
            "used_languages": ["ru", "en"],
        }).status_code == 200
        with http.websocket_connect(f"ws://127.0.0.1/sessions/{sid}/live/stream", headers=AUTH) as ws:
            ws.send_json({"type": "open", "sample_rate": 16000})
            ws.receive_json()
            ws.send_bytes(packet(0, 0))
            assert ws.receive_json()["saved_samples"] == 1600
            assert socket.audio == []
            assert http.put("/settings", headers=AUTH, json={
                "native_recording_mode": "audio_only", "translation_target_language": "fr",
                "used_languages": ["fr"],
            }).status_code == 200
            assert http.portal is not None
            http.portal.call(ready.set)
            http.portal.call(asyncio.sleep, 0)
            # A local transport replay remains idempotent across ASR rotation.
            ws.send_bytes(packet(0, 0))
            assert ws.receive_json().get("duplicate") is True
            ws.send_bytes(packet(1, 1600))
            assert ws.receive_json()["saved_samples"] == 3200
            ws.send_json({"type": "end"})
            assert ws.receive_json()["transcription_complete"] is False
        assert socket.audio == [packet(1, 1600)[20:]]
        detail = http.get(f"/sessions/{sid}", headers=AUTH).json()
        assert [(s["start_ms"], s["end_ms"]) for s in detail["segments"]] == [(100, 200)]
        snapshot = http.get(f"/sessions/{sid}/live", headers=AUTH).json()
        assert snapshot["connections"][0]["status"] == "incomplete"
        assert snapshot["connections"][1]["start_sample"] == 1600
        assert snapshot["gaps"] == [{"start_sample": 0, "end_sample": 1600}]
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


