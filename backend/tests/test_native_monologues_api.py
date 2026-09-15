"""Speaker/token provenance at the production WS and authenticated read boundary."""
from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest
from starlette.testclient import TestClient

from audiohelper.gateways import soniox
from audiohelper.secrets import MemorySecretStore
from tests.test_native_live_ws import AUTH, packet
from tests.test_native_soniox_ws import ProviderSocket


def test_speaker_turns_keep_sources_and_do_not_reuse_identity_after_reconnect(
    app: Any, secrets: MemorySecretStore, monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings: list[dict[str, Any]] = []

    class Speakers(ProviderSocket):
        async def send(self, message: str | bytes) -> None:
            if isinstance(message, str):
                settings.append(json.loads(message))
            elif message:
                self.audio.append(message)
            else:
                await self.responses.put(json.dumps({
                    "tokens": [
                        {"text": text, "speaker": speaker, "start_ms": start, "end_ms": end,
                         "confidence": .99, "is_final": True, "language": "ru"}
                        for text, speaker, start, end in [
                            ("Раз", "1", 0, 30), ("Два", "2", 30, 60), ("Три", "1", 60, 100),
                        ]
                    ],
                    "final_audio_proc_ms": 100, "total_audio_proc_ms": 100, "finished": True,
                }))

    async def connect(*args: Any, **kwargs: Any) -> Speakers:
        return Speakers()

    monkeypatch.setattr(soniox, "connect", connect)
    secrets.set("soniox", "fixture-key-not-real")
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as http:
        http.put("/settings", headers=AUTH, json={"cloud_consent": True}).raise_for_status()
        sid = http.post("/sessions", headers=AUTH, json={"title": "Speakers"}).json()["id"]
        for sequence, start_sample in [(0, 0), (1, 1600)]:
            with http.websocket_connect(f"ws://127.0.0.1/sessions/{sid}/live/stream", headers=AUTH) as ws:
                ws.send_json({"type": "open", "sample_rate": 16000})
                ws.receive_json()
                assert http.portal is not None
                http.portal.call(asyncio.sleep, 0)
                ws.send_bytes(packet(sequence, start_sample))
                assert ws.receive_json()["type"] == "audio.saved"
                ws.send_bytes(packet(sequence, start_sample))
                assert ws.receive_json()["duplicate"] is True
                ws.send_json({"type": "end", "action": "pause"})
                assert ws.receive_json()["transcription_complete"] is True
        snapshot = http.get(f"/sessions/{sid}/live", headers=AUTH).json()
        tokens = snapshot["final_tokens"]
        assert [(t["text"], t["speaker_number"], t["start_sample"], t["end_sample"]) for t in tokens] == [
            ("Раз", 1, 0, 480), ("Два", 2, 480, 960), ("Три", 1, 960, 1600),
            ("Раз", 3, 1600, 2080), ("Два", 4, 2080, 2560), ("Три", 3, 2560, 3200),
        ]
        assert all(config["enable_speaker_diarization"] is True for config in settings)
        detail = http.get(f"/sessions/{sid}", headers=AUTH).json()
        source_ids = {segment["id"] for segment in detail["segments"]}
        assert all(t["segment_id"] in source_ids for t in tokens)
        assert len({t["id"] for t in tokens}) == 6
        assert http.get(f"/sessions/{sid}/live", headers=AUTH).json()["final_tokens"] == tokens
