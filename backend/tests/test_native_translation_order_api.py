"""Mixed provider order at HTTP/WS boundary; fixtures are not speech acceptance."""
from __future__ import annotations

import json
import time
from typing import Any

import pytest
from starlette.testclient import TestClient

from audiohelper.app import create_app
from audiohelper.config import AppConfig
from audiohelper.gateways import soniox
from audiohelper.secrets import MemorySecretStore
from tests.conftest import FakeHttp
from tests.test_native_live_ws import AUTH, packet
from tests.test_native_soniox_ws import ProviderSocket


@pytest.mark.parametrize("split_events", [False, True])
def test_mixed_translation_order_and_status_survive_restart(
    config: AppConfig, outbound: FakeHttp, monkeypatch: pytest.MonkeyPatch, split_events: bool,
) -> None:
    def spoken(text: str, speaker: str, status: str, start: int) -> dict[str, Any]:
        return {"text": text, "speaker": speaker, "translation_status": status,
                "start_ms": start, "end_ms": start + 20, "language": "de" if status == "none" else "en",
                "confidence": .9, "is_final": True}

    def translated(text: str, speaker: str) -> dict[str, Any]:
        return {"text": text, "speaker": speaker, "translation_status": "translation",
                "language": "de", "source_language": "en", "confidence": .9, "is_final": True}

    class MixedSocket(ProviderSocket):
        async def send(self, message: str | bytes) -> None:
            if isinstance(message, str):
                return
            if message:
                self.audio.append(message)
                return
            # Unequal token counts, A/B/A, and an already-target-language turn.
            tokens = [
                spoken("Good", "1", "original", 0), spoken(" morning", "1", "original", 20),
                translated("Guten Morgen", "1"), spoken("Ja", "2", "none", 40),
                spoken("Thanks", "1", "original", 60), translated("Vielen", "1"),
                translated(" Dank", "1"),
            ]
            batches = [tokens[:2], tokens[2:5], tokens[5:]] if split_events else [tokens]
            for index, batch in enumerate(batches):
                await self.responses.put(json.dumps({"tokens": batch, "final_audio_proc_ms": 100,
                    "total_audio_proc_ms": 100, "finished": index == len(batches) - 1}))

    async def connect(*args: Any, **kwargs: Any) -> ProviderSocket:
        return MixedSocket()

    monkeypatch.setattr(soniox, "connect", connect)
    secrets = MemorySecretStore()
    secrets.set("soniox", "fixture-key-not-real")
    app = create_app(config, secret_store=secrets, http_client=outbound.client())
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as http:
        assert http.put("/settings", headers=AUTH, json={
            "native_recording_mode": "translation", "translation_target_language": "de",
            "cloud_consent": True,
        }).status_code == 200
        sid = http.post("/sessions", headers=AUTH, json={"title": "Mixed"}).json()["id"]
        with http.websocket_connect(f"ws://127.0.0.1/sessions/{sid}/live/stream", headers=AUTH) as ws:
            ws.send_json({"type": "open", "sample_rate": 16000})
            ws.receive_json()
            deadline = time.monotonic() + 2
            while http.get(f"/sessions/{sid}/live", headers=AUTH).json()["transcription"] != "streaming":
                assert time.monotonic() < deadline
            ws.send_bytes(packet(0, 0))
            assert ws.receive_json()["type"] == "audio.saved"
            ws.send_json({"type": "end"})
            assert ws.receive_json()["transcription_complete"] is True
        snapshot = http.get(f"/sessions/{sid}/live", headers=AUTH).json()
        # Mixed provider order is a durable storage invariant; the live HTTP
        # response deliberately omits these derived views (they were half the
        # per-second payload — see docs/BASELINE-PROFILE.md), so assert them
        # against the store the response is built from.
        durable = app.state.runtime.live_store.snapshot(sid)
        stream = durable["final_stream_tokens"]
        assert [t["text"] for t in stream] == [
            "Good", " morning", "Guten Morgen", "Ja", "Thanks", "Vielen", " Dank",
        ]
        assert [t["translation_status"] for t in stream] == [
            "original", "original", "translation", "none", "original", "translation", "translation",
        ]
        assert [t["speaker_number"] for t in stream] == [1, 1, 1, 2, 1, 1, 1]
        assert [t["id"] for t in stream if t["translation_status"] != "translation"] == [
            t["id"] for t in durable["final_tokens"]
        ]
        for token in stream:
            if token["translation_status"] == "translation":
                assert not {"start_ms", "end_ms", "start_sample", "end_sample", "segment_id"} & token.keys()
        assert durable["partial_stream_tokens"] == []
        # What the client actually renders still carries the same turns.
        assert [t["text"] for t in snapshot["live_translation_projection"]["original_tokens"]] == [
            "Good", " morning", "Ja", "Thanks",
        ]
        projection = durable["final_translation_projection"]
        turns = projection["monologues"]
        assert [turn["speaker_number"] for turn in turns] == [1, 2, 1]
        assert [turn["original_token_ids"] for turn in turns] == [
            [stream[0]["id"], stream[1]["id"]], [stream[3]["id"]], [stream[4]["id"]],
        ]
        assert [turn["translation_token_ids"] for turn in turns] == [
            [stream[2]["id"]], [], [stream[5]["id"], stream[6]["id"]],
        ]
        assert [turn["passthrough_token_ids"] for turn in turns] == [[], [stream[3]["id"]], []]
        assert projection["unassigned_translation_token_ids"] == []
        detail = http.get(f"/sessions/{sid}", headers=AUTH).json()
        assert "".join(s["text"] for s in detail["segments"]) == "Good morningJaThanks"
    app = create_app(config, secret_store=secrets, http_client=outbound.client())
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as http:
        assert http.get(f"/sessions/{sid}/live", headers=AUTH).status_code == 200
        restored = app.state.runtime.live_store.snapshot(sid)
        assert restored["final_stream_tokens"] == stream
        assert restored["final_translation_projection"] == projection
