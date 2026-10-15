"""Dictation: a short WAV recorded in the composer becomes text, and nothing is kept (API-B2 §4).

Recognised with the speech service chosen in Settings → Recording and speech
— Soniox's file API or Whisper on this Mac — never another one silently.
Neither the audio nor the text is stored: the WAV lives in memory for the
request, and the Soniox copy (file and transcription) is deleted right after.
"""
from __future__ import annotations

import asyncio
import contextlib
import io
import logging
import wave
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

from ...asr_providers import LABELS, readiness
from ...audio import WavAudio
from ...gateways import ProviderError, ProviderNotConfigured
from ...gateways.asr import LocalWhisperTranscriber, Transcriber
from ...gateways.soniox_async import AsyncRequest, SonioxAsyncError, SonioxAsyncGateway
from ..errors import KnowledgeError
from .legacy import SPOKEN_LANGUAGES

if TYPE_CHECKING:  # pragma: no cover
    from ...runtime import Runtime

logger = logging.getLogger(__name__)

DictationProvider = Literal["soniox", "local_whisper"]
MAX_BYTES = 8 * 1024 * 1024
MAX_SECONDS = 120
MIN_RATE, MAX_RATE = 8_000, 48_000
#: Soniox file API: how often to ask whether the transcription is done, and for how long at most.
POLL_S = 0.5
DEADLINE_S = 120.0
NOT_SUPPORTED = ("Dictation uses Soniox or Whisper on this Mac. "
                 "Choose one in Settings → Recording and speech.")


class DictationInvalid(KnowledgeError):
    """The audio itself is wrong (format, length, size)."""

    status_code = 422


class DictationTooLarge(DictationInvalid):
    status_code = 413


class DictationUnavailable(KnowledgeError):
    """No key, no consent, no downloaded model: the reason says what to set up."""

    status_code = 409


class DictationFailed(KnowledgeError):
    """The speech service could not recognise the audio now."""

    status_code = 502


@dataclass(frozen=True)
class DictationResult:
    text: str
    language: str | None
    provider: DictationProvider


def read_wav(data: bytes) -> WavAudio:
    """PCM16 mono WAV, 8–48 kHz, at most two minutes and 8 MB; anything else is refused plainly."""
    if len(data) > MAX_BYTES:
        raise DictationTooLarge("The dictation is larger than 8 MB.")
    if len(data) < 44 or data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise DictationInvalid("The dictation must be a WAV file.")
    try:
        with wave.open(io.BytesIO(data), "rb") as handle:
            channels, width, rate = handle.getnchannels(), handle.getsampwidth(), handle.getframerate()
            if handle.getcomptype() != "NONE" or width != 2 or channels != 1:
                raise DictationInvalid("The dictation must be 16-bit mono PCM audio.")
            if not MIN_RATE <= rate <= MAX_RATE:
                raise DictationInvalid("The dictation's sample rate must be between 8 and 48 kHz.")
            count = handle.getnframes()
            if count > MAX_SECONDS * rate:
                raise DictationInvalid("Dictation is limited to two minutes.")
            frames = handle.readframes(count)
    except (wave.Error, EOFError) as error:
        raise DictationInvalid("The dictation must be a WAV file.") from error
    if len(frames) < 2:
        raise DictationInvalid("The dictation has no audio.")
    return WavAudio(rate, frames[: len(frames) - len(frames) % 2])


def _clean(text: str) -> str:
    return " ".join(text.split())


class Dictation:
    def __init__(self, runtime: Runtime, *,
                 local_transcriber: Callable[[str], Transcriber] | None = None) -> None:
        self._runtime = runtime
        self._local = local_transcriber or self._whisper

    def _whisper(self, model: str) -> Transcriber:
        return LocalWhisperTranscriber(model=model, allow_download=False,
                                       cache_dir=self._runtime.config.local_model_cache_dir)

    async def transcribe(self, data: bytes, language: str | None) -> DictationResult:
        if language is not None and language not in SPOKEN_LANGUAGES:
            raise DictationInvalid("Unsupported spoken language.")
        audio = read_wav(data)
        settings = await asyncio.to_thread(self._runtime.settings_store.load)
        provider = settings.transcription_provider
        if provider not in ("soniox", "local-whisper"):
            raise DictationUnavailable(NOT_SUPPORTED)
        ready, detail = await asyncio.to_thread(readiness, self._runtime, settings, provider)
        if not ready:
            raise DictationUnavailable(f"{LABELS[provider]}: {detail}")
        saved = tuple(settings.used_languages) if settings.used_languages else None
        hints = (language,) if language else saved
        if provider == "soniox":
            return await self._soniox(data, hints)
        return await self._whisper_local(audio, settings.local_whisper_model, language)

    # -- Soniox file API ------------------------------------------------------

    async def _soniox(self, data: bytes, hints: tuple[str, ...] | None) -> DictationResult:
        key = await asyncio.to_thread(self._runtime.api_key, "soniox")
        if not key:
            raise DictationUnavailable("Soniox: no API key is stored. Add it in Accounts and keys.")
        gateway = SonioxAsyncGateway(api_key=key, http=self._runtime.http)
        file_id: str | None = None
        job_id: str | None = None
        try:
            file_id = (await gateway.upload(filename="dictation.wav", content=data)).id
            job = await gateway.create(file_id=file_id, request=AsyncRequest(used_languages=hints))
            job_id = job.id
            async with asyncio.timeout(DEADLINE_S):
                while job.status not in ("completed", "error"):
                    await asyncio.sleep(POLL_S)
                    job = await gateway.status(job_id)
            if job.status == "error":
                raise DictationFailed("Soniox couldn't recognise this dictation. Try again.")
            transcript = await gateway.transcript(job_id)
        except TimeoutError as error:
            raise DictationFailed("Soniox took too long to recognise this dictation. Try again.") from error
        except SonioxAsyncError as error:
            raise DictationFailed(f"Soniox couldn't recognise this dictation: {error}") from error
        finally:
            await self._forget(gateway, file_id, job_id)
        spoken = [token for token in transcript.tokens if token.translation_status != "translation"]
        languages = Counter(token.language for token in spoken if token.language)
        language = languages.most_common(1)[0][0] if languages else (hints[0] if hints else None)
        parts: list[str] = []
        speaker: str | None = None
        for token in spoken:
            if parts and token.speaker != speaker and not token.text[:1].isspace():
                parts.append(" ")  # a new speaker's turn starts without a leading space
            parts.append(token.text)
            speaker = token.speaker
        return DictationResult(_clean("".join(parts)), language, "soniox")

    @staticmethod
    async def _forget(gateway: SonioxAsyncGateway, file_id: str | None, job_id: str | None) -> None:
        """Nothing is kept: the transcription and the uploaded audio are deleted at Soniox."""
        if job_id is not None:
            with contextlib.suppress(SonioxAsyncError):
                await gateway.delete_transcription(job_id)
        if file_id is not None:
            with contextlib.suppress(SonioxAsyncError):
                await gateway.delete_file(file_id)

    # -- Whisper on this Mac --------------------------------------------------

    async def _whisper_local(self, audio: WavAudio, model: str, language: str | None) -> DictationResult:
        try:
            async with self._runtime.local_models.use("local-whisper", model):
                pieces = await self._local(model).transcribe(audio, language=language)
        except ProviderNotConfigured as error:
            raise DictationUnavailable(str(error)) from error
        except ProviderError as error:
            raise DictationFailed("Whisper couldn't recognise this dictation. Try again.") from error
        found = Counter(piece.language for piece in pieces if piece.language)
        detected = found.most_common(1)[0][0] if found else language
        return DictationResult(_clean(" ".join(piece.text for piece in pieces)), detected, "local_whisper")
