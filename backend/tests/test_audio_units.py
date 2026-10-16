"""WAV handling units (``skaz.audio``): kept from the old audio/scope units when the scope and
context modules were removed."""

from __future__ import annotations

import pytest

from skaz.audio import InvalidAudio, parse_wav, resample_pcm16
from tests.conftest import make_wav


def test_parse_wav_reads_rate_and_duration() -> None:
    audio = parse_wav(make_wav(2.0, sample_rate=48_000), max_seconds=30)
    assert audio.sample_rate == 48_000
    assert audio.duration_ms == 2000


def test_parse_wav_rejects_garbage() -> None:
    with pytest.raises(InvalidAudio):
        parse_wav(b"not audio", max_seconds=30)


def test_parse_wav_rejects_empty_body() -> None:
    with pytest.raises(InvalidAudio):
        parse_wav(b"", max_seconds=30)


def test_round_trip_keeps_frames() -> None:
    audio = parse_wav(make_wav(0.5), max_seconds=30)
    assert parse_wav(audio.to_wav_bytes(), max_seconds=30).frames == audio.frames


def test_resampling_changes_length_proportionally() -> None:
    audio = parse_wav(make_wav(1.0, sample_rate=48_000), max_seconds=30)
    resampled = audio.resampled(16_000)
    assert resampled.sample_rate == 16_000
    assert abs(resampled.duration_ms - 1000) <= 1
    assert resampled.frame_count == 16_000


def test_resampling_is_a_noop_for_the_same_rate() -> None:
    frames = b"\x01\x00\x02\x00"
    assert resample_pcm16(frames, 16_000, 16_000) == frames


def test_float_conversion_is_normalised() -> None:
    audio = parse_wav(make_wav(0.1), max_seconds=30)
    assert all(-1.0 <= value <= 1.0 for value in audio.to_float32())


