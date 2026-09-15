"""Error boundaries for the native PCM WebSocket."""
from __future__ import annotations

import os
import struct
from typing import Any

import pytest
from starlette.testclient import TestClient

from tests.test_native_live_ws import AUTH, packet


@pytest.mark.parametrize("data", [b"short", packet(1, 0), packet(0, 0)[:-2],
                                  packet(0, 0, 16000), packet(2**63, 0)])
def test_bad_packet_never_acknowledges_or_extends_recording(app: Any, data: bytes) -> None:
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as http:
        identity = http.post("/sessions", headers=AUTH, json={"title": "Bad packet"}).json()["id"]
        with http.websocket_connect(f"ws://127.0.0.1/sessions/{identity}/live/stream", headers=AUTH) as ws:
            ws.send_json({"type": "open", "sample_rate": 16000})
            ws.receive_json()
            ws.send_bytes(data)
            assert ws.receive_json() == {"type": "stream.error", "code": "invalid_stream"}
        assert http.get(f"/sessions/{identity}/live", headers=AUTH).json()["saved_samples"] == 0


def test_binary_configuration_is_rejected_without_internal_exception(app: Any) -> None:
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as http:
        identity = http.post("/sessions", headers=AUTH, json={"title": "Bad hello"}).json()["id"]
        with http.websocket_connect(f"ws://127.0.0.1/sessions/{identity}/live/stream", headers=AUTH) as ws:
            ws.send_bytes(struct.pack("!I", 7))
            assert ws.receive_json() == {"type": "stream.error", "code": "invalid_stream"}
        assert http.get(f"/sessions/{identity}/live", headers=AUTH).status_code == 404


def test_sqlite_write_failure_does_not_escape_or_acknowledge(app: Any) -> None:
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as http:
        identity = http.post("/sessions", headers=AUTH, json={"title": "DB error"}).json()["id"]
        url = f"ws://127.0.0.1/sessions/{identity}/live/stream"
        try:
            with http.websocket_connect(url, headers=AUTH) as ws:
                ws.send_json({"type": "open", "sample_rate": 16000})
                ws.receive_json()
                with app.state.runtime.db.read() as db:
                    db.execute("PRAGMA query_only=ON")
                ws.send_bytes(packet(0, 0))
                assert ws.receive_json() == {"type": "stream.error", "code": "storage_failed"}
                assert ws.receive()["type"] == "websocket.close"
        finally:
            with app.state.runtime.db.read() as db:
                db.execute("PRAGMA query_only=OFF")
        assert http.get(f"/sessions/{identity}/live", headers=AUTH).json()["saved_samples"] == 0


def test_fsync_failure_is_disclosed_without_saved_ack(app: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    def failed_sync(_fd: int) -> None:
        raise OSError("private disk information")

    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as http:
        identity = http.post("/sessions", headers=AUTH, json={"title": "Disk error"}).json()["id"]
        with http.websocket_connect(f"ws://127.0.0.1/sessions/{identity}/live/stream", headers=AUTH) as ws:
            ws.send_json({"type": "open", "sample_rate": 16000})
            ws.receive_json()
            with monkeypatch.context() as boundary:
                boundary.setattr(os, "fsync", failed_sync)
                ws.send_bytes(packet(0, 0))
                assert ws.receive_json() == {"type": "stream.error", "code": "storage_failed"}
        assert http.get(f"/sessions/{identity}/live", headers=AUTH).json()["saved_samples"] == 0
