"""Failure and lifecycle checks at the authenticated local API seam."""
from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest
from starlette.testclient import TestClient

from audiohelper import native_stream
from audiohelper.gateways import soniox
from audiohelper.secrets import MemorySecretStore
from tests.test_native_live_ws import AUTH, packet
from tests.test_native_soniox_ws import ProviderSocket


@pytest.mark.parametrize("blocked", ["connect", "send", "finish"])
def test_network_stall_never_blocks_audio_ack_and_stop_is_incomplete(
    app: Any, secrets: MemorySecretStore, monkeypatch: pytest.MonkeyPatch, blocked: str,
) -> None:
    end_cancelled = asyncio.Event()

    class StalledSocket(ProviderSocket):
        async def send(self, message: str | bytes) -> None:
            if isinstance(message, bytes) and (blocked == "send" or not message):
                try:
                    await asyncio.Event().wait()
                finally:
                    if not message:
                        end_cancelled.set()
            await super().send(message)

    socket = StalledSocket()

    async def connect(*args: Any, **kwargs: Any) -> ProviderSocket:
        if blocked == "connect":
            await asyncio.Event().wait()
        return socket

    monkeypatch.setattr(soniox, "connect", connect)
    monkeypatch.setattr(native_stream, "FINISH_TIMEOUT_S", 0.1)
    secrets.set("soniox", "fixture-key-not-real")
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as http:
        assert http.put("/settings", headers=AUTH, json={"cloud_consent": True}).status_code == 200
        sid = http.post("/sessions", headers=AUTH, json={"title": "Stall"}).json()["id"]
        with http.websocket_connect(f"ws://127.0.0.1/sessions/{sid}/live/stream", headers=AUTH) as ws:
            ws.send_json({"type": "open", "sample_rate": 16000})
            ws.receive_json()
            for sequence in range(8):
                ws.send_bytes(packet(sequence, sequence * 8000, 8000))
                assert ws.receive_json()["type"] == "audio.saved"
            ws.send_json({"type": "end"})
            result = ws.receive_json()
            assert result["transcription_complete"] is False
            assert result["saved_samples"] == 64000
        assert http.get(f"/sessions/{sid}/live", headers=AUTH).json()["saved_samples"] == 64000
        if blocked != "connect":
            assert socket.closed
        if blocked == "finish":
            assert end_cancelled.is_set()


def test_network_reconnect_uses_current_clock_and_retains_gap(
    app: Any, secrets: MemorySecretStore, monkeypatch: pytest.MonkeyPatch,
) -> None:
    first, second = ProviderSocket(), ProviderSocket()
    reconnect = asyncio.Event()
    calls = 0

    async def connect(*args: Any, **kwargs: Any) -> ProviderSocket:
        nonlocal calls
        calls += 1
        if calls == 1:
            return first
        await reconnect.wait()
        return second

    monkeypatch.setattr(soniox, "connect", connect)
    monkeypatch.setattr(native_stream, "RECONNECT_DELAY_S", 0.01)
    secrets.set("soniox", "fixture-key-not-real")
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as http:
        assert http.put("/settings", headers=AUTH, json={"cloud_consent": True}).status_code == 200
        sid = http.post("/sessions", headers=AUTH, json={"title": "Reconnect"}).json()["id"]
        with http.websocket_connect(f"ws://127.0.0.1/sessions/{sid}/live/stream", headers=AUTH) as ws:
            ws.send_json({"type": "open", "sample_rate": 16000})
            ws.receive_json()
            ws.send_bytes(packet(0, 0))
            ws.receive_json()
            assert http.portal is not None
            http.portal.call(first.responses.put, json.dumps({"error_code": 503}))
            # Wait for the fake remote to close, with a test-side deadline.
            async def wait_closed() -> None:
                async with asyncio.timeout(1):
                    while not first.closed:
                        await asyncio.sleep(0.001)
            http.portal.call(wait_closed)
            ws.send_bytes(packet(1, 1600))
            assert ws.receive_json()["saved_samples"] == 3200
            http.portal.call(reconnect.set)
            async def wait_connected() -> None:
                async with asyncio.timeout(1):
                    while calls < 2:
                        await asyncio.sleep(0.001)
            http.portal.call(wait_connected)
            http.portal.call(asyncio.sleep, 0)
            ws.send_bytes(packet(2, 3200))
            ws.receive_json()
            ws.send_json({"type": "end"})
            assert ws.receive_json()["transcription_complete"] is False
        assert second.audio == [packet(2, 3200)[20:]]
        detail = http.get(f"/sessions/{sid}", headers=AUTH).json()
        assert [(s["start_ms"], s["end_ms"]) for s in detail["segments"]] == [(200, 300)]
