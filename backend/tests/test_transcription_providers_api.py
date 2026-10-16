"""Transcription provider choice: settings, live streams and media import.

Local Whisper and OpenAI run here through scripted decoders; no model weights,
microphone or network are used. What is checked is the promise of the issue:
an explicit provider choice, no silent fallback, honest capability flags, and a
transcript stored in the same shape (tokens, speakers, segments) as Soniox.
"""
from __future__ import annotations

import asyncio
import json
import struct
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import replace
from pathlib import Path
from typing import Any

import httpx
import pytest
from starlette.testclient import TestClient

from skaz import asr_providers, media_tools
from skaz.app import create_app
from skaz.config import AppConfig
from skaz.file_asr import FileTranscript, transcribe_pcm_file
from skaz.gateways.live_session import LiveAsrSession
from skaz.gateways.soniox_async import AsyncToken
from skaz.gateways.whisper_stream import (
    SAMPLE_RATE,
    EnergyVoiceActivity,
    SpeakerTracker,
    StreamSettings,
    WhisperStreamSession,
)
from skaz.live_store import LiveConnection
from skaz.secrets import MemorySecretStore
from skaz.settings_store import StoredSettings
from tests.conftest import FakeHttp
from tests.test_native_live_ws import AUTH
from tests.test_whisper_stream import SCRIPT, ScriptedDecoder, ScriptedVad, tone


def pcm_packet(sequence: int, start: int, pcm: bytes) -> bytes:
    return struct.pack("!QQI", sequence, start, len(pcm) // 2) + pcm


def wait_background(http: TestClient, sid: str) -> None:
    assert http.portal is not None
    for _ in range(200):
        status = http.get(f"/sessions/{sid}/live/status", headers=AUTH).json()
        if not status["processing"]:
            assert status["incomplete"] is False
            return
        http.portal.call(asyncio.sleep, 0.01)
    raise AssertionError("Background finalization did not complete")


class Voices:
    """First utterance one voice, second another: a stand-in for the ONNX model."""

    def __init__(self) -> None:
        self.calls = 0

    async def embed(self, pcm: bytes) -> Sequence[float] | None:
        self.calls += 1
        return [1.0, 0.0] if self.calls == 1 else [0.0, 1.0]


def scripted_local_opener(
    runtime: Any, settings: StoredSettings, connection: LiveConnection, target: str | None,
) -> Callable[[], Awaitable[LiveAsrSession]]:
    async def open_local() -> LiveAsrSession:
        vad = ScriptedVad()
        session = WhisperStreamSession(
            StreamSettings(sample_rate=connection.sample_rate, label="Local Whisper",
                           translation_target_language=target),
            decoder=ScriptedDecoder(vad), vad=vad,
            speakers=SpeakerTracker(Voices(), min_seconds=0.5),
        )
        vad.session = session
        return session

    return open_local


def test_settings_describe_every_provider_honestly(
    config: AppConfig, outbound: FakeHttp, tmp_path: Path,
) -> None:
    # An empty model cache instead of the developer's shared Hugging Face cache,
    # where an already downloaded Whisper model would make Local Whisper ready.
    application = create_app(
        replace(config, local_model_cache_dir=tmp_path / "models"),
        secret_store=MemorySecretStore(), http_client=outbound.client(),
    )
    try:
        with TestClient(application, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as http:
            settings = http.get("/settings", headers=AUTH).json()
    finally:
        application.state.runtime.close()
    assert settings["transcription_provider"] == "soniox"  # unchanged default
    providers = {item["id"]: item for item in settings["transcription_providers"]}
    assert list(providers) == ["soniox", "local-whisper", "openai"]
    local = providers["local-whisper"]
    assert local["capabilities"]["offline"] is True
    assert local["capabilities"]["requires_cloud_consent"] is False
    assert local["capabilities"]["speakers"] == "approximate"
    assert local["capabilities"]["translation"] == "english_only"
    assert local["ready"] is False and local["detail"]
    assert local["limitations"]
    assert {model["id"] for model in local["models"]} >= {"tiny", "small", "large-v3"}
    small = next(model for model in local["models"] if model["id"] == "small")
    assert small["recommended"] is True and small["size_bytes"] > 100_000_000
    assert providers["soniox"]["capabilities"]["speakers"] == "full"
    assert providers["soniox"]["ready"] is False  # no key, no consent
    assert providers["openai"]["capabilities"]["provisional_text"] is False


def test_provider_selection_is_saved_and_unknown_models_are_refused(app: Any) -> None:
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as http:
        saved = http.put("/settings", headers=AUTH, json={
            "transcription_provider": "local-whisper", "local_whisper_model": "base",
            "speaker_separation": False,
        })
        assert saved.status_code == 200, saved.text
        body = saved.json()
        assert (body["transcription_provider"], body["local_whisper_model"]) == ("local-whisper", "base")
        assert body["speaker_separation"] is False
        for field, value in (("local_whisper_model", "../../etc"), ("openai_transcription_model", "gpt-4o")):
            refused = http.put("/settings", headers=AUTH, json={field: value})
            assert refused.status_code == 400
        assert http.get("/settings", headers=AUTH).json()["local_whisper_model"] == "base"


def test_local_stream_keeps_the_transcript_shape_with_speakers_and_no_cloud_consent(
    app: Any, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(asr_providers, "_local_opener", scripted_local_opener)
    audio = tone(8, SCRIPT)
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as http:
        http.put("/settings", headers=AUTH, json={"transcription_provider": "local-whisper"})
        sid = http.post("/sessions", headers=AUTH, json={"title": "Offline"}).json()["id"]
        with http.websocket_connect(f"ws://127.0.0.1/sessions/{sid}/live/stream", headers=AUTH) as ws:
            ws.send_json({"type": "open", "sample_rate": SAMPLE_RATE})
            opened = ws.receive_json()
            assert opened["transcription"] == "connecting"
            assert opened["transcription_provider"] == "local-whisper"
            step = SAMPLE_RATE // 2
            for sequence, offset in enumerate(range(0, len(audio) // 2, step)):
                ws.send_bytes(pcm_packet(sequence, offset, audio[offset * 2:(offset + step) * 2]))
                assert ws.receive_json()["type"] == "audio.saved"
                assert http.portal is not None
                http.portal.call(asyncio.sleep, 0.01)
            ws.send_json({"type": "end"})
            stopped = ws.receive_json()
            assert stopped["type"] == "stream.stopped"
            assert stopped["transcription_pending"] is True
            wait_background(http, sid)
        live = http.get(f"/sessions/{sid}/live", headers=AUTH).json()
        assert "".join(token["text"] for token in live["final_tokens"]) == "".join(t for t, _, _ in SCRIPT)
        assert [speaker["number"] for speaker in live["speakers"]] == [1, 2]
        by_speaker = {token["text"]: token["speaker_number"] for token in live["final_tokens"]}
        assert by_speaker[" Hello"] == 1 and by_speaker[" Second"] == 2
        assert live["connections"][0]["model"] == "local-whisper/small"
        segments = http.get(f"/sessions/{sid}", headers=AUTH).json()["segments"]
        # One segment per confirmed delta, exactly as Soniox final deltas are stored.
        assert [segment["text"] for segment in segments] == [
            " Hello world.", " This is", " a test.", " Second part.",
        ]


def test_local_stream_without_a_downloaded_model_fails_with_a_reason_not_a_fallback(
    app: Any, secrets: MemorySecretStore, monkeypatch: pytest.MonkeyPatch,
) -> None:
    def missing(*args: Any, **kwargs: Any) -> Any:
        raise FileNotFoundError("no weights")

    monkeypatch.setattr("skaz.gateways.asr.load_local_whisper", missing)
    secrets.set("soniox", "fixture-key-not-real")
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as http:
        http.put("/settings", headers=AUTH, json={
            "transcription_provider": "local-whisper", "cloud_consent": True,
        })
        sid = http.post("/sessions", headers=AUTH, json={"title": "Missing"}).json()["id"]
        with http.websocket_connect(f"ws://127.0.0.1/sessions/{sid}/live/stream", headers=AUTH) as ws:
            ws.send_json({"type": "open", "sample_rate": SAMPLE_RATE})
            assert ws.receive_json()["transcription"] == "connecting"
            failed = ws.receive_json()
            assert failed["type"] == "transcription.failed"
            assert "Local Whisper" in failed["reason"] or "faster-whisper" in failed["reason"]
            ws.send_json({"type": "end"})
            assert ws.receive_json()["type"] == "stream.stopped"


def test_unsupported_live_translation_is_reported_before_recording(
    app: Any, secrets: MemorySecretStore,
) -> None:
    secrets.set("openai", "fixture-key-not-real")
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as http:
        http.put("/settings", headers=AUTH, json={
            "transcription_provider": "openai", "cloud_consent": True,
            "native_recording_mode": "translation", "translation_target_language": "de",
        })
        sid = http.post("/sessions", headers=AUTH, json={"title": "Translate"}).json()["id"]
        with http.websocket_connect(f"ws://127.0.0.1/sessions/{sid}/live/stream", headers=AUTH) as ws:
            ws.send_json({"type": "open", "sample_rate": SAMPLE_RATE})
            opened = ws.receive_json()
            assert opened["transcription"] == "unavailable"
            assert "cannot translate" in opened["transcription_detail"]
            ws.send_json({"type": "end"})
            assert ws.receive_json()["type"] == "stream.stopped"


def test_cloud_provider_needs_consent_and_its_own_key(app: Any, secrets: MemorySecretStore) -> None:
    secrets.set("soniox", "fixture-key-not-real")
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as http:
        http.put("/settings", headers=AUTH, json={"transcription_provider": "openai", "cloud_consent": True})
        sid = http.post("/sessions", headers=AUTH, json={"title": "No key"}).json()["id"]
        with http.websocket_connect(f"ws://127.0.0.1/sessions/{sid}/live/stream", headers=AUTH) as ws:
            ws.send_json({"type": "open", "sample_rate": SAMPLE_RATE})
            opened = ws.receive_json()
            # A Soniox key is stored, but it is never used as a fallback for OpenAI.
            assert opened["transcription"] == "unavailable"
            assert opened["transcription_provider"] == "openai"
            assert "OpenAI" in opened["transcription_detail"]
            ws.send_json({"type": "end"})
            ws.receive_json()


def test_revoking_cloud_consent_does_not_stop_an_on_device_stream(
    app: Any, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(asr_providers, "_local_opener", scripted_local_opener)
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as http:
        http.put("/settings", headers=AUTH,
                 json={"transcription_provider": "local-whisper", "cloud_consent": True})
        sid = http.post("/sessions", headers=AUTH, json={"title": "Private"}).json()["id"]
        with http.websocket_connect(f"ws://127.0.0.1/sessions/{sid}/live/stream", headers=AUTH) as ws:
            ws.send_json({"type": "open", "sample_rate": SAMPLE_RATE})
            assert ws.receive_json()["transcription"] == "connecting"
            assert http.put("/settings", headers=AUTH, json={"cloud_consent": False}).status_code == 200
            stream = app.state.runtime.native_streams[sid]
            assert stream.cloud is False and stream.state != "unavailable"
            ws.send_json({"type": "end"})
            assert ws.receive_json()["type"] == "stream.stopped"


def test_openai_live_plan_uses_utterance_mode(app: Any, secrets: MemorySecretStore) -> None:
    secrets.set("openai", "fixture-key-not-real")
    runtime = app.state.runtime
    settings = StoredSettings.model_validate({
        **runtime.settings_store.load().model_dump(), "transcription_provider": "openai",
        "cloud_consent": True,
    })
    connection = LiveConnection("c", "s", 0, 16_000, 0)
    plan = asr_providers.live_plan(runtime, settings, connection)
    assert plan.opener is not None and plan.cloud and plan.api_key_provider == "openai"
    assert plan.model == "whisper-1"
    assert asr_providers.connection_model(settings) == "openai/whisper-1"


# ── media import ───────────────────────────────────────────────────────────


async def test_file_windows_are_cut_in_pauses_and_offsets_are_absolute(tmp_path: Path) -> None:
    script = [(" One", 0.5, 1.5), (" two.", 1.6, 2.4), (" Three", 3.4, 4.0), (" four.", 4.1, 4.9)]
    path = tmp_path / "audio.s16le"
    path.write_bytes(tone(6, script))

    class FileDecoder(ScriptedDecoder):
        """Knows its window from a shared cursor (windows are decoded in order)."""

        base = 0.0

        async def decode(self, pcm: bytes, **kwargs: Any) -> Any:
            self.vad.crop_start = FileDecoder.base
            result = await super().decode(pcm, **kwargs)
            FileDecoder.base += len(pcm) / 2 / SAMPLE_RATE
            return result

    vad = ScriptedVad()

    class Energy(EnergyVoiceActivity):
        async def speech(self, pcm: bytes) -> list[tuple[float, float]]:
            return await super().speech(pcm)

    decoder = FileDecoder(vad, script)
    transcript = await transcribe_pcm_file(
        path, decoder=decoder, vad=Energy(), speakers=SpeakerTracker(None), languages=("en",),
        translation_target=None, window_s=3,
    )
    assert [token.text for token in transcript.tokens] == [text for text, _, _ in script]
    assert transcript.duration_ms == 6000
    three = next(token for token in transcript.tokens if token.text == " Three")
    assert three.start_ms == 3400 and three.speaker == "1" and three.translation_status == "none"


async def test_local_import_is_stored_like_soniox_and_needs_no_cloud(
    client: httpx.AsyncClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(asr_providers, "local_asr_available", lambda: True)
    monkeypatch.setattr(asr_providers, "local_model_cache_present", lambda *a, **k: True)

    async def decode(source: Path, directory: Path) -> Path:
        output = directory / "audio.s16le"
        output.write_bytes(b"\x00\x00" * SAMPLE_RATE)
        return output

    calls: list[tuple[str, tuple[str, ...] | None]] = []

    async def transcribe(runtime: Any, model: str, pcm: Path, *, languages: tuple[str, ...] | None,
                         translation_target: str | None) -> FileTranscript:
        calls.append((model, languages))
        return FileTranscript([
            AsyncToken(" Добрый", 0, 400, 0.9, "1", "ru", "none"),
            AsyncToken(" день", 400, 900, 0.9, "1", "ru", "none"),
            AsyncToken(" Отвечаю", 1_400, 2_100, 0.9, "2", "ru", "none"),
        ], 2_500)

    monkeypatch.setattr(media_tools, "decode_pcm16k", decode)
    monkeypatch.setattr("skaz.import_service.transcribe_import", transcribe)
    saved = await client.put("/settings", json={"transcription_provider": "local-whisper"})
    assert saved.status_code == 200
    capabilities = (await client.get("/imports")).json()
    assert capabilities["provider"] == "local-whisper" and capabilities["sends_audio"] is False
    assert capabilities["provider_ready"] is True and capabilities["rate_per_hour_usd"] == 0
    source = tmp_path / "lecture.m4a"
    source.write_bytes(b"\x00\x01" * 2048)
    response = await client.post("/imports", json={"path": str(source), "title": "Лекция",
                                                   "declared_duration_ms": 2_500})
    assert response.status_code == 201, response.text
    sid = response.json()["session"]["id"]
    for _ in range(400):
        await asyncio.sleep(0.01)
        state = (await client.get(f"/imports/{sid}")).json()
        if state["status"] in ("completed", "failed"):
            break
    assert state["status"] == "completed", state
    assert calls == [("local-whisper/small", None)]
    live = (await client.get(f"/sessions/{sid}/live")).json()
    assert [speaker["number"] for speaker in live["speakers"]] == [1, 2]
    detail = (await client.get(f"/sessions/{sid}")).json()
    assert [segment["text"] for segment in detail["segments"]] == [" Добрый день", " Отвечаю"]


async def test_import_refuses_translation_a_provider_cannot_do(
    client: httpx.AsyncClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(asr_providers, "local_asr_available", lambda: True)
    monkeypatch.setattr(asr_providers, "local_model_cache_present", lambda *a, **k: True)
    await client.put("/settings", json={"transcription_provider": "local-whisper",
                                        "translation_target_language": "de"})
    source = tmp_path / "lecture.m4a"
    source.write_bytes(b"\x00\x01" * 2048)
    response = await client.post("/imports", json={"path": str(source), "title": "x", "translate": True})
    assert response.status_code == 409
    assert "English only" in response.json()["detail"]
    assert json.loads(json.dumps((await client.get("/sessions")).json()))["sessions"] == []


def test_local_stream_is_complete_after_a_tail_that_is_not_a_whole_millisecond(
    app: Any, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(asr_providers, "_local_opener", scripted_local_opener)
    rate = 44_100
    audio = tone(2, [(" Hello", 0.5, 0.9)], rate=rate)
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as http:
        http.put("/settings", headers=AUTH, json={"transcription_provider": "local-whisper"})
        sid = http.post("/sessions", headers=AUTH, json={"title": "Tail"}).json()["id"]
        with http.websocket_connect(f"ws://127.0.0.1/sessions/{sid}/live/stream", headers=AUTH) as ws:
            ws.send_json({"type": "open", "sample_rate": rate})
            assert ws.receive_json()["transcription"] == "connecting"
            sizes = [rate // 2, rate // 2, 777]  # the Stop flush is an arbitrary length
            offset = 0
            for sequence, size in enumerate(sizes):
                ws.send_bytes(pcm_packet(sequence, offset, audio[offset * 2:(offset + size) * 2]))
                assert ws.receive_json()["type"] == "audio.saved"
                offset += size
            assert http.portal is not None
            http.portal.call(asyncio.sleep, 0.05)
            ws.send_json({"type": "end"})
            stopped = ws.receive_json()
            assert stopped["saved_samples"] == offset
            assert stopped["transcription_pending"] is True
            wait_background(http, sid)
        assert http.get(f"/sessions/{sid}/live", headers=AUTH).json()["gaps"] == []


def test_stop_is_acknowledged_promptly_while_a_local_model_is_still_loading(
    app: Any, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A model load runs in a thread that cannot be interrupted. Stop must still be
    acknowledged within the desktop's 15 s budget instead of waiting for it."""
    import threading
    import time

    release = threading.Event()

    def slow_open(runtime: Any, settings: StoredSettings, connection: LiveConnection,
                  target: str | None) -> Callable[[], Awaitable[LiveAsrSession]]:
        async def open_local() -> LiveAsrSession:
            from skaz.gateways.asr import _to_thread_until_finished

            await _to_thread_until_finished(release.wait, 20)  # a 20 s model load
            raise AssertionError("unreachable in this test")

        return open_local

    monkeypatch.setattr(asr_providers, "_local_opener", slow_open)
    monkeypatch.setattr("skaz.native_stream.FINISH_TIMEOUT_S", 0.5)
    try:
        with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as http:
            http.put("/settings", headers=AUTH, json={"transcription_provider": "local-whisper"})
            sid = http.post("/sessions", headers=AUTH, json={"title": "Quick stop"}).json()["id"]
            with http.websocket_connect(f"ws://127.0.0.1/sessions/{sid}/live/stream", headers=AUTH) as ws:
                ws.send_json({"type": "open", "sample_rate": SAMPLE_RATE})
                assert ws.receive_json()["transcription"] == "connecting"
                ws.send_bytes(pcm_packet(0, 0, b"\x00\x00" * 1600))
                assert ws.receive_json()["type"] == "audio.saved"
                started = time.monotonic()
                ws.send_json({"type": "end"})
                stopped = ws.receive_json()
                elapsed = time.monotonic() - started
                release.set()  # let the "model load" end so the test does not wait for it
            assert stopped["type"] == "stream.stopped" and stopped["transcription_complete"] is False
            assert elapsed < 3, elapsed
    finally:
        release.set()
