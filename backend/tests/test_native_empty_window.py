"""Replay-buffer regression through WS/HTTP, with a scripted empty ASR result."""
from __future__ import annotations

import time
from typing import Any

import pytest
from starlette.testclient import TestClient

from skaz import asr_providers
from skaz.gateways.whisper_stream import StreamSettings, WhisperStreamSession
from tests.test_native_live_ws import AUTH, packet
from tests.test_whisper_progress import ContinuousSpeech, RevisingDecoder


def test_empty_completed_windows_release_replay_and_allow_long_capture(
    app: Any, monkeypatch: pytest.MonkeyPatch,
) -> None:
    def opener(runtime: Any, settings: Any, connection: Any, target: Any) -> Any:
        async def open_local() -> WhisperStreamSession:
            return WhisperStreamSession(
                StreamSettings(sample_rate=connection.sample_rate, label="Local Whisper"),
                decoder=RevisingDecoder(empty=True), vad=ContinuousSpeech(),
            )
        return open_local

    monkeypatch.setattr(asr_providers, "_local_opener", opener)
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as http:
        http.put("/settings", headers=AUTH, json={"transcription_provider": "local-whisper"})
        sid = http.post("/sessions", headers=AUTH, json={"title": "Empty window regression"}).json()["id"]
        with http.websocket_connect(f"ws://127.0.0.1/sessions/{sid}/live/stream", headers=AUTH) as ws:
            ws.send_json({"type": "open", "sample_rate": 16000})
            assert ws.receive_json()["type"] == "stream.opened"
            for second in range(60):
                for frame in range(10):
                    sequence = second * 10 + frame
                    ws.send_bytes(packet(sequence, sequence * 1600))
                    reply = ws.receive_json()
                    assert reply["type"] == "audio.saved", (second, reply)
                deadline = time.monotonic() + 2
                while True:
                    snapshot = http.get(f"/sessions/{sid}/live", headers=AUTH).json()
                    connection = snapshot["connections"][-1]
                    if connection["processed_sample"] >= (second + 1) * 16000:
                        break
                    assert time.monotonic() < deadline, "ASR stopped advancing during capture"
                    time.sleep(0.005)
                assert connection["status"] == "active"
                assert snapshot["saved_samples"] - connection["final_sample"] < 30 * 16000
            ws.send_json({"type": "end"})
            assert ws.receive_json()["type"] == "stream.stopped"
        deadline = time.monotonic() + 2
        while http.get(f"/sessions/{sid}/live/status", headers=AUTH).json()["processing"]:
            assert time.monotonic() < deadline
            time.sleep(0.005)
        snapshot = http.get(f"/sessions/{sid}/live", headers=AUTH).json()
        assert snapshot["saved_samples"] == 960000
        assert snapshot["connections"][-1]["final_sample"] == 960000
        assert snapshot["connections"][-1]["status"] == "finished"
        assert snapshot["gaps"] == []
        assert snapshot["final_tokens"] == []  # No invented speech to drive progress.
