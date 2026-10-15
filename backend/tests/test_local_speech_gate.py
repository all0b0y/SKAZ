"""Bounded whole-window speech-presence gate for the local Whisper adapter.

The detector and model are stubbed in mechanism tests. The HTTP tests that drove the
gate through the removed chunk-upload route went with that route.
"""

from __future__ import annotations

import builtins
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from skaz.audio import parse_wav
from skaz.config import AppConfig
from skaz.gateways import ProviderError, ProviderNotConfigured
from skaz.gateways import asr as asr_gateway
from tests.conftest import TOKEN, make_wav


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
    monkeypatch.setenv("SKAZ_TOKEN", TOKEN)
    monkeypatch.setenv("SKAZ_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("SKAZ_LOCAL_SPEECH_GATE", value)

    assert AppConfig.from_env(0).local_speech_gate is True


@pytest.mark.parametrize("value", ["0", "false", "FALSE", "no", "off", ""])
def test_local_speech_gate_process_flag_accepts_explicit_false(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, value: str
) -> None:
    monkeypatch.setenv("SKAZ_TOKEN", TOKEN)
    monkeypatch.setenv("SKAZ_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("SKAZ_LOCAL_SPEECH_GATE", value)

    assert AppConfig.from_env(0).local_speech_gate is False


def test_local_speech_gate_process_flag_rejects_ambiguous_value(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("SKAZ_TOKEN", TOKEN)
    monkeypatch.setenv("SKAZ_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("SKAZ_LOCAL_SPEECH_GATE", "sometimes")

    with pytest.raises(SystemExit, match="SKAZ_LOCAL_SPEECH_GATE"):
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
