"""Stop has a bounded ASR grace period, not a user-controlled indefinite wait."""
from __future__ import annotations

import json
import time
from typing import Any

import pytest
from starlette.testclient import TestClient

from skaz.gateways import soniox
from skaz.secrets import MemorySecretStore
from tests.test_native_live_ws import AUTH, packet
from tests.test_native_soniox_ws import ProviderSocket


@pytest.mark.parametrize("samples, progress_ms, complete", [
    (53504, 3360, True), (159488, 10080, True), (53504, 3600, False),
])
def test_stop_accepts_soniox_final_processing_block_not_extra_audio(
    app: Any, secrets: MemorySecretStore, monkeypatch: pytest.MonkeyPatch,
    samples: int, progress_ms: int, complete: bool,
) -> None:
    class BlockClock(ProviderSocket):
        async def send(self, message: str | bytes) -> None:
            if message == "":
                for finished in (False, True):
                    await self.responses.put(json.dumps({
                        "tokens": [], "final_audio_proc_ms": progress_ms,
                        "total_audio_proc_ms": progress_ms, "finished": finished,
                    }))
            elif isinstance(message, bytes):
                self.audio.append(message)

    async def connect(*args: Any, **kwargs: Any) -> ProviderSocket:
        return BlockClock()

    monkeypatch.setattr(soniox, "connect", connect)
    secrets.set("soniox", "fixture-key-not-real")
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as http:
        http.put("/settings", headers=AUTH, json={"cloud_consent": True})
        sid = http.post("/sessions", headers=AUTH, json={"title": "Final block"}).json()["id"]
        with http.websocket_connect(f"ws://127.0.0.1/sessions/{sid}/live/stream", headers=AUTH) as ws:
            ws.send_json({"type": "open", "sample_rate": 16000})
            assert ws.receive_json()["type"] == "stream.opened"
            offset = 0
            sequence = 0
            while offset < samples:
                count = min(1600, samples - offset)
                ws.send_bytes(packet(sequence, offset, count))
                assert ws.receive_json()["type"] == "audio.saved"
                offset += count
                sequence += 1
            ws.send_json({"type": "end"})
            stopped = ws.receive_json()
            assert stopped["type"] == "stream.stopped"
            assert stopped["transcription_complete"] is complete
            assert stopped["saved_samples"] == samples
        snapshot = http.get(f"/sessions/{sid}/live", headers=AUTH).json()
        if complete:
            assert snapshot["connections"][0]["final_sample"] == samples
            assert snapshot["gaps"] == []
        else:
            assert snapshot["connections"][0]["final_sample"] < samples
            assert snapshot["gaps"]


@pytest.mark.parametrize("action", ["stop", "pause"])
def test_silent_provider_acknowledges_within_three_second_grace_and_allows_next_capture(
    app: Any, secrets: MemorySecretStore, monkeypatch: pytest.MonkeyPatch, action: str,
) -> None:
    class Silent(ProviderSocket):
        async def send(self, message: str | bytes) -> None:
            if isinstance(message, bytes) and message:
                self.audio.append(message)

    async def connect(*args: Any, **kwargs: Any) -> ProviderSocket:
        return Silent()

    monkeypatch.setattr(soniox, "connect", connect)
    secrets.set("soniox", "fixture-key-not-real")
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as http:
        http.put("/settings", headers=AUTH, json={"cloud_consent": True})
        sid = http.post("/sessions", headers=AUTH, json={"title": "Bounded stop"}).json()["id"]
        url = f"ws://127.0.0.1/sessions/{sid}/live/stream"
        with http.websocket_connect(url, headers=AUTH) as ws:
            ws.send_json({"type": "open", "sample_rate": 16000})
            assert ws.receive_json()["type"] == "stream.opened"
            ws.send_bytes(packet(0, 0))
            assert ws.receive_json()["type"] == "audio.saved"
            started = time.monotonic()
            ws.send_json({"type": "end", "action": action})
            stopped = ws.receive_json()
            elapsed = time.monotonic() - started
            assert stopped["type"] == "stream.stopped"
            assert stopped["transcription_complete"] is False
            assert stopped["saved_samples"] == 1600
            assert elapsed < 3.8, elapsed  # 3s ASR grace plus local persistence/scheduling
        with http.websocket_connect(url, headers=AUTH) as ws:
            ws.send_json({"type": "open", "sample_rate": 16000})
            opened = ws.receive_json()
            assert opened["type"] == "stream.opened"
            assert opened["saved_samples"] == 1600
            ws.send_json({"type": "end"})
            assert ws.receive_json()["type"] == "stream.stopped"
