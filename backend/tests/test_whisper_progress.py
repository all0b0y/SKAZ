"""Gateway progress probes: scripted model boundary, not real ASR acceptance."""
from __future__ import annotations

import asyncio

import pytest

from skaz.gateways.whisper_stream import (
    SAMPLE_RATE,
    Decoded,
    DecodedWord,
    StreamSettings,
    WhisperStreamSession,
)


class ContinuousSpeech:
    async def speech(self, pcm: bytes) -> list[tuple[float, float]]:
        return [(0.0, len(pcm) / (2 * SAMPLE_RATE))]


class RevisingDecoder:
    redecode = True

    def __init__(self, *, empty: bool = False) -> None:
        self.calls = 0
        self.empty = empty

    def can_translate(self, target_language: str) -> bool:
        return False

    async def decode(self, pcm: bytes, **kwargs: object) -> Decoded:
        self.calls += 1
        duration = len(pcm) / (2 * SAMPLE_RATE)
        words = () if self.empty else tuple(
            DecodedWord(f" variant{self.calls}_{i}", i + 0.1, i + 0.6)
            for i in range(int(duration))
        )
        return Decoded(words, "en")

    async def translate(self, pcm: bytes, **kwargs: object) -> str:
        raise AssertionError("Translation is disabled")


async def test_empty_results_after_speech_keep_progress_and_preserve_confirmed_words() -> None:
    decoder = RevisingDecoder()
    session = WhisperStreamSession(
        StreamSettings(sample_rate=SAMPLE_RATE, label="Local Whisper"),
        decoder=decoder, vad=ContinuousSpeech(),
    )
    events = session.events()
    confirmed = []
    try:
        for second in range(1, 181):
            decoder.empty = second > 120
            await session.send_audio(b"\x01\x00" * SAMPLE_RATE)
            event = await asyncio.wait_for(anext(events), timeout=1)
            confirmed.extend(event.final_tokens)
            assert event.total_audio_proc_ms == second * 1000
            assert event.total_audio_proc_ms - event.final_audio_proc_ms < 25000
            if second > 120:
                assert not event.final_tokens
        assert confirmed
        assert session.failure_message is None
    finally:
        await session.aclose()


async def test_empty_decode_at_an_interior_pause_does_not_confirm_undecoded_tail() -> None:
    class PausedSpeech:
        async def speech(self, pcm: bytes) -> list[tuple[float, float]]:
            return [(0.0, 4.0), (5.0, 24.0)]

    session = WhisperStreamSession(
        StreamSettings(sample_rate=SAMPLE_RATE, label="Local Whisper"),
        decoder=RevisingDecoder(empty=True), vad=PausedSpeech(),
    )
    try:
        await session.send_audio(b"\x01\x00" * SAMPLE_RATE * 24)
        event = await asyncio.wait_for(anext(session.events()), timeout=1)
        assert event.total_audio_proc_ms == 24000
        assert 3800 <= event.final_audio_proc_ms <= 4100
        assert not event.final_tokens and not event.partial_tokens
    finally:
        await session.aclose()


@pytest.mark.parametrize("empty", [False, True], ids=["revised-words", "no-words"])
async def test_completed_windows_do_not_retain_unconfirmed_audio_forever(
    empty: bool, caplog: pytest.LogCaptureFixture,
) -> None:
    """A completed full window must either advance finality or report failure.

    Empty decode results are a legitimate model response even when VAD sees
    speech/noise. This probe does not prescribe claiming that speech succeeded.
    """
    caplog.set_level("INFO", logger="skaz.gateways.whisper_stream")
    decoder = RevisingDecoder(empty=empty)
    session = WhisperStreamSession(
        StreamSettings(sample_rate=SAMPLE_RATE, label="Local Whisper"),
        decoder=decoder, vad=ContinuousSpeech(),
    )
    events = session.events()
    try:
        for second in range(1, 31):
            await session.send_audio(b"\x01\x00" * SAMPLE_RATE)
            event = await asyncio.wait_for(anext(events), timeout=1)
            assert event.total_audio_proc_ms == second * 1000
            if second >= 25:
                assert event.final_audio_proc_ms > 0, (
                    "Completed full windows leave all audio unconfirmed; "
                    f"processed={event.total_audio_proc_ms} final={event.final_audio_proc_ms}"
                )
        assert "Whisper window:" in caplog.text
        assert "decode_ms=" in caplog.text and "raw_words=" in caplog.text
        assert "variant" not in caplog.text  # Never log recognized speech.
        assert sum("Whisper window:" in r.message for r in caplog.records) == 1
    finally:
        await session.aclose()
