"""Live translated read model over real app HTTP/WS; only provider socket is a fixture."""
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


def test_live_translation_order_replacement_finalization_and_request_isolation(
    config: AppConfig, outbound: FakeHttp, monkeypatch: pytest.MonkeyPatch,
) -> None:
    def original(text: str, start: int, status: str = "original") -> dict[str, Any]:
        return {"text": text, "speaker": "1", "translation_status": status,
                "start_ms": start, "end_ms": start + 20, "language": "de" if status == "none" else "en",
                "confidence": .9, "is_final": True}

    def translation(text: str, final: bool = False) -> dict[str, Any]:
        return {"text": text, "speaker": "1", "translation_status": "translation",
                "language": "de", "source_language": "en", "confidence": .9, "is_final": final}

    class LiveSocket(ProviderSocket):
        async def send(self, message: str | bytes) -> None:
            if isinstance(message, str):
                return
            if message:
                self.audio.append(message)
                batches = [
                    [original("Hello", 0), translation("Hallo", True), original(" ja", 20, "none"),
                     original("Thanks", 40), translation(" dan")],
                    [translation(" danke")],
                    [translation(" danke", True)],
                ]
                tokens = batches[len(self.audio) - 1]
            else:
                tokens = []
            await self.responses.put(json.dumps({"tokens": tokens, "final_audio_proc_ms": 60,
                "total_audio_proc_ms": 100, "finished": not message}))

    async def connect(*args: Any, **kwargs: Any) -> ProviderSocket:
        return LiveSocket()

    monkeypatch.setattr(soniox, "connect", connect)
    secrets = MemorySecretStore()
    secrets.set("soniox", "fixture-key-not-real")
    app = create_app(config, secret_store=secrets, http_client=outbound.client())
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as http:
        assert http.put("/settings", headers=AUTH, json={"native_recording_mode": "translation",
            "translation_target_language": "de", "cloud_consent": True}).status_code == 200
        sid = http.post("/sessions", headers=AUTH, json={"title": "Live translation"}).json()["id"]
        for request in range(2):
            with http.websocket_connect(f"ws://127.0.0.1/sessions/{sid}/live/stream", headers=AUTH) as ws:
                ws.send_json({"type": "open", "sample_rate": 16000})
                opened = ws.receive_json()
                deadline = time.monotonic() + 2
                while http.get(f"/sessions/{sid}/live", headers=AUTH).json()["transcription"] != "streaming":
                    assert time.monotonic() < deadline
                for index, expected in enumerate(["Hallo ja dan", "Hallo ja danke", "Hallo ja danke"]):
                    sequence = request * 3 + index
                    ws.send_bytes(packet(sequence, sequence * 1600))
                    assert ws.receive_json()["type"] == "audio.saved"
                    deadline = time.monotonic() + 2
                    while True:
                        snapshot = http.get(f"/sessions/{sid}/live", headers=AUTH).json()
                        projection = snapshot["live_translation_projection"]
                        tokens = {t["id"]: t for t in [*projection["original_tokens"],
                                                       *projection["translation_tokens"]]}
                        turns = projection["monologues"]
                        if turns:
                            visible = "".join(tokens[i]["text"] for i in turns[-1]["display_token_ids"])
                            finals = [t for t in projection["translation_tokens"]
                                      if t["connection_id"] == opened["connection_id"] and t["is_final"]]
                            if visible == expected and len(turns) == request + 1 and len(finals) == (
                                2 if index == 2 else 1
                            ):
                                break
                        assert time.monotonic() < deadline
                    assert [turn["speaker_number"] for turn in turns] == list(range(1, request + 2))
                    assert projection["unassigned_translation_token_ids"] == []
                    for token in projection["translation_tokens"]:
                        assert not {"segment_id", "start_ms", "end_ms", "start_sample", "end_sample"} & (
                            token.keys())
                    detail = http.get(f"/sessions/{sid}", headers=AUTH).json()
                    assert "".join(s["text"] for s in detail["segments"]) == "Hello jaThanks" * (request + 1)
                ws.send_json({"type": "end", "action": "pause"})
                assert ws.receive_json()["type"] == "stream.stopped"
        saved = http.get(f"/sessions/{sid}/live", headers=AUTH).json()["live_translation_projection"]
    app = create_app(config, secret_store=secrets, http_client=outbound.client())
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as http:
        assert http.get(f"/sessions/{sid}/live", headers=AUTH).json()["live_translation_projection"] == saved
