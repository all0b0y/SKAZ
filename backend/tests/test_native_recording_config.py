"""Immutable recording choices at the public HTTP/WS boundary, no real provider."""
from __future__ import annotations

import json
import sqlite3
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


def test_audio_only_stays_local_after_preferences_change_and_restart(
    config: AppConfig, outbound: FakeHttp, monkeypatch: pytest.MonkeyPatch,
) -> None:
    class GuardedSecrets(MemorySecretStore):
        reads = 0

        def get(self, provider: str) -> str | None:
            if provider == "soniox":
                self.reads += 1
            return super().get(provider)

    secrets = GuardedSecrets()
    secrets.set("soniox", "fixture-key-not-real")
    calls: list[bool] = []

    async def connect(*args: Any, **kwargs: Any) -> None:
        calls.append(True)
        raise AssertionError("Audio-only must never connect")

    monkeypatch.setattr(soniox, "connect", connect)
    sid = ""
    for restart in (False, True):
        app = create_app(config, secret_store=secrets, http_client=outbound.client())
        with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as http:
            if not restart:
                assert http.put("/settings", headers=AUTH, json={
                    "native_recording_mode": "audio_only", "translation_target_language": "de",
                    "cloud_consent": True,
                }).status_code == 200
                sid = http.post("/sessions", headers=AUTH, json={"title": "Local"}).json()["id"]
            reads = secrets.reads
            with http.websocket_connect(f"ws://127.0.0.1/sessions/{sid}/live/stream", headers=AUTH) as ws:
                ws.send_json({"type": "open", "sample_rate": 16000})
                opened = ws.receive_json()
                assert opened["transcription"] == "disabled"
                assert secrets.reads == reads
                index = 1 if restart else 0
                ws.send_bytes(packet(index, index * 1600))
                assert ws.receive_json()["type"] == "audio.saved"
                snap = http.get(f"/sessions/{sid}/live", headers=AUTH).json()
                assert snap["recording_mode"] == "audio_only"
                assert snap["translation_target_language"] == "de"
                assert http.put("/settings", headers=AUTH, json={
                    "native_recording_mode": "translation", "translation_target_language": "fr",
                }).status_code == 200
                ws.send_json({"type": "end", "action": "stop" if restart else "pause"})
                assert ws.receive_json()["transcription_complete"] is False
            audio = http.get(f"/sessions/{sid}/audio/{index}", headers=AUTH)
            assert audio.content[44:] == packet(index, 0)[20:]
            snap = http.get(f"/sessions/{sid}/live", headers=AUTH).json()
            assert snap["recording_mode"] == "audio_only"
            assert snap["final_tokens"] == []
    assert calls == []
    assert outbound.requests == []


@pytest.mark.parametrize("mode", ["translation", "transcription"])
def test_recording_config_survives_pause_restart_and_reaches_provider(
    config: AppConfig, outbound: FakeHttp, monkeypatch: pytest.MonkeyPatch, mode: str,
) -> None:
    configs: list[dict[str, Any]] = []

    class TranslationSocket(ProviderSocket):
        async def send(self, message: str | bytes) -> None:
            if isinstance(message, str):
                configs.append(json.loads(message))
            elif message:
                self.audio.append(message)
            else:
                tokens: list[dict[str, Any]] = [{
                    "text": "Hello", "start_ms": 0, "end_ms": 100,
                    "confidence": 0.99, "is_final": True, "language": "en", "speaker": "1",
                    "translation_status": "original" if mode == "translation" else "none",
                }]
                if mode == "translation":
                    tokens.append({"text": "Hallo", "confidence": 0.99, "is_final": True,
                                   "language": "de", "speaker": "1", "translation_status": "translation"})
                await self.responses.put(json.dumps({
                    "tokens": tokens, "final_audio_proc_ms": 100,
                    "total_audio_proc_ms": 100, "finished": True,
                }))

    async def connect(*args: Any, **kwargs: Any) -> ProviderSocket:
        return TranslationSocket()

    monkeypatch.setattr(soniox, "connect", connect)
    secrets = MemorySecretStore()
    secrets.set("soniox", "fixture-key-not-real")
    sid = ""
    for index in range(2):
        app = create_app(config, secret_store=secrets, http_client=outbound.client())
        with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as http:
            if index == 0:
                assert http.put("/settings", headers=AUTH, json={
                    "native_recording_mode": mode, "translation_target_language": "de",
                    "used_languages": ["ru", "en"],
                    "cloud_consent": True,
                }).status_code == 200
                sid = http.post("/sessions", headers=AUTH, json={"title": "Translate"}).json()["id"]
            with http.websocket_connect(f"ws://127.0.0.1/sessions/{sid}/live/stream", headers=AUTH) as ws:
                ws.send_json({"type": "open", "sample_rate": 16000})
                assert ws.receive_json()["saved_samples"] == index * 1600
                deadline = time.monotonic() + 2
                while http.get(f"/sessions/{sid}/live", headers=AUTH).json()["transcription"] != "streaming":
                    assert time.monotonic() < deadline
                if mode == "translation":
                    assert configs[-1]["translation"] == {"type": "one_way", "target_language": "de"}
                else:
                    assert "translation" not in configs[-1]
                assert configs[-1]["language_hints"] == ["ru", "en"]
                assert configs[-1]["language_hints_strict"] is True
                assert http.put("/settings", headers=AUTH, json={
                    "native_recording_mode": "audio_only", "translation_target_language": "fr",
                    "used_languages": ["fr"],
                }).status_code == 200
                ws.send_bytes(packet(index, index * 1600))
                assert ws.receive_json()["type"] == "audio.saved"
                ws.send_json({"type": "end", "action": "pause" if index == 0 else "stop"})
                assert ws.receive_json()["transcription_complete"] is True
            snapshot = http.get(f"/sessions/{sid}/live", headers=AUTH).json()
            assert snapshot["recording_mode"] == mode
            assert snapshot["used_languages"] == ["ru", "en"]
            assert snapshot["translation_target_language"] == "de"
            assert [t["text"] for t in snapshot["final_tokens"]] == ["Hello"] * (index + 1)
            expected = ["Hallo"] * (index + 1) if mode == "translation" else []
            assert [t["text"] for t in snapshot["final_translation_tokens"]] == expected
            assert all("start_sample" not in t for t in snapshot["final_translation_tokens"])
            expected_stream = ["Hello", "Hallo"] if mode == "translation" else ["Hello"]
            assert [t["text"] for t in snapshot["final_stream_tokens"]] == expected_stream * (index + 1)
            assert [t["speaker_number"] for t in snapshot["final_stream_tokens"]] == (
                [1, 1, 2, 2][:2 * (index + 1)] if mode == "translation" else [1, 2][:index + 1]
            )
            detail = http.get(f"/sessions/{sid}", headers=AUTH).json()
            assert [s["text"] for s in detail["segments"]] == ["Hello"] * (index + 1)
    assert len(configs) == 2


def test_v3_recording_migrates_as_transcription_not_current_preferences(
    config: AppConfig, outbound: FakeHttp,
) -> None:
    app = create_app(config, secret_store=MemorySecretStore(), http_client=outbound.client())
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as http:
        sid = http.post("/sessions", headers=AUTH, json={"title": "Old native"}).json()["id"]
        with http.websocket_connect(f"ws://127.0.0.1/sessions/{sid}/live/stream", headers=AUTH) as ws:
            ws.send_json({"type": "open", "sample_rate": 16000})
            ws.receive_json()
            ws.send_bytes(packet(0, 0))
            ws.receive_json()
            ws.send_json({"type": "end", "action": "pause"})
            ws.receive_json()
        assert http.put("/settings", headers=AUTH, json={
            "native_recording_mode": "translation", "translation_target_language": "fr",
        }).status_code == 200
    # Fixture representing pre-v4 schema; assertions use HTTP after actual migration.
    with sqlite3.connect(config.db_path) as db:
        db.execute("ALTER TABLE native_recordings DROP COLUMN recording_mode")
        db.execute("ALTER TABLE native_recordings DROP COLUMN translation_target_language")
        db.execute("ALTER TABLE native_recordings DROP COLUMN used_languages_json")
        db.execute("DELETE FROM schema_migrations WHERE name='native_recording_config_v4'")
        db.execute("DELETE FROM schema_migrations WHERE name='native_languages_v6'")
    for _ in range(2):
        app = create_app(config, secret_store=MemorySecretStore(), http_client=outbound.client())
        with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as http:
            snapshot = http.get(f"/sessions/{sid}/live", headers=AUTH).json()
            assert snapshot["recording_mode"] == "transcription"
            assert snapshot["translation_target_language"] == "ru"
            assert snapshot["used_languages"] is None
            assert snapshot["saved_samples"] == 1600
            assert http.get(f"/sessions/{sid}/audio/0", headers=AUTH).content[44:] == packet(0, 0)[20:]
            with http.websocket_connect(f"ws://127.0.0.1/sessions/{sid}/live/stream", headers=AUTH) as ws:
                ws.send_json({"type": "open", "sample_rate": 16000})
                assert ws.receive_json()["saved_samples"] == 1600
                ws.send_json({"type": "end"})
                ws.receive_json()
            assert http.get(f"/sessions/{sid}/live", headers=AUTH).json()["recording_mode"] == "transcription"
