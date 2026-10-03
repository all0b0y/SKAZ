"""Local Whisper building blocks that need no model weights: features, gates, catalog."""
from __future__ import annotations

from typing import Any

import httpx
import pytest

from skaz.gateways import LiveAsrError
from skaz.gateways.asr import LocalModelPreparations
from skaz.gateways.openai_stream import OpenAIWindowDecoder, language_code, parse_words
from skaz.gateways.whisper_local import can_translate_to_english
from skaz.gateways.whisper_stream import SAMPLE_RATE, EnergyVoiceActivity
from skaz.local_models import (
    SPEAKER_MODEL_ID,
    SPEAKER_PROVIDER,
    local_model_size,
    local_model_spec,
)
from tests.test_whisper_stream import tone


def test_fbank_matches_kaldi_layout_and_mel_filters_cover_the_band() -> None:
    np = pytest.importorskip("numpy")
    from skaz.gateways.whisper_local import _mel_banks, kaldi_fbank

    banks = _mel_banks()
    assert banks.shape == (80, 257)
    assert (banks >= 0).all() and banks[:, -1].sum() == 0  # Nyquist column is padding
    assert (banks.sum(axis=1) > 0).all()
    samples = np.sin(2 * np.pi * 440 * np.arange(SAMPLE_RATE) / SAMPLE_RATE) * 8000
    features = kaldi_fbank(samples)
    assert features.shape == (1 + (SAMPLE_RATE - 400) // 160, 80)
    # A 440 Hz tone puts its energy in the low mel bins.
    assert features.mean(axis=0).argmax() < 20
    assert kaldi_fbank(samples[:100]).shape == (0, 80)


def test_translation_support_is_limited_to_english_on_capable_checkpoints() -> None:
    assert can_translate_to_english("small")
    assert not can_translate_to_english("large-v3-turbo")
    assert not can_translate_to_english("distil-small.en")


def test_speaker_model_is_an_allowlisted_local_checkpoint_with_a_size() -> None:
    spec = local_model_spec(SPEAKER_PROVIDER, SPEAKER_MODEL_ID)
    assert spec is not None and spec.repo_id.endswith("wespeaker-voxceleb-resnet34-LM")
    assert local_model_spec(SPEAKER_PROVIDER, "../other") is None
    assert local_model_size(SPEAKER_PROVIDER, SPEAKER_MODEL_ID) == 26_600_000
    assert local_model_size("local-whisper", "small") == 484_000_000


async def test_speaker_model_reports_missing_runtime_instead_of_downloading(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Any,
) -> None:
    monkeypatch.setattr("skaz.gateways.asr.speaker_runtime_available", lambda: False)
    preparations = LocalModelPreparations(tmp_path)
    state, detail = await preparations.start(SPEAKER_MODEL_ID, SPEAKER_PROVIDER)
    assert state == "dependency_missing" and detail is not None and "local-asr" in detail


async def test_energy_gate_remembers_the_noise_floor_across_windows() -> None:
    gate = EnergyVoiceActivity()
    assert await gate.speech(tone(2, [(" a", 1.0, 1.5)]))  # quiet frames set the floor
    # A window that is speech from end to end is still speech.
    ranges = await gate.speech(tone(2, [(" b", 0.0, 2.0)]))
    assert len(ranges) == 1 and ranges[0][0] == 0.0 and ranges[0][1] > 1.9


def test_openai_word_parsing_prefers_real_timings_and_falls_back_evenly() -> None:
    timed = parse_words({"words": [{"word": "Hi", "start": 0.1, "end": 0.4},
                                   {"word": "there", "start": 0.5, "end": 9.0}]}, 1.0)
    assert [(w.text, w.start_s, w.end_s) for w in timed] == [(" Hi", 0.1, 0.4), (" there", 0.5, 1.0)]
    spread = parse_words({"text": "one two"}, 2.0)
    assert [(w.text, w.start_s, w.end_s) for w in spread] == [(" one", 0.0, 1.0), (" two", 1.0, 2.0)]
    assert language_code("Russian") == "ru" and language_code("en") == "en" and language_code(3) is None


async def test_openai_decoder_request_and_error_mapping() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if len(seen) == 1:
            return httpx.Response(200, json={"language": "english", "text": "Hello",
                                             "words": [{"word": "Hello", "start": 0.0, "end": 0.5}]})
        return httpx.Response(401, json={"error": {"message": "secret text"}})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        decoder = OpenAIWindowDecoder(http, api_key="k", model="whisper-1")
        decoded = await decoder.decode(b"\x01\x00" * SAMPLE_RATE, language=None, languages=("en", "ru"),
                                       prompt="context")
        assert decoded.language == "en" and [w.text for w in decoded.words] == [" Hello"]
        body = seen[0].content.decode("latin-1")
        assert "timestamp_granularities[]" in body and "verbose_json" in body and "context" in body
        assert seen[0].headers["authorization"] == "Bearer k"
        with pytest.raises(LiveAsrError) as error:
            await decoder.decode(b"\x01\x00" * SAMPLE_RATE, language="en", languages=None, prompt="")
        assert error.value.retryable is False and "secret" not in str(error.value)
        assert not decoder.can_translate("en")


class FakeEngine:
    """Duck-typed faster-whisper model: records calls, returns scripted segments."""

    def __init__(self, ranked: list[tuple[str, float]]) -> None:
        self.ranked = ranked
        self.calls: list[dict[str, Any]] = []

    def detect_language(self, audio: Any) -> tuple[str, float, list[tuple[str, float]]]:
        return self.ranked[0][0], self.ranked[0][1], self.ranked

    def transcribe(self, audio: Any, **options: Any) -> tuple[list[Any], Any]:
        from types import SimpleNamespace

        self.calls.append(options)
        if options.get("task") == "translate":
            return [SimpleNamespace(text=" Good afternoon.")], SimpleNamespace(language="ru")
        words = [SimpleNamespace(word=" Добрый", start=0.1, end=0.5, probability=0.9),
                 SimpleNamespace(word=" день", start=0.6, end=float("nan"), probability=0.8),
                 SimpleNamespace(word=" ", start=0.9, end=1.0, probability=0.1)]
        return [SimpleNamespace(words=words)], SimpleNamespace(language=options.get("language") or "ru")


async def test_local_decoder_restricts_language_id_to_spoken_languages() -> None:
    pytest.importorskip("numpy")
    from skaz.gateways.whisper_local import LocalWhisperDecoder

    # Whisper's top guess (Ukrainian) is not a language the user speaks: pick among ru/en.
    engine = FakeEngine([("uk", 0.6), ("ru", 0.3), ("en", 0.1)])
    decoder = LocalWhisperDecoder(engine, model="small")
    decoded = await decoder.decode(b"\x01\x00" * SAMPLE_RATE * 2, language=None, languages=("en", "ru"),
                                   prompt="Earlier text.")
    assert decoded.language == "ru"
    assert engine.calls[0]["language"] == "ru" and engine.calls[0]["word_timestamps"] is True
    assert engine.calls[0]["initial_prompt"] == "Earlier text." and engine.calls[0]["vad_filter"] is False
    # Words with unusable timing or no text are dropped rather than guessed.
    assert [(w.text, w.start_s) for w in decoded.words] == [(" Добрый", 0.1)]
    assert await decoder.translate(b"\x01\x00" * 100, source_language="ru", target_language="en") == (
        "Good afternoon.")
    assert engine.calls[-1]["task"] == "translate" and engine.calls[-1]["language"] == "ru"


async def test_language_outside_the_spoken_set_is_never_chosen() -> None:
    pytest.importorskip("numpy")
    from skaz.gateways.whisper_local import LocalWhisperDecoder

    engine = FakeEngine([("uk", 0.9), ("en", 0.02), ("ru", 0.05)])
    decoded = await LocalWhisperDecoder(engine, model="small").decode(
        b"\x01\x00" * 1000, language=None, languages=("en", "ru"), prompt="")
    assert engine.calls[0]["language"] == "ru" and decoded.language == "ru"


async def test_silero_gate_ignores_silence() -> None:
    pytest.importorskip("faster_whisper")
    from skaz.gateways.whisper_local import SileroVoiceActivity

    assert await SileroVoiceActivity().speech(b"\x00\x00" * SAMPLE_RATE * 2) == []
