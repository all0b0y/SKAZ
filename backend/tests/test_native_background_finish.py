"""Background local finalization through the real authenticated WS/HTTP API."""
from __future__ import annotations

import asyncio
import threading
import time
from typing import Any

import pytest
from starlette.testclient import TestClient

from skaz import asr_providers
from tests.test_native_live_ws import AUTH, packet
from tests.test_transcription_providers_api import scripted_local_opener


@pytest.mark.parametrize("action", ["stop", "pause"])
def test_stop_during_model_load_keeps_audio_until_background_completion(
    app: Any, monkeypatch: Any, action: str,
) -> None:
    release = threading.Event()

    def delayed(runtime: Any, settings: Any, connection: Any, target: Any) -> Any:
        open_ready = scripted_local_opener(runtime, settings, connection, target)

        async def open_local() -> Any:
            while not release.is_set():
                await asyncio.sleep(0.01)
            return await open_ready()
        return open_local

    monkeypatch.setattr(asr_providers, "_local_opener", delayed)
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as http:
        http.put("/settings", headers=AUTH, json={"transcription_provider": "local-whisper"})
        sid = http.post("/sessions", headers=AUTH, json={"title": "Background tail"}).json()["id"]
        url = f"ws://127.0.0.1/sessions/{sid}/live/stream"
        with http.websocket_connect(url, headers=AUTH) as ws:
            ws.send_json({"type": "open", "sample_rate": 16000})
            assert ws.receive_json()["type"] == "stream.opened"
            ws.send_bytes(packet(0, 0))
            assert ws.receive_json()["type"] == "audio.saved"
            start = time.monotonic()
            ws.send_json({"type": "end", "action": action})
            stopped = ws.receive_json()
            assert time.monotonic() - start < 1
            assert stopped["type"] == "stream.stopped"
            assert stopped["transcription_pending"] is True
            assert stopped["transcription_complete"] is False
        expected = "stopped" if action == "stop" else "paused"
        assert http.get(f"/sessions/{sid}", headers=AUTH).json()["session"]["status"] == expected
        status = http.get(f"/sessions/{sid}/live/status", headers=AUTH).json()
        assert status["processing"] is True
        with http.websocket_connect(url, headers=AUTH) as ws:
            ws.send_json({"type": "open", "sample_rate": 16000})
            assert ws.receive_json()["type"] == "stream.error"
        if action == "stop":
            time.sleep(3.1)
            assert http.get(f"/sessions/{sid}/live/status", headers=AUTH).json()["processing"] is True
        release.set()
        for _ in range(200):
            status = http.get(f"/sessions/{sid}/live/status", headers=AUTH).json()
            if not status["processing"]:
                break
            time.sleep(0.01)
        assert status["processing"] is False
        snapshot = http.get(f"/sessions/{sid}/live", headers=AUTH).json()
        assert snapshot["gaps"] == []
        assert snapshot["connections"][0]["status"] == "finished"
        assert snapshot["connections"][0]["final_sample"] == 1600
        with http.websocket_connect(url, headers=AUTH) as ws:
            ws.send_json({"type": "open", "sample_rate": 16000})
            assert ws.receive_json()["type"] == "stream.opened"
            ws.send_json({"type": "end"})
            assert ws.receive_json()["type"] == "stream.stopped"


@pytest.mark.parametrize("outcome", ["timeout", "failure", "delete"])
def test_background_failure_and_deletion_release_ownership_without_claiming_success(
    app: Any, monkeypatch: Any, outcome: str,
) -> None:
    from skaz.gateways import LiveAsrError

    release = threading.Event()

    def delayed(*args: Any) -> Any:
        async def open_local() -> Any:
            while not release.is_set():
                await asyncio.sleep(0.01)
            raise LiveAsrError("Local decoder failed.", retryable=False)
        return open_local

    monkeypatch.setattr(asr_providers, "_local_opener", delayed)
    if outcome == "timeout":
        monkeypatch.setattr("skaz.native_finalization.LOCAL_FINISH_TIMEOUT_S", 0.05)
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as http:
        http.put("/settings", headers=AUTH, json={"transcription_provider": "local-whisper"})
        sid = http.post("/sessions", headers=AUTH, json={"title": "Incomplete tail"}).json()["id"]
        with http.websocket_connect(f"ws://127.0.0.1/sessions/{sid}/live/stream", headers=AUTH) as ws:
            ws.send_json({"type": "open", "sample_rate": 16000})
            assert ws.receive_json()["type"] == "stream.opened"
            ws.send_bytes(packet(0, 0))
            assert ws.receive_json()["type"] == "audio.saved"
            ws.send_json({"type": "end"})
            assert ws.receive_json()["transcription_pending"] is True
        if outcome == "delete":
            assert http.delete(f"/sessions/{sid}", headers=AUTH).status_code == 200
            assert http.get(f"/sessions/{sid}", headers=AUTH).status_code == 404
            return
        if outcome == "failure":
            release.set()
        for _ in range(200):
            status = http.get(f"/sessions/{sid}/live/status", headers=AUTH).json()
            if not status["processing"]:
                break
            time.sleep(0.01)
        assert status["processing"] is False
        assert status["incomplete"] is True
        snapshot = http.get(f"/sessions/{sid}/live", headers=AUTH).json()
        assert snapshot["connections"][0]["status"] == "incomplete"
        assert snapshot["gaps"] == [{"start_sample": 0, "end_sample": 1600}]
