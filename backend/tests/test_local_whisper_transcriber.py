"""The local Whisper adapter hands the whole resampled window to the decoder.

The decoder is a stub: these tests pin the call contract and the dependency error,
not recognition quality.
"""

from __future__ import annotations

import builtins
from types import SimpleNamespace
from typing import Any

import pytest

from skaz.audio import parse_wav
from skaz.gateways import asr as asr_gateway
from tests.conftest import make_wav


class FakeEngine:
    def __init__(self) -> None:
        self.calls: list[tuple[Any, dict[str, Any]]] = []

    def transcribe(self, samples: Any, **kwargs: Any) -> tuple[list[Any], Any]:
        self.calls.append((samples, kwargs))
        segment = SimpleNamespace(start=0.0, end=0.25, text=" spoken words ")
        return [segment], SimpleNamespace(language="en")


def _transcriber() -> asr_gateway.LocalWhisperTranscriber:
    return asr_gateway.LocalWhisperTranscriber(model="small", allow_download=False)


def _block_import(monkeypatch: pytest.MonkeyPatch, dependency: str) -> None:
    real_import = builtins.__import__

    def blocked_import(name: str, *args: Any, **kwargs: Any) -> Any:
        if name == dependency or name.startswith(f"{dependency}."):
            raise ModuleNotFoundError(f"No module named '{dependency}'", name=dependency)
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", blocked_import)


async def test_missing_numpy_uses_local_asr_dependency_error(monkeypatch: pytest.MonkeyPatch) -> None:
    _block_import(monkeypatch, "numpy")

    with pytest.raises(asr_gateway.LocalAsrDependencyMissing) as caught:
        await _transcriber().transcribe(parse_wav(make_wav(0.25), max_seconds=1.0), language="auto")

    assert str(caught.value) == asr_gateway.LOCAL_ASR_DEPENDENCY_DETAIL


async def test_the_decoder_gets_the_full_resampled_window(monkeypatch: pytest.MonkeyPatch) -> None:
    engine = FakeEngine()
    transcriber = _transcriber()
    monkeypatch.setattr(transcriber, "_engine", lambda: engine)
    audio = parse_wav(make_wav(0.25, sample_rate=8_000), max_seconds=1.0)
    expected = audio.resampled(asr_gateway.WHISPER_SAMPLE_RATE).to_float32()

    pieces = await transcriber.transcribe(audio, language="ru")

    assert [piece.text for piece in pieces] == ["spoken words"]
    decoder_samples, kwargs = engine.calls[0]
    assert decoder_samples.tolist() == pytest.approx(expected)
    assert kwargs["vad_filter"] is False
    assert kwargs["language"] == "ru"
