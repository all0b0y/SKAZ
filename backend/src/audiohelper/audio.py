"""WAV validation and resampling.

The renderer uploads standalone PCM16 mono WAV windows at the device sample rate.
Everything here is pure and synchronous so it can be unit tested without a server.
"""

from __future__ import annotations

import array
import io
import wave
from dataclasses import dataclass

PCM16_WIDTH = 2


class InvalidAudio(ValueError):
    """The uploaded body is not an audio chunk this backend accepts."""


@dataclass(frozen=True)
class WavAudio:
    sample_rate: int
    frames: bytes  # little-endian PCM16, mono

    @property
    def frame_count(self) -> int:
        return len(self.frames) // PCM16_WIDTH

    @property
    def duration_ms(self) -> int:
        return round(self.frame_count * 1000 / self.sample_rate)

    def to_wav_bytes(self) -> bytes:
        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(PCM16_WIDTH)
            handle.setframerate(self.sample_rate)
            handle.writeframes(self.frames)
        return buffer.getvalue()

    def resampled(self, target_rate: int) -> WavAudio:
        if target_rate == self.sample_rate:
            return self
        return WavAudio(target_rate, resample_pcm16(self.frames, self.sample_rate, target_rate))

    def to_float32(self) -> list[float]:
        samples = array.array("h")
        samples.frombytes(self.frames)
        return [value / 32768.0 for value in samples]


def parse_wav(data: bytes, *, max_seconds: float) -> WavAudio:
    """Validate an uploaded chunk, raising :class:`InvalidAudio` with a UI-ready message."""
    if not data:
        raise InvalidAudio("Empty body; expected a standalone PCM16 mono WAV chunk.")
    try:
        with wave.open(io.BytesIO(data), "rb") as handle:
            channels = handle.getnchannels()
            width = handle.getsampwidth()
            rate = handle.getframerate()
            frames = handle.readframes(handle.getnframes())
    except (wave.Error, EOFError) as error:
        raise InvalidAudio(f"Body is not a readable WAV file: {error}") from error
    if channels != 1:
        raise InvalidAudio(f"Expected mono audio, got {channels} channels.")
    if width != PCM16_WIDTH:
        raise InvalidAudio(f"Expected 16-bit PCM samples, got {width * 8}-bit.")
    if rate <= 0:
        raise InvalidAudio("WAV header declares a non-positive sample rate.")
    audio = WavAudio(rate, frames)
    if audio.frame_count == 0:
        raise InvalidAudio("WAV chunk contains no audio frames.")
    if audio.duration_ms > max_seconds * 1000:
        raise InvalidAudio(
            f"Chunk is {audio.duration_ms / 1000:.1f}s; the limit is {max_seconds:.0f}s per upload."
        )
    return audio


def resample_pcm16(frames: bytes, source_rate: int, target_rate: int) -> bytes:
    """Linear-interpolation resampling; good enough for 16 kHz ASR input."""
    if source_rate == target_rate:
        return frames
    samples = array.array("h")
    samples.frombytes(frames)
    source_count = len(samples)
    if source_count == 0:
        return b""
    target_count = max(1, round(source_count * target_rate / source_rate))
    resampled = array.array("h", bytes(target_count * PCM16_WIDTH))
    ratio = source_count / target_count
    for index in range(target_count):
        position = index * ratio
        left = int(position)
        right = min(left + 1, source_count - 1)
        weight = position - left
        resampled[index] = int(samples[left] * (1 - weight) + samples[right] * weight)
    return resampled.tobytes()
