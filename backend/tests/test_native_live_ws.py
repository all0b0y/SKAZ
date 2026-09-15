"""Local WebSocket contract; no provider, microphone or real user profile."""
from __future__ import annotations

import struct
from typing import Any

import pytest
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from tests.conftest import TOKEN

AUTH = {"Authorization": f"Bearer {TOKEN}"}


def packet(sequence: int, start: int, samples: int = 1600) -> bytes:
    return struct.pack("!QQI", sequence, start, samples) + b"\x01\x00" * samples


def test_ws_saves_pcm_without_asr_and_resume_keeps_sample_clock(app: Any) -> None:
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as http:
        session_id = http.post("/sessions", headers=AUTH, json={"title": "Offline"}).json()["id"]
        url = f"ws://127.0.0.1/sessions/{session_id}/live/stream"
        with http.websocket_connect(url, headers=AUTH) as ws:
            ws.send_json({"type": "open", "sample_rate": 16000})
            opened = ws.receive_json()
            assert opened["type"] == "stream.opened"
            assert opened["saved_samples"] == 0
            ws.send_bytes(packet(0, 0))
            assert ws.receive_json() == {
                "type": "audio.saved", "sequence": 0, "saved_samples": 1600, "duplicate": False,
            }
            ws.send_bytes(packet(0, 0))
            assert ws.receive_json()["duplicate"] is True
            ws.send_json({"type": "end"})
            ended = ws.receive_json()
            assert ended["type"] == "stream.stopped"
            assert ended["transcription_complete"] is False
        snapshot = http.get(f"/sessions/{session_id}/live", headers=AUTH).json()
        assert snapshot["saved_samples"] == 1600
        assert snapshot["connections"][0]["status"] == "incomplete"
        assert http.get(f"/sessions/{session_id}/audio/0", headers=AUTH).content[44:] == packet(0, 0)[20:]
        with http.websocket_connect(url, headers=AUTH) as ws:
            ws.send_json({"type": "open", "sample_rate": 16000})
            opened = ws.receive_json()
            assert opened["saved_samples"] == 1600
            assert opened["next_sequence"] == 1
            ws.send_bytes(packet(1, 1600))
            assert ws.receive_json()["saved_samples"] == 3200
            ws.send_json({"type": "end"})
            ws.receive_json()


@pytest.mark.parametrize("headers", [
    {}, {"Authorization": "Bearer wrong"},
    {**AUTH, "Origin": "https://evil.example"},
    {**AUTH, "Host": "evil.example"},
])
def test_ws_rejects_unauthorized_handshakes(app: Any, headers: dict[str, str]) -> None:
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as http:
        session_id = http.post("/sessions", headers=AUTH, json={"title": "Protected"}).json()["id"]
        with (
            pytest.raises(WebSocketDisconnect) as denied,
            http.websocket_connect(f"ws://127.0.0.1/sessions/{session_id}/live/stream", headers=headers),
        ):
            pytest.fail("unauthorized connection accepted")
        assert denied.value.code == 1008
