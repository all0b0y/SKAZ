"""Notes freshness through native WS/HTTP and a real database reopen; fixture network only."""
from __future__ import annotations

import asyncio
from typing import Any

import pytest
from starlette.testclient import TestClient

from audiohelper.app import create_app
from audiohelper.config import AppConfig
from audiohelper.gateways import soniox
from audiohelper.secrets import MemorySecretStore
from tests.conftest import FakeHttp, chat_completion
from tests.test_native_live_ws import AUTH, packet
from tests.test_native_soniox_ws import ProviderSocket


def test_native_append_replay_other_session_and_restart(
    config: AppConfig, outbound: FakeHttp, secrets: MemorySecretStore, monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def connect(*args: Any, **kwargs: Any) -> ProviderSocket:
        return ProviderSocket()

    monkeypatch.setattr(soniox, "connect", connect)
    secrets.set("soniox", "fixture-only")
    secrets.set("openai", "fixture-only")
    outbound.json_route("POST", "chat/completions", chat_completion("- Hello [P1]"))
    app = create_app(config, secret_store=secrets, http_client=outbound.client())
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as http:
        http.put("/settings", headers=AUTH, json={
            "cloud_consent": True, "notes": {"provider": "openai", "model": "gpt-4o-mini"},
        }).raise_for_status()
        sid = http.post("/sessions", headers=AUTH, json={"title": "Native notes"}).json()["id"]
        url = f"ws://127.0.0.1/sessions/{sid}/live/stream"
        with http.websocket_connect(url, headers=AUTH) as ws:
            ws.send_json({"type": "open", "sample_rate": 16000})
            ws.receive_json()
            assert http.portal is not None
            http.portal.call(asyncio.sleep, 0)
            ws.send_bytes(packet(0, 0))
            ws.receive_json()
            ws.send_bytes(packet(0, 0))
            assert ws.receive_json()["duplicate"] is True
            ws.send_json({"type": "end", "action": "pause"})
            assert ws.receive_json()["transcription_complete"] is True
        response = http.post(f"/sessions/{sid}/notes", headers=AUTH, json={})
        assert response.status_code == 200, response.text
        note = response.json()
        assert note["stale"] is False
        # An unrelated session and a rename cannot invalidate this note.
        other = http.post("/sessions", headers=AUTH, json={"title": "Other"}).json()["id"]
        http.patch(f"/sessions/{sid}", headers=AUTH, json={"title": "Renamed"}).raise_for_status()
        http.put("/settings", headers=AUTH, json={"cloud_consent": False}).raise_for_status()
        with http.websocket_connect(f"ws://127.0.0.1/sessions/{other}/live/stream", headers=AUTH) as ws:
            ws.send_json({"type": "open", "sample_rate": 16000})
            ws.receive_json()
            ws.send_bytes(packet(0, 0))
            ws.receive_json()
            ws.send_json({"type": "end"})
            ws.receive_json()
        assert http.get(f"/sessions/{sid}", headers=AUTH).json()["notes"]["stale"] is False
        calls_before = len(outbound.requests)
        with http.websocket_connect(url, headers=AUTH) as ws:
            ws.send_json({"type": "open", "sample_rate": 16000})
            assert ws.receive_json()["saved_samples"] == 1600
            assert http.get(f"/sessions/{sid}", headers=AUTH).json()["notes"]["stale"] is False
            ws.send_bytes(packet(1, 1600))
            assert ws.receive_json()["saved_samples"] == 3200
            assert http.get(f"/sessions/{sid}", headers=AUTH).json()["notes"]["stale"] is True
            ws.send_json({"type": "end"})
            ws.receive_json()
        assert len(outbound.requests) == calls_before  # no implicit note generation
    reopened = create_app(config, secret_store=secrets, http_client=outbound.client())
    with TestClient(reopened, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as http:
        notes = http.get(f"/sessions/{sid}/notes", headers=AUTH).json()["notes"]
        assert notes == [{**note, "stale": True}]
        assert http.get(f"/sessions/{sid}/audio/0", headers=AUTH).content[44:] == packet(0, 0)[20:]
