"""Bounded whole-window speech-presence gate for the local Whisper adapter.

The detector and model are stubbed in mechanism tests.  The persistence test uses
the real HTTP, SQLite repository, and filesystem path so rejected audio remains
independently playable even when no transcript segment is produced.
"""

from __future__ import annotations

import builtins
import sys
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx
import pytest

from audiohelper.app import create_app
from audiohelper.audio import parse_wav
from audiohelper.config import AppConfig
from audiohelper.gateways import ProviderError, ProviderNotConfigured
from audiohelper.gateways import asr as asr_gateway
from audiohelper.secrets import MemorySecretStore
from tests.conftest import TOKEN, FakeHttp, make_wav


class FakeEngine:
    def __init__(self, *, fail_if_called: bool = False) -> None:
        self.fail_if_called = fail_if_called
        self.calls: list[tuple[Any, dict[str, Any]]] = []

    def transcribe(self, samples: Any, **kwargs: Any) -> tuple[list[Any], Any]:
        if self.fail_if_called:
            raise AssertionError("decoder must not run for a window without detected speech")
        self.calls.append((samples, kwargs))
        segment = SimpleNamespace(start=0.0, end=0.25, text=" spoken words ")
        return [segment], SimpleNamespace(language="en")


def _transcriber(*, gate: bool) -> asr_gateway.LocalWhisperTranscriber:
    return asr_gateway.LocalWhisperTranscriber(
        model="small",
        allow_download=False,
        speech_gate_enabled=gate,
    )


def _block_import(monkeypatch: pytest.MonkeyPatch, dependency: str) -> None:
    real_import = builtins.__import__

    def blocked_import(name: str, *args: Any, **kwargs: Any) -> Any:
        if name == dependency or name.startswith(f"{dependency}."):
            raise ModuleNotFoundError(f"No module named '{dependency}'", name=dependency)
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", blocked_import)


def test_local_speech_gate_defaults_off() -> None:
    config = AppConfig(token=TOKEN, data_dir=Path("controlled-test-data"))

    assert config.local_speech_gate is False


@pytest.mark.parametrize("value", ["1", "true", "TRUE", "yes", "on"])
def test_local_speech_gate_process_flag_accepts_explicit_true(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, value: str
) -> None:
    monkeypatch.setenv("AUDIOHELPER_TOKEN", TOKEN)
    monkeypatch.setenv("AUDIOHELPER_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("AUDIOHELPER_LOCAL_SPEECH_GATE", value)

    assert AppConfig.from_env(0).local_speech_gate is True


@pytest.mark.parametrize("value", ["0", "false", "FALSE", "no", "off", ""])
def test_local_speech_gate_process_flag_accepts_explicit_false(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, value: str
) -> None:
    monkeypatch.setenv("AUDIOHELPER_TOKEN", TOKEN)
    monkeypatch.setenv("AUDIOHELPER_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("AUDIOHELPER_LOCAL_SPEECH_GATE", value)

    assert AppConfig.from_env(0).local_speech_gate is False


def test_local_speech_gate_process_flag_rejects_ambiguous_value(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("AUDIOHELPER_TOKEN", TOKEN)
    monkeypatch.setenv("AUDIOHELPER_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("AUDIOHELPER_LOCAL_SPEECH_GATE", "sometimes")

    with pytest.raises(SystemExit, match="AUDIOHELPER_LOCAL_SPEECH_GATE"):
        AppConfig.from_env(0)


def test_detector_dependency_failure_is_explicit_not_silence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setitem(sys.modules, "faster_whisper.vad", None)

    with pytest.raises(ProviderNotConfigured) as caught:
        asr_gateway.detect_speech_presence([0.0])

    assert "unavailable" in str(caught.value).lower()


def test_detector_runtime_failure_does_not_leak_provider_detail(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    private_detail = "/Users/private/cache/model.bin Authorization: Bearer SECRET"
    fake_vad = SimpleNamespace(
        get_speech_timestamps=lambda _samples: (_ for _ in ()).throw(OSError(private_detail))
    )
    monkeypatch.setitem(sys.modules, "faster_whisper.vad", fake_vad)

    with pytest.raises(ProviderError) as caught:
        asr_gateway.detect_speech_presence([0.0])

    assert private_detail not in str(caught.value)
    assert "speech presence" in str(caught.value).lower()


async def test_no_speech_returns_empty_without_decoder(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = FakeEngine(fail_if_called=True)
    monkeypatch.setattr(asr_gateway, "detect_speech_presence", lambda _samples: False, raising=False)
    transcriber = _transcriber(gate=True)
    monkeypatch.setattr(transcriber, "_engine", lambda: engine)

    pieces = await transcriber.transcribe(
        parse_wav(make_wav(0.25), max_seconds=1.0), language="auto"
    )

    assert pieces == []
    assert engine.calls == []


async def test_speech_presence_passes_same_full_resampled_array_to_decoder(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = FakeEngine()
    detector_inputs: list[Any] = []

    def speech_present(samples: Any) -> bool:
        detector_inputs.append(samples)
        return True

    monkeypatch.setattr(asr_gateway, "detect_speech_presence", speech_present, raising=False)
    transcriber = _transcriber(gate=True)
    monkeypatch.setattr(transcriber, "_engine", lambda: engine)
    audio = parse_wav(make_wav(0.25, sample_rate=8_000), max_seconds=1.0)
    expected = audio.resampled(asr_gateway.WHISPER_SAMPLE_RATE).to_float32()

    pieces = await transcriber.transcribe(audio, language="ru")

    assert [piece.text for piece in pieces] == ["spoken words"]
    assert len(engine.calls) == 1
    decoder_samples, kwargs = engine.calls[0]
    assert detector_inputs == [decoder_samples]
    assert decoder_samples.tolist() == pytest.approx(expected)
    assert kwargs["vad_filter"] is False
    assert kwargs["language"] == "ru"


async def test_speech_detection_failure_is_sanitized(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    private_detail = "/Users/private/audio.wav Authorization: Bearer SECRET"

    def detector_failure(_samples: Any) -> bool:
        raise OSError(private_detail)

    monkeypatch.setattr(asr_gateway, "detect_speech_presence", detector_failure, raising=False)
    transcriber = _transcriber(gate=True)
    monkeypatch.setattr(transcriber, "_engine", lambda: FakeEngine(fail_if_called=True))

    with pytest.raises(ProviderError) as caught:
        await transcriber.transcribe(
            parse_wav(make_wav(0.25), max_seconds=1.0), language="auto"
        )

    assert private_detail not in str(caught.value)
    assert "speech presence" in str(caught.value).lower()


async def test_missing_speech_detector_dependency_is_not_silence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    dependency_error = ProviderNotConfigured("Local speech presence detector is unavailable.")

    def dependency_missing(_samples: Any) -> bool:
        raise dependency_error

    monkeypatch.setattr(asr_gateway, "detect_speech_presence", dependency_missing, raising=False)
    transcriber = _transcriber(gate=True)
    monkeypatch.setattr(transcriber, "_engine", lambda: FakeEngine(fail_if_called=True))

    with pytest.raises(ProviderNotConfigured, match="unavailable"):
        await transcriber.transcribe(
            parse_wav(make_wav(0.25), max_seconds=1.0), language="auto"
        )


@pytest.mark.parametrize("gate", [False, True])
async def test_missing_numpy_uses_local_asr_dependency_error(
    monkeypatch: pytest.MonkeyPatch, gate: bool
) -> None:
    _block_import(monkeypatch, "numpy")

    with pytest.raises(asr_gateway.LocalAsrDependencyMissing) as caught:
        await _transcriber(gate=gate).transcribe(
            parse_wav(make_wav(0.25), max_seconds=1.0), language="auto"
        )

    assert str(caught.value) == asr_gateway.LOCAL_ASR_DEPENDENCY_DETAIL


@pytest.mark.parametrize("gate", [False, True])
@pytest.mark.parametrize("dependency", ["numpy", "faster_whisper"])
async def test_missing_local_asr_dependency_is_safe_api_error(
    config: AppConfig,
    outbound: FakeHttp,
    monkeypatch: pytest.MonkeyPatch,
    gate: bool,
    dependency: str,
) -> None:
    application = create_app(
        replace(config, local_speech_gate=gate),
        secret_store=MemorySecretStore(),
        http_client=outbound.client(),
    )
    monkeypatch.setattr(asr_gateway.LocalWhisperTranscriber, "_models", {})
    _block_import(monkeypatch, dependency)

    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=application),
            base_url="http://127.0.0.1:8765",
            headers={"Authorization": f"Bearer {TOKEN}"},
        ) as client:
            created = await client.post("/sessions", json={"title": "missing local dependency"})
            response = await client.post(
                f"/sessions/{created.json()['id']}/audio",
                params={"sequence": 0, "start_ms": 0, "end_ms": 250},
                content=make_wav(0.25),
                headers={"Content-Type": "audio/wav"},
            )
    finally:
        application.state.runtime.close()

    expected_detail = (
        asr_gateway.LOCAL_SPEECH_GATE_DEPENDENCY_DETAIL
        if gate and dependency == "faster_whisper"
        else asr_gateway.LOCAL_ASR_DEPENDENCY_DETAIL
    )
    assert response.status_code == 400
    assert response.json() == {"detail": expected_detail}


async def test_disabled_gate_preserves_existing_decoder_path(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = FakeEngine()
    detector_called = False

    def detector(_samples: Any) -> bool:
        nonlocal detector_called
        detector_called = True
        return False

    monkeypatch.setattr(asr_gateway, "detect_speech_presence", detector, raising=False)
    transcriber = _transcriber(gate=False)
    monkeypatch.setattr(transcriber, "_engine", lambda: engine)
    audio = parse_wav(make_wav(0.25, sample_rate=8_000), max_seconds=1.0)
    expected = audio.resampled(asr_gateway.WHISPER_SAMPLE_RATE).to_float32()

    await transcriber.transcribe(audio, language="auto")

    assert detector_called is False
    decoder_samples, kwargs = engine.calls[0]
    assert decoder_samples.tolist() == pytest.approx(expected)
    assert kwargs["vad_filter"] is False
    assert kwargs["language"] is None


async def test_gated_silence_keeps_original_audio_playable_without_segment(
    config: AppConfig,
    outbound: FakeHttp,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    gated_config = replace(config, local_speech_gate=True)
    decoder = FakeEngine(fail_if_called=True)
    monkeypatch.setattr(asr_gateway, "detect_speech_presence", lambda _samples: False, raising=False)
    monkeypatch.setattr(asr_gateway, "load_local_whisper", lambda *_args, **_kwargs: decoder)
    application = create_app(
        gated_config,
        secret_store=MemorySecretStore(),
        http_client=outbound.client(),
    )
    body = make_wav(0.25, sample_rate=44_100)

    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=application),
            base_url="http://127.0.0.1:8765",
            headers={"Authorization": f"Bearer {TOKEN}"},
        ) as client:
            created = await client.post("/sessions", json={"title": "controlled silence"})
            session_id = str(created.json()["id"])
            uploaded = await client.post(
                f"/sessions/{session_id}/audio",
                params={"sequence": 0, "start_ms": 0, "end_ms": 250},
                content=body,
                headers={"Content-Type": "audio/wav"},
            )
            playback = await client.get(f"/sessions/{session_id}/audio/0")
            detail = await client.get(f"/sessions/{session_id}")
    finally:
        application.state.runtime.close()

    assert uploaded.status_code == 200, uploaded.text
    assert uploaded.json()["segments"] == []
    assert detail.json()["segments"] == []
    assert playback.status_code == 200
    assert playback.content == body
    assert decoder.calls == []
