"""Near-streaming Whisper-family sessions in the native live event shape.

Whisper decodes whole windows, not a word stream. This module turns it into a
live session the same way ufal/whisper_streaming and collabora/WhisperLive do:

* Audio accumulates in a bounded window that starts at the last committed word.
* The window is re-decoded whenever enough new audio has arrived and the previous
  decode has finished (so a slow machine decodes less often, not later and later).
* **LocalAgreement-2:** a word becomes *final* only once two consecutive decodes
  agree on it; the rest of the latest hypothesis is the replaceable *partial* tail.
* A voice-activity gate skips silent windows (Whisper invents text on silence) and
  an endpoint — a pause, or Stop — commits the whole remaining hypothesis.
* Committed audio is trimmed at a committed word boundary, and the recent committed
  text is passed back as the decoding prompt so context survives the trim.

A paid cloud decoder does not re-decode: it is sent each utterance once, at its
endpoint, and so produces final text only (``redecode = False``).

Everything is expressed as :class:`~.soniox.SonioxEvent` values, so storage,
speaker numbering, translation projection and recovery are shared with Soniox.
Speaker labels come from an optional local voice-embedding tracker; translation
from an optional decoder capability. Neither is ever faked: without them every
word belongs to speaker ``"1"`` and there are no translation tokens.
"""

from __future__ import annotations

import array
import asyncio
import contextlib
import math
import re
import unicodedata
from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass, field
from typing import Literal, Protocol

from . import LiveAsrError
from .soniox import SonioxEvent, SonioxToken, SonioxTokenRef, SonioxTranslationToken

SAMPLE_RATE = 16_000
BYTES_PER_SECOND = SAMPLE_RATE * 2
#: How much committed text is fed back to the decoder as context.
PROMPT_CHARS = 200
#: Words are compared by this many trailing committed words to drop re-decoded overlap.
OVERLAP_WORDS = 5
#: Speech is padded by this much when judging whether a word is real or hallucinated.
SPEECH_PAD_S = 0.3
_SENTENCE_END = re.compile(r"[.!?…。！？]['\"»”)]*$")


@dataclass(frozen=True)
class DecodedWord:
    """One recognized word; times are seconds relative to the decoded audio."""

    text: str
    start_s: float
    end_s: float
    probability: float = 1.0


@dataclass(frozen=True)
class Decoded:
    words: tuple[DecodedWord, ...]
    language: str | None


class WindowDecoder(Protocol):
    """Decodes one bounded 16 kHz PCM16 mono window."""

    #: Re-decode a growing window (cheap local inference) or decode each utterance once.
    redecode: bool

    async def decode(
        self, pcm: bytes, *, language: str | None, languages: tuple[str, ...] | None, prompt: str,
    ) -> Decoded: ...

    def can_translate(self, target_language: str) -> bool: ...

    async def translate(self, pcm: bytes, *, source_language: str | None, target_language: str) -> str: ...


class VoiceActivity(Protocol):
    """Speech ranges, in seconds, inside one 16 kHz PCM16 mono window."""

    async def speech(self, pcm: bytes) -> list[tuple[float, float]]: ...


class SpeakerEmbedder(Protocol):
    async def embed(self, pcm: bytes) -> Sequence[float] | None: ...


@dataclass(frozen=True)
class StreamSettings:
    sample_rate: int
    label: str
    used_languages: tuple[str, ...] | None = None
    translation_target_language: str | None = None
    #: Minimum new audio before another decode of the same window.
    min_step_s: float = 1.0
    #: Trailing silence that ends an utterance and commits its whole hypothesis.
    endpoint_silence_s: float = 0.8
    #: Past this window length the buffer is trimmed at the last committed word.
    trim_after_s: float = 12.0
    #: A window never grows past this; the hypothesis is force-committed first.
    max_window_s: float = 24.0
    #: Received-but-undecoded audio beyond this means the decoder cannot keep up.
    max_backlog_s: float = 12.0
    event_queue_size: int = 8
    #: None: Stop waits for the last decode to finish, however long it takes.
    finish_timeout_s: float | None = None

    def __post_init__(self) -> None:
        if (isinstance(self.sample_rate, bool) or not isinstance(self.sample_rate, int)
                or not 8_000 <= self.sample_rate <= 48_000):
            raise ValueError("sample_rate must be an integer between 8000 and 48000 Hz")
        if not 0 < self.min_step_s <= self.trim_after_s < self.max_window_s:
            raise ValueError("window thresholds must be ordered")


class StreamResampler:
    """Incremental PCM16 mono resampler to 16 kHz with no drift across frames.

    Integer ratios (48/32/16 kHz) average whole blocks, which also acts as a simple
    anti-alias filter; other rates use linear interpolation with a carried phase.
    The output count never exceeds the exact input duration, so the provider clock
    can never claim more audio than was submitted.
    """

    def __init__(self, source_rate: int) -> None:
        self._rate = source_rate
        self._ratio = source_rate // SAMPLE_RATE if source_rate % SAMPLE_RATE == 0 else 0
        self._pending = array.array("h")
        self._consumed = 0  # source samples before _pending
        self._produced = 0

    def feed(self, pcm: bytes) -> bytes:
        samples = array.array("h")
        samples.frombytes(pcm)
        self._pending.extend(samples)
        if self._ratio == 1:
            out = self._pending
            self._consumed += len(out)
            self._produced += len(out)
            self._pending = array.array("h")
            return out.tobytes()
        if self._ratio:
            blocks = len(self._pending) // self._ratio
            ratio = self._ratio
            data = self._pending
            out = array.array("h", (
                int(sum(data[index * ratio:(index + 1) * ratio]) / ratio) for index in range(blocks)
            ))
            used = blocks * ratio
            self._pending = data[used:]
            self._consumed += used
            self._produced += blocks
            return out.tobytes()
        return self._interpolate()

    def _interpolate(self) -> bytes:
        data = self._pending
        total_source = self._consumed + len(data)
        # Output sample n sits at source position n * rate / 16000; it needs position + 1.
        available = max(0, min(total_source * SAMPLE_RATE // self._rate,
                                (total_source - 1) * SAMPLE_RATE // self._rate + 1))
        out = array.array("h")
        step = self._rate / SAMPLE_RATE
        for index in range(self._produced, available):
            position = index * step - self._consumed
            left = int(position)
            if left + 1 >= len(data):
                available = index
                break
            weight = position - left
            out.append(int(data[left] * (1 - weight) + data[left + 1] * weight))
        self._produced += len(out)
        keep_from = max(0, int(self._produced * step - self._consumed) - 1)
        self._pending = data[keep_from:]
        self._consumed += keep_from
        return out.tobytes()


class EnergyVoiceActivity:
    """Dependency-free speech gate: 30 ms frame energy against a tracked noise floor.

    Used only when Silero VAD (faster-whisper) is not installed. The noise floor is
    remembered across windows, because a window full of speech has no quiet frames
    to measure it from. It errs towards "speech": its jobs are to avoid paying for,
    or hallucinating on, clear silence and to find pauses.
    """

    def __init__(self, *, min_rms: float = 250.0, ratio: float = 2.5) -> None:
        self._min_rms = min_rms
        self._ratio = ratio
        self._floor: float | None = None

    async def speech(self, pcm: bytes) -> list[tuple[float, float]]:
        energies = frame_energies(pcm)
        if energies:
            quiet = sorted(energies)[len(energies) // 10]
            # The floor may fall at once but rises only slowly, so speech cannot raise it.
            self._floor = quiet if self._floor is None else min(quiet, self._floor * 1.05 + 1.0)
        return energy_speech_ranges(pcm, floor=self._floor or 0.0, min_rms=self._min_rms, ratio=self._ratio)


FRAME = 480  # 30 ms


def frame_energies(pcm: bytes) -> list[float]:
    samples = array.array("h")
    samples.frombytes(pcm[: len(pcm) - len(pcm) % 2])
    return [
        math.sqrt(sum(value * value for value in samples[start:start + FRAME]) / FRAME)
        for start in range(0, len(samples) - FRAME + 1, FRAME)
    ]


def energy_speech_ranges(
    pcm: bytes, *, floor: float = 0.0, min_rms: float = 250.0, ratio: float = 2.5,
    min_speech_s: float = 0.15, min_silence_s: float = 0.3,
) -> list[tuple[float, float]]:
    """Frames louder than ``max(min_rms, floor * ratio)``, merged across short pauses."""
    threshold = max(min_rms, floor * ratio)
    frame_s = FRAME / SAMPLE_RATE
    ranges: list[tuple[float, float]] = []
    for index, energy in enumerate(frame_energies(pcm)):
        if energy < threshold:
            continue
        start_s, end_s = index * frame_s, (index + 1) * frame_s
        if ranges and start_s - ranges[-1][1] < min_silence_s:
            ranges[-1] = (ranges[-1][0], end_s)
        else:
            ranges.append((start_s, end_s))
    return [item for item in ranges if item[1] - item[0] >= min_speech_s]


class SpeakerTracker:
    """Online speaker clustering over local voice embeddings.

    Each committed stretch of speech long enough to carry a voiceprint is compared
    with running speaker centroids by cosine similarity; a close match joins that
    speaker, otherwise a new speaker starts (up to ``max_speakers``). Stretches that
    are too short to embed keep the current speaker. This is approximate
    diarization — it can split one voice or merge similar voices — and is labeled
    as such in the UI. Labels are ``"1"``, ``"2"``, … and stay stable within one
    provider connection, the same scope Soniox speaker labels have.
    """

    def __init__(self, embedder: SpeakerEmbedder | None, *, threshold: float = 0.5,
                 max_speakers: int = 8, min_seconds: float = 1.0) -> None:
        self._embedder = embedder
        self._threshold = threshold
        self._max = max_speakers
        self._min_seconds = min_seconds
        self._centroids: list[list[float]] = []
        self._counts: list[int] = []
        self.current = "1"

    @property
    def enabled(self) -> bool:
        return self._embedder is not None

    @property
    def speaker_count(self) -> int:
        return max(1, len(self._centroids))

    async def assign(self, pcm: bytes) -> str:
        if self._embedder is None or len(pcm) < self._min_seconds * BYTES_PER_SECOND:
            return self.current
        vector = await self._embedder.embed(pcm)
        if not vector:
            return self.current
        embedding = _unit(vector)
        if embedding is None:
            return self.current
        best, best_score = -1, -2.0
        for index, centroid in enumerate(self._centroids):
            score = sum(a * b for a, b in zip(centroid, embedding, strict=False))
            if score > best_score:
                best, best_score = index, score
        if best < 0 or (best_score < self._threshold and len(self._centroids) < self._max):
            self._centroids.append(embedding)
            self._counts.append(1)
            best = len(self._centroids) - 1
        else:
            count = self._counts[best]
            merged = [(c * count + e) / (count + 1) for c, e in zip(self._centroids[best], embedding,
                                                                     strict=False)]
            self._centroids[best] = _unit(merged) or self._centroids[best]
            self._counts[best] = min(count + 1, 50)
        self.current = str(best + 1)
        return self.current


def _unit(vector: Sequence[float]) -> list[float] | None:
    values = [float(value) for value in vector]
    if not values or any(not math.isfinite(value) for value in values):
        return None
    norm = math.sqrt(sum(value * value for value in values))
    return [value / norm for value in values] if norm > 0 else None


def normalized_word(text: str) -> str:
    """Case- and punctuation-insensitive form used for agreement and overlap."""
    folded = unicodedata.normalize("NFKC", text).casefold()
    return "".join(ch for ch in folded if ch.isalnum())


@dataclass
class _Committed:
    word: DecodedWord  # absolute seconds since session start
    language: str | None
    speaker: str = "1"


@dataclass
class _PendingTranslation:
    words: list[_Committed] = field(default_factory=list)
    pcm: bytearray = field(default_factory=bytearray)
    start_s: float = 0.0


class WhisperStreamSession:
    """A :class:`~.live_session.LiveAsrSession` over a window decoder."""

    def __init__(
        self,
        settings: StreamSettings,
        *,
        decoder: WindowDecoder,
        vad: VoiceActivity,
        speakers: SpeakerTracker | None = None,
    ) -> None:
        if settings.translation_target_language is not None and not decoder.can_translate(
            settings.translation_target_language
        ):
            raise LiveAsrError(
                f"{settings.label} cannot translate into '{settings.translation_target_language}'. "
                "Choose Transcription mode or another provider.", retryable=False,
            )
        self._settings = settings
        self._decoder = decoder
        self._vad = vad
        self._speakers = speakers or SpeakerTracker(None)
        self._resampler = StreamResampler(settings.sample_rate)
        self.failure_retryable = True
        self.failure_message: str | None = None
        self._buffer = bytearray()
        self._buffer_start = 0  # 16 kHz sample index of _buffer[0]
        self._received = 0  # 16 kHz samples received
        self._decoded_end = 0  # 16 kHz samples covered by the last decode
        self._hypothesis: list[DecodedWord] = []
        self._committed_end_s = 0.0
        self._committed_tail: list[str] = []
        self._prompt_words: list[DecodedWord] = []
        self._last_partial: list[str] = []
        self._ready_translations: list[_PendingTranslation] = []
        self._language: str | None = None
        self._final_ms = 0
        self._total_ms = 0
        self._pending_translation = _PendingTranslation()
        self._wake = asyncio.Event()
        self._finishing = False
        self._closed = False
        self._events: asyncio.Queue[SonioxEvent | None] = asyncio.Queue(maxsize=settings.event_queue_size + 1)
        self._events_claimed = False
        self._events_ended = False
        self._finished = False
        self._worker = asyncio.create_task(self._run(), name="whisper-stream")

    # ── LiveAsrSession ────────────────────────────────────────────────────────
    async def send_audio(self, frame: bytes) -> None:
        if self._finishing or self._closed or self._worker.done():
            message = self.failure_message or f"{self._settings.label} is no longer accepting audio."
            raise LiveAsrError(message, retryable=self.failure_retryable)
        if not isinstance(frame, bytes):
            raise TypeError("audio frame must be bytes")
        if not frame or len(frame) % 2:
            raise ValueError("audio frame must contain whole PCM16 samples")
        converted = self._resampler.feed(frame)
        self._buffer.extend(converted)
        self._received += len(converted) // 2
        limit = (self._settings.max_window_s + self._settings.max_backlog_s + 5) * BYTES_PER_SECOND
        if len(self._buffer) > limit:
            await self._fail(self._too_slow(), retryable=False)
            raise LiveAsrError(self._too_slow(), retryable=False)
        self._wake.set()

    async def events(self) -> AsyncIterator[SonioxEvent]:
        if self._events_claimed:
            raise RuntimeError("events may only be consumed once")
        self._events_claimed = True
        while True:
            event = await self._events.get()
            if event is None:
                return
            yield event

    async def finish(self, *, timeout_s: float | None = None) -> bool:
        """Decode everything received, emit ``finished``, and only then return."""
        self._finishing = True
        self._wake.set()
        deadline = timeout_s if timeout_s is not None else self._settings.finish_timeout_s
        with contextlib.suppress(TimeoutError, asyncio.CancelledError, Exception):
            async with asyncio.timeout(deadline):
                await asyncio.shield(self._worker)
        return self._finished

    async def aclose(self) -> None:
        self._closed = True
        if not self._worker.done():
            self._worker.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._worker
        self._end_events()

    # ── worker ────────────────────────────────────────────────────────────────
    async def _run(self) -> None:
        try:
            while True:
                await self._wake.wait()
                self._wake.clear()
                pending_s = (self._received - self._decoded_end) / SAMPLE_RATE
                if self._finishing:
                    await self._step(finishing=True)
                    await self._emit_finished()
                    return
                if pending_s < self._settings.min_step_s:
                    continue
                await self._step(finishing=False)
                backlog_s = (self._received - self._decoded_end) / SAMPLE_RATE
                if backlog_s > self._settings.max_backlog_s:
                    raise LiveAsrError(self._too_slow(), retryable=False)
                if (self._received - self._decoded_end) / SAMPLE_RATE >= self._settings.min_step_s:
                    self._wake.set()
        except asyncio.CancelledError:
            raise
        except LiveAsrError as error:
            self.failure_message = str(error)
            self.failure_retryable = error.retryable
        except Exception:
            self.failure_message = f"{self._settings.label} failed while transcribing."
            self.failure_retryable = True
        finally:
            self._end_events()

    def _too_slow(self) -> str:
        return (f"{self._settings.label} cannot keep up with live audio on this computer. "
                "Choose a smaller model, or another provider.")

    async def _fail(self, message: str, *, retryable: bool) -> None:
        self.failure_message = message
        self.failure_retryable = retryable
        self._worker.cancel()
        self._end_events()

    def _end_events(self) -> None:
        if self._events_ended:
            return
        self._events_ended = True
        with contextlib.suppress(asyncio.QueueFull):
            self._events.put_nowait(None)

    async def _put(self, event: SonioxEvent) -> None:
        # One slot is reserved for the end-of-stream marker.
        while self._events.qsize() >= self._settings.event_queue_size:
            await asyncio.sleep(0.01)
        self._events.put_nowait(event)

    async def _step(self, *, finishing: bool) -> None:
        settings = self._settings
        end = self._received
        window = bytes(self._buffer[: (end - self._buffer_start) * 2])
        window_start_s = self._buffer_start / SAMPLE_RATE
        end_s = end / SAMPLE_RATE
        self._decoded_end = end
        commit: list[DecodedWord] = []
        partial: list[DecodedWord] = []
        language = self._language
        if window:
            speech = [(window_start_s + a, window_start_s + b) for a, b in await self._vad.speech(window)]
        else:
            speech = []
        last_speech_end = speech[-1][1] if speech else window_start_s
        window_s = end_s - window_start_s
        endpoint = finishing or (end_s - last_speech_end) >= settings.endpoint_silence_s
        cut_s = end_s
        if speech and not endpoint and window_s >= settings.max_window_s:
            # Force progress at the last pause inside the window, or at its end.
            gaps = [speech[i][1] for i in range(len(speech) - 1)
                    if speech[i + 1][0] - speech[i][1] >= 0.2 and speech[i][1] - window_start_s > 1.0]
            if gaps:
                cut_s = gaps[-1] + 0.1
        full = window_s >= settings.max_window_s
        decode_now = bool(speech) and (self._decoder.redecode or endpoint or full)
        if decode_now:
            first = max(window_start_s, speech[0][0] - 0.2)
            offset = int((first - window_start_s) * SAMPLE_RATE) * 2
            limit = int((cut_s - window_start_s) * SAMPLE_RATE) * 2
            if self._language is None and settings.used_languages and len(settings.used_languages) == 1:
                language = settings.used_languages[0]
            decoded = await self._decoder.decode(
                window[offset:limit], language=language, languages=settings.used_languages,
                prompt=self._prompt(window_start_s),
            )
            base = first
            words = [
                DecodedWord(w.text, base + max(0.0, w.start_s), min(cut_s, base + max(w.start_s, w.end_s)),
                            w.probability)
                for w in decoded.words if w.text.strip()
            ]
            words = [w for w in words if _within_speech(w, speech)]
            words = self._drop_committed(words)
            language = decoded.language or language
            if self._decoder.redecode and not endpoint and cut_s >= end_s:
                agreed = _common_prefix(self._hypothesis, words)
                commit, partial = words[:agreed], words[agreed:]
            else:
                commit, partial = words, []
            if endpoint:
                commit, partial = commit + partial, []
            elif window_s >= settings.max_window_s and partial:
                # Whisper cannot see past 30 s: commit what is safely behind the tail.
                safe = [w for w in partial if w.end_s < end_s - 1.0]
                commit, partial = commit + safe, partial[len(safe):]
            self._hypothesis = partial
            if language is not None:
                self._language = language
        elif endpoint:
            commit, partial = self._hypothesis, []
            self._hypothesis = []
        else:
            partial = self._hypothesis

        committed = await self._commit(commit, window, window_start_s, language)
        translations = await self._translate_ready(finishing or endpoint)

        # Trim: keep the window starting at the last committed boundary.
        if endpoint and not self._hypothesis:
            new_start_s = max(self._committed_end_s, end_s - 0.2) if speech else max(
                self._committed_end_s, end_s - 0.3)
        elif self._committed_end_s - window_start_s > 0 and (
                window_s > settings.trim_after_s or cut_s < end_s):
            new_start_s = self._committed_end_s
        elif not speech:
            new_start_s = max(window_start_s, end_s - 0.3)
        else:
            new_start_s = window_start_s
        self._trim_to(min(new_start_s, end_s))
        if endpoint:
            self._language = None

        final_s = max(self._buffer_start / SAMPLE_RATE, self._committed_end_s)
        if partial:
            final_s = min(final_s, partial[0].start_s)
        total_ms = max(self._total_ms, end * 1000 // SAMPLE_RATE)
        final_ms = min(total_ms, max(self._final_ms, int(final_s * 1000)))
        if finishing:
            final_ms = total_ms
        partial_text = [w.text for w in partial]
        changed = bool(committed or translations or partial_text != self._last_partial
                       or final_ms != self._final_ms or total_ms != self._total_ms)
        self._last_partial = partial_text
        self._final_ms, self._total_ms = final_ms, total_ms
        if changed and not finishing:
            await self._put(self._event(committed, partial, translations, finished=False))
        elif finishing and (committed or translations):
            await self._put(self._event(committed, [], translations, finished=False))

    def _prompt(self, window_start_s: float) -> str:
        """Committed text already trimmed out of the window: context without duplication."""
        before = [w.text for w in self._prompt_words if w.end_s <= window_start_s + 0.01]
        return "".join(before)[-PROMPT_CHARS:].strip()

    def _trim_to(self, start_s: float) -> None:
        sample = min(self._received, max(self._buffer_start, int(start_s * SAMPLE_RATE)))
        drop = sample - self._buffer_start
        if drop > 0:
            del self._buffer[: drop * 2]
            self._buffer_start = sample

    def _drop_committed(self, words: list[DecodedWord]) -> list[DecodedWord]:
        fresh = [w for w in words if w.start_s >= self._committed_end_s - 0.1]
        # Re-decoded context can repeat the committed tail with shifted timing.
        tail = self._committed_tail
        for size in range(min(OVERLAP_WORDS, len(tail), len(fresh)), 0, -1):
            if [normalized_word(w.text) for w in fresh[:size]] == tail[-size:]:
                return fresh[size:]
        return fresh

    async def _commit(
        self, words: list[DecodedWord], window: bytes, window_start_s: float, language: str | None,
    ) -> list[_Committed]:
        if not words:
            return []
        committed: list[_Committed] = []
        for group in _speaker_groups(words):
            a = max(0, int((group[0].start_s - window_start_s - 0.05) * SAMPLE_RATE) * 2)
            b = max(a, int((group[-1].end_s - window_start_s + 0.05) * SAMPLE_RATE) * 2)
            speaker = await self._speakers.assign(window[a:b])
            for word in group:
                committed.append(_Committed(word, language, speaker))
            if self._settings.translation_target_language is not None:
                self._queue_translation(group, window[a:b], language, speaker)
        self._committed_end_s = max(self._committed_end_s, words[-1].end_s)
        tail = self._committed_tail + [normalized_word(w.text) for w in words]
        self._committed_tail = tail[-OVERLAP_WORDS:]
        self._prompt_words = (self._prompt_words + words)[-64:]
        return committed

    def _queue_translation(self, group: list[DecodedWord], pcm: bytes, language: str | None,
                           speaker: str) -> None:
        target = self._settings.translation_target_language
        if language is not None and language == target:
            return  # Already in the target language: shown as is, like Soniox.
        pending = self._pending_translation
        if pending.words and (pending.words[-1].speaker != speaker or pending.words[-1].language != language):
            self._ready_translations.append(pending)
            pending = self._pending_translation = _PendingTranslation()
        if not pending.words:
            pending.start_s = group[0].start_s
        pending.words.extend(_Committed(word, language, speaker) for word in group)
        pending.pcm.extend(pcm)
        if _SENTENCE_END.search(group[-1].text.strip()) or len(pending.pcm) > 12 * BYTES_PER_SECOND:
            self._ready_translations.append(pending)
            self._pending_translation = _PendingTranslation()

    async def _translate_ready(self, flush: bool) -> list[SonioxTranslationToken]:
        if self._settings.translation_target_language is None:
            return []
        if flush and self._pending_translation.words:
            self._ready_translations.append(self._pending_translation)
            self._pending_translation = _PendingTranslation()
        ready, self._ready_translations = self._ready_translations, []
        target = self._settings.translation_target_language
        tokens: list[SonioxTranslationToken] = []
        for unit in ready:
            if not unit.words:
                continue
            source = unit.words[0].language
            text = (await self._decoder.translate(bytes(unit.pcm), source_language=source,
                                                  target_language=target)).strip()
            speaker = unit.words[0].speaker
            for piece in text.split():
                tokens.append(SonioxTranslationToken(
                    text=f" {piece}", confidence=1.0,
                    is_final=True, language=target, source_language=source, speaker=speaker,
                ))
        return tokens

    def _event(self, committed: list[_Committed], partial: list[DecodedWord],
               translations: list[SonioxTranslationToken], *, finished: bool) -> SonioxEvent:
        total_ms = self._total_ms
        translating = self._settings.translation_target_language is not None
        target = self._settings.translation_target_language
        final_tokens = tuple(_token(item.word, item.language, item.speaker, total_ms, final=True)
                             for item in committed)
        current = self._speakers.current
        partial_tokens = tuple(_token(word, self._language, current, total_ms, final=False)
                               for word in partial)
        order: list[SonioxTokenRef] = []

        def status(language: str | None) -> Literal["none", "original"]:
            return "original" if translating and language != target else "none"

        order.extend(SonioxTokenRef(status(t.language), True, i) for i, t in enumerate(final_tokens))
        order.extend(SonioxTokenRef("translation", True, i) for i in range(len(translations)))
        order.extend(SonioxTokenRef(status(t.language), False, i) for i, t in enumerate(partial_tokens))
        return SonioxEvent(
            final_tokens=final_tokens, partial_tokens=partial_tokens, markers=(),
            final_audio_proc_ms=self._final_ms, total_audio_proc_ms=total_ms, finished=finished,
            final_translation_tokens=tuple(translations), partial_translation_tokens=(),
            token_order=tuple(order),
        )

    async def _emit_finished(self) -> None:
        total_ms = max(self._total_ms, self._received * 1000 // SAMPLE_RATE)
        self._final_ms = self._total_ms = total_ms
        await self._put(SonioxEvent(
            final_tokens=(), partial_tokens=(), markers=(), final_audio_proc_ms=total_ms,
            total_audio_proc_ms=total_ms, finished=True, token_order=(),
        ))
        self._finished = True


def _token(
    word: DecodedWord, language: str | None, speaker: str, total_ms: int, *, final: bool,
) -> SonioxToken:
    start_ms = max(0, int(word.start_s * 1000))
    end_ms = min(total_ms, max(start_ms + 1, int(word.end_s * 1000)))
    start_ms = max(0, min(start_ms, end_ms - 1))
    confidence = word.probability if math.isfinite(word.probability) else 0.0
    return SonioxToken(
        text=word.text, start_ms=start_ms, end_ms=end_ms, confidence=min(1.0, max(0.0, confidence)),
        is_final=final, language=language, speaker=speaker,
    )


def _within_speech(word: DecodedWord, speech: list[tuple[float, float]]) -> bool:
    """Drop words the decoder placed entirely in silence: the classic Whisper hallucination."""
    return any(word.end_s >= a - SPEECH_PAD_S and word.start_s <= b + SPEECH_PAD_S for a, b in speech)


def _common_prefix(previous: list[DecodedWord], current: list[DecodedWord]) -> int:
    count = 0
    for old, new in zip(previous, current, strict=False):
        if normalized_word(old.text) != normalized_word(new.text) or not normalized_word(new.text):
            break
        count += 1
    return count


def _speaker_groups(
    words: list[DecodedWord], *, pause_s: float = 0.5, max_s: float = 8.0,
) -> list[list[DecodedWord]]:
    """Split committed words where a speaker change is plausible: pauses, or long runs."""
    groups: list[list[DecodedWord]] = []
    for word in words:
        if (not groups or word.start_s - groups[-1][-1].end_s >= pause_s
                or word.end_s - groups[-1][0].start_s > max_s):
            groups.append([word])
        else:
            groups[-1].append(word)
    return groups
