"""On-device pieces of the live Local Whisper provider.

* :class:`LocalWhisperDecoder` — faster-whisper (CTranslate2) window decoding with
  word timestamps, restricted language identification and English translation.
* :class:`SileroVoiceActivity` — the Silero VAD model bundled with faster-whisper.
* :class:`OnnxSpeakerEmbedder` — a WeSpeaker ResNet34 voice-embedding model run
  with ONNX Runtime (already a faster-whisper dependency), fed Kaldi-compatible
  log-mel filterbank features computed here with NumPy.

Nothing here downloads anything or opens a network connection: models are loaded
from the local cache that the explicit preparation step filled.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from . import LiveAsrError
from .asr import _to_thread_until_finished
from .whisper_stream import SAMPLE_RATE, Decoded, DecodedWord

#: Checkpoints that were trained without the translate task, or are English-only.
_NO_TRANSLATE = frozenset({"large-v3-turbo", "distil-small.en", "distil-large-v3"})


def can_translate_to_english(model: str) -> bool:
    """Whisper's own translate task only produces English, and not on every checkpoint."""
    return model not in _NO_TRANSLATE and not model.endswith(".en")


def _floats(pcm: bytes) -> Any:
    import numpy as np

    return np.frombuffer(pcm[: len(pcm) - len(pcm) % 2], dtype="<i2").astype(np.float32) / 32768.0


class LocalWhisperDecoder:
    redecode = True

    def __init__(self, engine: Any, *, model: str, beam_size: int = 5) -> None:
        self._engine = engine
        self._model = model
        self._beam_size = beam_size

    def can_translate(self, target_language: str) -> bool:
        return target_language == "en" and can_translate_to_english(self._model)

    async def decode(
        self, pcm: bytes, *, language: str | None, languages: tuple[str, ...] | None, prompt: str,
    ) -> Decoded:
        return await _to_thread_until_finished(self._decode, pcm, language, languages, prompt)

    def _decode(self, pcm: bytes, language: str | None, languages: tuple[str, ...] | None,
                prompt: str) -> Decoded:
        audio = _floats(pcm)
        if not len(audio):
            return Decoded((), language)
        if language is None and languages:
            language = self._identify(audio, languages)
        try:
            segments, info = self._engine.transcribe(
                audio, language=language, task="transcribe", beam_size=self._beam_size,
                word_timestamps=True, vad_filter=False, condition_on_previous_text=False,
                initial_prompt=prompt or None, without_timestamps=False,
            )
            words: list[DecodedWord] = []
            for segment in segments:
                for word in getattr(segment, "words", None) or ():
                    text = str(getattr(word, "word", ""))
                    start, end = float(word.start), float(word.end)
                    if text.strip() and math.isfinite(start) and math.isfinite(end):
                        words.append(DecodedWord(text, start, max(start, end),
                                                 float(getattr(word, "probability", 1.0))))
        except Exception as error:
            raise LiveAsrError("Local Whisper could not decode the audio.", retryable=True) from error
        return Decoded(tuple(words), language or getattr(info, "language", None))

    def _identify(self, audio: Any, languages: tuple[str, ...]) -> str | None:
        """Pick the most likely language among the user's spoken languages only."""
        if len(languages) == 1:
            return languages[0]
        # Even on a short phrase, a guess restricted to the spoken languages beats an
        # unrestricted one (which can label Russian speech as Ukrainian, say).
        try:
            _language, _probability, ranked = self._engine.detect_language(audio)
        except Exception:
            return None
        allowed = [(code, probability) for code, probability in ranked if code in languages]
        return max(allowed, key=lambda item: item[1])[0] if allowed else None

    async def translate(self, pcm: bytes, *, source_language: str | None, target_language: str) -> str:
        if not self.can_translate(target_language):
            raise LiveAsrError("This Local Whisper model cannot translate.", retryable=False)
        return await _to_thread_until_finished(self._translate, pcm, source_language)

    def _translate(self, pcm: bytes, source_language: str | None) -> str:
        audio = _floats(pcm)
        if not len(audio):
            return ""
        try:
            segments, _info = self._engine.transcribe(
                audio, language=source_language, task="translate", beam_size=self._beam_size,
                vad_filter=False, condition_on_previous_text=False,
            )
            return " ".join(str(segment.text).strip() for segment in segments).strip()
        except Exception as error:
            raise LiveAsrError("Local Whisper could not translate the audio.", retryable=True) from error


class SileroVoiceActivity:
    """faster-whisper's bundled Silero VAD (ONNX), tuned to find short pauses."""

    def __init__(self, *, min_silence_ms: int = 300, threshold: float = 0.5) -> None:
        self._min_silence_ms = min_silence_ms
        self._threshold = threshold

    async def speech(self, pcm: bytes) -> list[tuple[float, float]]:
        return await _to_thread_until_finished(self._speech, pcm)

    def _speech(self, pcm: bytes) -> list[tuple[float, float]]:
        from faster_whisper.vad import VadOptions, get_speech_timestamps

        audio = _floats(pcm)
        if len(audio) < SAMPLE_RATE // 10:
            return []
        options = VadOptions(threshold=self._threshold, min_silence_duration_ms=self._min_silence_ms,
                             speech_pad_ms=30, min_speech_duration_ms=150)
        return [(item["start"] / SAMPLE_RATE, item["end"] / SAMPLE_RATE)
                for item in get_speech_timestamps(audio, options)]


# ── Speaker embeddings ───────────────────────────────────────────────────────

_FRAME = 400  # 25 ms
_SHIFT = 160  # 10 ms
_FFT = 512
_MEL_BINS = 80


def _mel(frequency: Any) -> Any:
    import numpy as np

    return 1127.0 * np.log(1.0 + np.asarray(frequency) / 700.0)


def _mel_banks() -> Any:
    """Kaldi's triangular mel filters (low 20 Hz, high Nyquist), shape (80, 257)."""
    import numpy as np

    fft_bins = _FFT // 2
    bin_width = SAMPLE_RATE / _FFT
    mel_low, mel_high = _mel(20.0), _mel(SAMPLE_RATE / 2)
    delta = (mel_high - mel_low) / (_MEL_BINS + 1)
    left = mel_low + np.arange(_MEL_BINS)[:, None] * delta
    center, right = left + delta, left + 2 * delta
    mel = _mel(bin_width * np.arange(fft_bins))[None, :]
    up = (mel - left) / (center - left)
    down = (right - mel) / (right - center)
    banks = np.maximum(0.0, np.minimum(up, down))
    return np.pad(banks, ((0, 0), (0, 1)))


_BANKS: Any = None


def kaldi_fbank(samples: Any) -> Any:
    """80-dim log-mel filterbank matching ``torchaudio.compliance.kaldi.fbank``.

    Options follow WeSpeaker's front end: 25/10 ms frames, no dither, DC removal,
    0.97 pre-emphasis, Hamming window, 512-point power spectrum. ``samples`` is a
    float array on the int16 scale.
    """
    import numpy as np

    global _BANKS
    if _BANKS is None:
        _BANKS = _mel_banks()
    samples = np.asarray(samples, dtype=np.float64)
    if len(samples) < _FRAME:
        return np.zeros((0, _MEL_BINS), dtype=np.float32)
    count = 1 + (len(samples) - _FRAME) // _SHIFT
    index = np.arange(_FRAME)[None, :] + _SHIFT * np.arange(count)[:, None]
    frames = samples[index]
    frames = frames - frames.mean(axis=1, keepdims=True)
    shifted = np.concatenate([frames[:, :1], frames[:, :-1]], axis=1)
    frames = frames - 0.97 * shifted
    window = 0.54 - 0.46 * np.cos(2 * np.pi * np.arange(_FRAME) / (_FRAME - 1))
    spectrum = np.abs(np.fft.rfft(frames * window, n=_FFT)) ** 2
    energies = spectrum @ _BANKS.T
    return np.log(np.maximum(energies, np.finfo(np.float32).eps)).astype(np.float32)


class OnnxSpeakerEmbedder:
    """WeSpeaker ONNX voice embeddings; one CPU inference per committed stretch."""

    def __init__(self, model_path: Path) -> None:
        try:
            import onnxruntime
        except ImportError as error:
            raise LiveAsrError("Speaker separation needs the 'local-asr' backend extra.") from error
        options = onnxruntime.SessionOptions()
        options.intra_op_num_threads = 1
        options.inter_op_num_threads = 1
        self._session = onnxruntime.InferenceSession(
            str(model_path), sess_options=options, providers=["CPUExecutionProvider"],
        )
        self._input = self._session.get_inputs()[0].name

    async def embed(self, pcm: bytes) -> Sequence[float] | None:
        return await _to_thread_until_finished(self._embed, pcm)

    def _embed(self, pcm: bytes) -> Sequence[float] | None:
        import numpy as np

        samples = np.frombuffer(pcm[: len(pcm) - len(pcm) % 2], dtype="<i2").astype(np.float32)
        features = kaldi_fbank(samples)
        if len(features) < 50:
            return None
        features = features - features.mean(axis=0, keepdims=True)
        output = self._session.run(None, {self._input: features[None, :, :]})[0]
        vector = np.asarray(output, dtype=np.float32).reshape(-1)
        return [float(value) for value in vector]
