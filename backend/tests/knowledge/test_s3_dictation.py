"""``POST /kb/dictation``: WAV → text with the chosen speech service; nothing is kept.

Soniox's file API is a scripted fake (``AsyncSoniox``) and Whisper a fake
transcriber: this proves the route, the limits, the refusals and the cleanup,
not recognition quality.
"""

from __future__ import annotations

import io
import wave
from collections.abc import AsyncIterator, Iterator
from typing import Any

import httpx
import pytest

from skaz import asr_providers
from skaz.app import create_app
from skaz.audio import WavAudio
from skaz.config import AppConfig
from skaz.gateways.asr import TranscriptPiece
from skaz.knowledge.speech import dictation
from skaz.knowledge.speech.dictation import read_wav
from skaz.secrets import MemorySecretStore
from tests.conftest import TOKEN, FakeHttp

from .speech_support import AsyncSoniox

WAV = {"Content-Type": "audio/wav"}


def wav(seconds: float = 1.0, *, rate: int = 16_000, channels: int = 1, width: int = 2) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(channels)
        handle.setsampwidth(width)
        handle.setframerate(rate)
        handle.writeframes(b"\x01\x00" * int(seconds * rate) * channels * (width // 2 or 1))
    return buffer.getvalue()


@pytest.fixture
def cloud() -> FakeHttp:
    return FakeHttp()


@pytest.fixture
def soniox(cloud: FakeHttp) -> AsyncSoniox:
    return AsyncSoniox(cloud)


@pytest.fixture
def secrets() -> MemorySecretStore:
    store = MemorySecretStore()
    store.set("soniox", "fixture-key-not-real")
    return store


@pytest.fixture
def app(
    kb_config: AppConfig, cloud: FakeHttp, secrets: MemorySecretStore, monkeypatch: pytest.MonkeyPatch
) -> Iterator[Any]:
    monkeypatch.setattr(dictation, "POLL_S", 0.0)
    application = create_app(kb_config, secret_store=secrets, http_client=cloud.client())
    yield application
    application.state.runtime.close()


@pytest.fixture
async def api(app: Any, soniox: AsyncSoniox) -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://127.0.0.1:8765",
        headers={"Authorization": f"Bearer {TOKEN}"},
    ) as client:
        assert (await client.put("/settings", json={"cloud_consent": True})).status_code == 200
        yield client


async def test_soniox_dictation_returns_text_and_deletes_everything_at_soniox(
    api: httpx.AsyncClient,
    cloud: FakeHttp,
    soniox: AsyncSoniox,
    kb_config: AppConfig,
) -> None:
    files_before = sorted(path.name for path in kb_config.data_dir.rglob("*") if path.is_file())
    response = await api.post("/kb/dictation?language=en", content=wav(), headers=WAV)
    assert response.status_code == 200, response.text
    assert response.json() == {"text": "Hello there Hi", "language": "en", "provider": "soniox"}
    calls = [(request.method, request.url.path) for request in cloud.requests]
    job = soniox.jobs[0]
    assert ("POST", "/v1/files") in calls and ("POST", "/v1/transcriptions") in calls
    assert ("DELETE", f"/v1/transcriptions/{job}") in calls  # nothing is left at Soniox
    assert any(method == "DELETE" and path.startswith("/v1/files/") for method, path in calls)
    created = next(body for body in cloud.bodies if isinstance(body, dict) and "file_id" in body)
    assert created["language_hints"] == ["en"]
    # Nothing is stored on this Mac either: no new file in the app's data folder.
    files_after = sorted(path.name for path in kb_config.data_dir.rglob("*") if path.is_file())
    assert [
        name for name in files_after if name not in files_before and not name.endswith(("-wal", "-shm"))
    ] == []
    assert (await api.get("/kb/materials")).status_code in (200, 503)


async def test_a_failed_soniox_job_is_reported_and_still_cleaned_up(
    api: httpx.AsyncClient,
    cloud: FakeHttp,
    soniox: AsyncSoniox,
) -> None:
    soniox.failing = True
    response = await api.post("/kb/dictation", content=wav(), headers=WAV)
    assert response.status_code == 502 and "Soniox" in response.json()["detail"]
    assert soniox.deleted_jobs == soniox.jobs


@pytest.mark.parametrize(
    ("body", "status", "words"),
    [
        (b"not a wav file at all, just text" * 4, 422, "WAV"),
        (wav(channels=2), 422, "mono"),
        (wav(rate=96_000, seconds=0.1), 422, "sample rate"),
        (wav(seconds=121, rate=8_000), 422, "two minutes"),
        (wav(seconds=0), 422, "no audio"),
    ],
)
async def test_bad_audio_is_refused_before_anything_is_sent(
    api: httpx.AsyncClient,
    cloud: FakeHttp,
    body: bytes,
    status: int,
    words: str,
) -> None:
    response = await api.post("/kb/dictation", content=body, headers=WAV)
    assert response.status_code == status and words in response.json()["detail"]
    assert cloud.requests == [] or all(request.url.path == "/settings" for request in cloud.requests)


async def test_size_type_language_and_token_are_checked(app: Any, api: httpx.AsyncClient) -> None:
    big = await api.post("/kb/dictation", content=b"\x00" * (8 * 1024 * 1024 + 1), headers=WAV)
    assert big.status_code == 413
    typed = await api.post("/kb/dictation", content=wav(), headers={"Content-Type": "application/json"})
    assert typed.status_code == 415
    language = await api.post("/kb/dictation?language=xx", content=wav(), headers=WAV)
    assert language.status_code == 422
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8765"
    ) as anonymous:
        assert (await anonymous.post("/kb/dictation", content=wav(), headers=WAV)).status_code == 401


async def test_missing_key_or_consent_or_model_is_a_409_with_the_reason(
    api: httpx.AsyncClient,
    secrets: MemorySecretStore,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert (await api.put("/settings", json={"cloud_consent": False})).status_code == 200
    no_consent = await api.post("/kb/dictation", content=wav(), headers=WAV)
    assert no_consent.status_code == 409 and "Cloud processing is off" in no_consent.json()["detail"]
    assert (await api.put("/settings", json={"cloud_consent": True})).status_code == 200
    secrets.delete("soniox")
    no_key = await api.post("/kb/dictation", content=wav(), headers=WAV)
    assert no_key.status_code == 409 and "API key" in no_key.json()["detail"]

    monkeypatch.setattr(asr_providers, "local_asr_available", lambda: True)
    monkeypatch.setattr(asr_providers, "local_model_cache_present", lambda *a, **k: False)
    assert (await api.put("/settings", json={"transcription_provider": "local-whisper"})).status_code == 200
    no_model = await api.post("/kb/dictation", content=wav(), headers=WAV)
    assert no_model.status_code == 409 and "not downloaded" in no_model.json()["detail"]


async def test_whisper_on_this_mac_recognises_without_any_network(
    app: Any,
    api: httpx.AsyncClient,
    cloud: FakeHttp,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    heard: list[tuple[int, str | None]] = []

    class FakeWhisper:
        provider = "local-whisper"
        model = "small"
        can_verify_asr = True

        async def transcribe(self, audio: WavAudio, *, language: str | None) -> list[TranscriptPiece]:
            heard.append((audio.duration_ms, language))
            return [TranscriptPiece(0, 500, " Привет,", "ru"), TranscriptPiece(500, 500, " мир. ", "ru")]

    monkeypatch.setattr(asr_providers, "local_asr_available", lambda: True)
    monkeypatch.setattr(asr_providers, "local_model_cache_present", lambda *a, **k: True)
    app.state.runtime.kb_dictation._local = lambda model: FakeWhisper()
    assert (await api.put("/settings", json={"transcription_provider": "local-whisper"})).status_code == 200
    before = len(cloud.requests)
    response = await api.post("/kb/dictation", content=wav(2.0), headers=WAV)
    assert response.status_code == 200, response.text
    assert response.json() == {"text": "Привет, мир.", "language": "ru", "provider": "local_whisper"}
    assert heard == [(2000, None)] and len(cloud.requests) == before


def test_wav_reader_accepts_the_bridge_format() -> None:
    audio = read_wav(wav(1.5, rate=48_000))
    assert (audio.sample_rate, audio.duration_ms) == (48_000, 1500)
