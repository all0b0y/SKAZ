"""Near-streaming Whisper session policy with scripted decoders; no model, no network."""
from __future__ import annotations

import array
import asyncio
import math
from collections.abc import Sequence
from typing import Any

import pytest

from skaz.gateways import LiveAsrError
from skaz.gateways.soniox import SonioxEvent
from skaz.gateways.whisper_stream import (
    SAMPLE_RATE,
    Decoded,
    DecodedWord,
    SpeakerTracker,
    StreamResampler,
    StreamSettings,
    WhisperStreamSession,
    energy_speech_ranges,
    normalized_word,
)

Script = list[tuple[str, float, float]]

SCRIPT: Script = [
    (" Hello", 0.5, 0.9), (" world.", 1.0, 1.5), (" This", 1.6, 1.9), (" is", 2.0, 2.2),
    (" a", 2.3, 2.4), (" test.", 2.5, 3.0), (" Second", 5.0, 5.5), (" part.", 5.6, 6.2),
]


def tone(seconds: float, script: Script, *, rate: int = SAMPLE_RATE) -> bytes:
    """A tone wherever the script has a word, digital silence elsewhere."""
    out = array.array("h")
    for index in range(int(seconds * rate)):
        t = index / rate
        speaking = any(a - 0.05 <= t <= b + 0.05 for _, a, b in script)
        out.append(int(8000 * math.sin(2 * math.pi * 300 * t)) if speaking else 0)
    return out.tobytes()


class ScriptedVad:
    """Energy VAD that also remembers where the decoder's crop will start (test only)."""

    def __init__(self) -> None:
        self.session: WhisperStreamSession | None = None
        self.crop_start = 0.0

    async def speech(self, pcm: bytes) -> list[tuple[float, float]]:
        ranges = energy_speech_ranges(pcm)
        assert self.session is not None
        start = self.session._buffer_start / SAMPLE_RATE
        self.crop_start = max(start, start + ranges[0][0] - 0.2) if ranges else start
        return ranges


class ScriptedDecoder:
    """Hears whole words inside the window; a word cut by the window edge is misheard."""

    def __init__(self, vad: ScriptedVad, script: Script = SCRIPT, *, redecode: bool = True,
                 language: str = "en", translation: str = "Translated.") -> None:
        self.vad = vad
        self.script = script
        self.redecode = redecode
        self.language = language
        self.translation = translation
        self.calls: list[str] = []
        self.translations: list[tuple[str | None, str]] = []

    def can_translate(self, target_language: str) -> bool:
        return target_language == "en"

    async def translate(self, pcm: bytes, *, source_language: str | None, target_language: str) -> str:
        self.translations.append((source_language, target_language))
        return self.translation

    async def decode(self, pcm: bytes, *, language: str | None, languages: tuple[str, ...] | None,
                     prompt: str) -> Decoded:
        self.calls.append(prompt)
        start = self.vad.crop_start
        duration = len(pcm) / 2 / SAMPLE_RATE
        words = []
        for text, a, b in self.script:
            if a >= start - 0.01 and b <= start + duration + 0.01:
                words.append(DecodedWord(text, a - start, b - start, 0.9))
            elif start <= a < start + duration:
                words.append(DecodedWord(text + "~", a - start, duration, 0.4))
        return Decoded(tuple(words), language or self.language)


async def run(session: WhisperStreamSession, pcm: bytes, *, frame_s: float = 0.5,
              rate: int = SAMPLE_RATE) -> list[SonioxEvent]:
    events: list[SonioxEvent] = []

    async def receive() -> None:
        async for event in session.events():
            events.append(event)

    receiver = asyncio.create_task(receive())
    step = int(frame_s * rate) * 2
    for offset in range(0, len(pcm), step):
        await session.send_audio(pcm[offset:offset + step])
        await asyncio.sleep(0)
        await asyncio.sleep(0)
    await session.finish()
    await session.aclose()
    await receiver
    return events


def make(decoder: Any, vad: ScriptedVad, **settings: Any) -> WhisperStreamSession:
    speakers = settings.pop("speakers", None)
    session = WhisperStreamSession(
        StreamSettings(sample_rate=settings.pop("sample_rate", SAMPLE_RATE), label="Local Whisper",
                       **settings),
        decoder=decoder, vad=vad, speakers=speakers,
    )
    vad.session = session
    return session


def finals(events: Sequence[SonioxEvent]) -> list[str]:
    return [token.text for event in events for token in event.final_tokens]


async def test_local_agreement_confirms_words_once_and_keeps_clocks_monotonic() -> None:
    vad = ScriptedVad()
    decoder = ScriptedDecoder(vad)
    events = await run(make(decoder, vad), tone(8, SCRIPT))

    assert finals(events) == [text for text, _, _ in SCRIPT]
    # A word cut by the window edge is only ever provisional, never final.
    assert all(not token.text.endswith("~") for event in events for token in event.final_tokens)
    assert any(token.text.endswith("~") for event in events for token in event.partial_tokens)
    finals_ms = [event.final_audio_proc_ms for event in events]
    totals = [event.total_audio_proc_ms for event in events]
    assert finals_ms == sorted(finals_ms) and totals == sorted(totals)
    assert all(e.final_audio_proc_ms <= e.total_audio_proc_ms for e in events)
    assert events[-1].finished and events[-1].final_audio_proc_ms == events[-1].total_audio_proc_ms == 8000
    for event in events:
        for token in (*event.final_tokens, *event.partial_tokens):
            assert 0 <= token.start_ms < token.end_ms <= event.total_audio_proc_ms
            assert token.speaker == "1" and token.language == "en"


async def test_prompt_carries_only_text_already_trimmed_out_of_the_window() -> None:
    vad = ScriptedVad()
    decoder = ScriptedDecoder(vad)
    await run(make(decoder, vad), tone(8, SCRIPT))
    # After the first pause the window restarts: the committed sentence becomes context.
    assert any("Hello world. This is a test." in prompt for prompt in decoder.calls)
    assert decoder.calls[0] == ""


async def test_words_placed_in_silence_are_dropped_as_hallucinations() -> None:
    vad = ScriptedVad()
    script = [*SCRIPT[:2]]
    decoder = ScriptedDecoder(vad, [*script, (" Subscribe!", 3.5, 4.0)])
    events = await run(make(decoder, vad), tone(5, script))
    assert finals(events) == [" Hello", " world."]


async def test_utterance_mode_sends_each_phrase_once_and_has_no_partials() -> None:
    vad = ScriptedVad()
    decoder = ScriptedDecoder(vad, redecode=False)
    events = await run(make(decoder, vad, min_step_s=0.5, trim_after_s=10.0, max_window_s=15.0),
                       tone(8, SCRIPT))
    assert finals(events) == [text for text, _, _ in SCRIPT]
    assert all(not event.partial_tokens for event in events)
    assert len(decoder.calls) == 2  # one request per utterance


async def test_resampled_input_keeps_provider_clock_within_submitted_audio() -> None:
    vad = ScriptedVad()
    decoder = ScriptedDecoder(vad)
    events = await run(make(decoder, vad, sample_rate=48_000), tone(8, SCRIPT, rate=48_000), rate=48_000)
    assert finals(events) == [text for text, _, _ in SCRIPT]
    assert events[-1].total_audio_proc_ms == 8000


class TwoVoices:
    """Voice embedding by time: the second utterance is another speaker."""

    def __init__(self, session_ref: list[WhisperStreamSession]) -> None:
        self.calls = 0

    async def embed(self, pcm: bytes) -> Sequence[float] | None:
        self.calls += 1
        return [1.0, 0.0] if self.calls <= 2 else [0.0, 1.0]


async def test_speaker_tracker_labels_voices_consistently() -> None:
    tracker = SpeakerTracker(TwoVoices([]), min_seconds=0.0)
    labels = [await tracker.assign(b"\x00\x00" * 100) for _ in range(4)]
    assert labels == ["1", "1", "2", "2"]


async def test_speaker_tracker_keeps_current_speaker_for_short_stretches() -> None:
    class Always:
        async def embed(self, pcm: bytes) -> Sequence[float]:
            raise AssertionError("short speech is never embedded")

    tracker = SpeakerTracker(Always(), min_seconds=1.0)
    assert await tracker.assign(b"\x00\x00" * 100) == "1"


async def test_without_a_speaker_model_every_word_is_speaker_one() -> None:
    vad = ScriptedVad()
    events = await run(make(ScriptedDecoder(vad), vad, speakers=SpeakerTracker(None)), tone(8, SCRIPT))
    assert {token.speaker for event in events for token in event.final_tokens} == {"1"}


async def test_translation_follows_its_sentence_in_provider_order() -> None:
    vad = ScriptedVad()
    decoder = ScriptedDecoder(vad, language="ru")
    events = await run(make(decoder, vad, translation_target_language="en"), tone(8, SCRIPT))
    originals = [t for e in events for t in e.final_tokens]
    translated = [t for e in events for t in e.final_translation_tokens]
    assert originals and translated
    assert decoder.translations and all(pair == ("ru", "en") for pair in decoder.translations)
    assert all(t.language == "en" and t.source_language == "ru" and t.speaker == "1" for t in translated)
    for event in events:
        assert event.token_order is not None
        statuses = [ref.translation_status for ref in event.token_order if ref.is_final]
        # Originals first, then the translation that belongs to them.
        assert statuses == sorted(statuses, key=lambda status: status == "translation")
        assert set(statuses) <= {"original", "translation"}


async def test_target_language_speech_is_not_translated() -> None:
    vad = ScriptedVad()
    decoder = ScriptedDecoder(vad, language="en")
    events = await run(make(decoder, vad, translation_target_language="en"), tone(8, SCRIPT))
    assert not decoder.translations
    assert all(ref.translation_status == "none" for e in events for ref in e.token_order or ())


def test_unsupported_translation_target_is_refused_before_any_audio() -> None:
    vad = ScriptedVad()

    async def build() -> None:
        make(ScriptedDecoder(vad), vad, translation_target_language="de")

    with pytest.raises(LiveAsrError, match="cannot translate into 'de'") as error:
        asyncio.run(build())
    assert error.value.retryable is False


async def test_a_decoder_that_cannot_keep_up_fails_with_a_clear_non_retryable_reason() -> None:
    vad = ScriptedVad()

    class Slow(ScriptedDecoder):
        async def decode(self, pcm: bytes, **kwargs: Any) -> Decoded:
            await asyncio.sleep(0.3)
            return Decoded((), "en")

    session = make(Slow(vad), vad, max_backlog_s=2.0)
    second = tone(1, [(" x", 0.0, 1.0)])
    receiver = asyncio.create_task(_drain(session))
    with pytest.raises(LiveAsrError, match="cannot keep up"):
        for _ in range(200):  # audio arrives far faster than the decoder finishes
            await session.send_audio(second)
            await asyncio.sleep(0.01)
    await session.finish()
    await session.aclose()
    await receiver
    assert session.failure_message is not None and "cannot keep up" in session.failure_message
    assert session.failure_retryable is False


async def _drain(session: WhisperStreamSession) -> None:
    async for _event in session.events():
        pass


def test_resampler_output_never_exceeds_submitted_duration() -> None:
    for rate in (48_000, 44_100, 22_050, 32_000, 16_000, 8_000):
        resampler = StreamResampler(rate)
        produced = 0
        submitted = 0
        for size in (1, 7, 441, 4800, 12_345, 1000):
            produced += len(resampler.feed(b"\x10\x00" * size)) // 2
            submitted += size
            assert produced * rate <= submitted * SAMPLE_RATE
        assert produced >= submitted * SAMPLE_RATE // rate - 2


def test_energy_ranges_find_speech_and_pauses() -> None:
    ranges = energy_speech_ranges(tone(4, [(" a", 0.5, 1.0), (" b", 2.5, 3.0)]))
    assert len(ranges) == 2
    assert ranges[0][0] == pytest.approx(0.45, abs=0.05) and ranges[1][1] == pytest.approx(3.05, abs=0.05)
    assert energy_speech_ranges(b"\x00\x00" * SAMPLE_RATE) == []


def test_normalized_word_ignores_case_and_punctuation() -> None:
    assert normalized_word(" World.") == normalized_word("world") == "world"
    assert normalized_word(" Привет!") == "привет"
