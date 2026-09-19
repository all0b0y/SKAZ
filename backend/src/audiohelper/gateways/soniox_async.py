"""Bounded gateway for the Soniox asynchronous (file) transcription REST API.

The gateway owns only the provider protocol: upload bytes, create a job, poll it,
read the transcript, delete both sides.  It never touches the database, never
retains audio, and never decides what a failure means for the product — callers
classify outcomes from the typed results returned here.

Async transcription is a separate product surface from the real-time WebSocket
gateway in :mod:`.soniox`: different model family, different billing rate, and a
job that outlives our process.  The two deliberately share nothing but the key.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Any, Literal

import httpx

from ..languages import validate_languages

SONIOX_API_BASE = "https://api.soniox.com/v1"
ASYNC_MODEL = "stt-async-v5"
#: Fixed provider limit: a single file may not exceed 300 minutes of audio.
MAX_FILE_DURATION_MS = 300 * 60 * 1000
#: Container formats the provider documents for automatic detection.
SUPPORTED_EXTENSIONS: tuple[str, ...] = (
    "aac", "aiff", "amr", "asf", "flac", "m4a", "mp3", "mp4", "ogg", "wav", "webm",
)
MAX_RESPONSE_BYTES = 32 * 1024 * 1024
_SAFE_ERROR_VALUE = re.compile(r"^[A-Za-z0-9 _.,:'()/-]{1,200}$")
_UUID = re.compile(r"^[0-9a-fA-F-]{32,40}$")

JobStatus = Literal["queued", "processing", "completed", "error"]


class SonioxAsyncError(RuntimeError):
    """A sanitized transport, provider, or protocol failure."""

    def __init__(self, message: str, *, retryable: bool) -> None:
        super().__init__(message)
        #: True when the same call can plausibly succeed later without a new job.
        self.retryable = retryable


class SonioxAsyncProtocolError(SonioxAsyncError):
    """The provider returned a response outside the documented contract."""

    def __init__(self, message: str = "Soniox returned an unexpected response.") -> None:
        super().__init__(message, retryable=False)


@dataclass(frozen=True)
class AsyncToken:
    """One recognized token. Translated tokens carry no audio timing of their own."""

    text: str
    start_ms: int
    end_ms: int
    confidence: float
    speaker: str | None
    language: str | None
    translation_status: Literal["none", "original", "translation"]


@dataclass(frozen=True)
class UploadedFile:
    id: str
    filename: str
    size: int


@dataclass(frozen=True)
class TranscriptionJob:
    id: str
    status: JobStatus
    audio_duration_ms: int | None
    error_type: str | None
    error_message: str | None


@dataclass(frozen=True)
class AsyncTranscript:
    tokens: tuple[AsyncToken, ...]


@dataclass(frozen=True)
class AsyncRequest:
    """Validated job settings for one file."""

    translation_target_language: str | None = None
    used_languages: tuple[str, ...] | None = None
    model: str = ASYNC_MODEL

    def __post_init__(self) -> None:
        if self.used_languages is not None:
            if not isinstance(self.used_languages, tuple):
                raise ValueError("used_languages must be an immutable tuple")
            validate_languages(list(self.used_languages))
        if self.translation_target_language is not None and (
            not isinstance(self.translation_target_language, str)
            or re.fullmatch(r"[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*", self.translation_target_language) is None
            or len(self.translation_target_language) > 32
        ):
            raise ValueError("translation_target_language must be a language code")
        if (
            not isinstance(self.model, str)
            or not self.model.startswith("stt-async-")
            or len(self.model) > 32
            or any(character.isspace() for character in self.model)
        ):
            raise ValueError("model must be an explicit Soniox async STT model ID")

    def payload(self, *, file_id: str) -> dict[str, Any]:
        body: dict[str, Any] = {
            "model": self.model,
            "file_id": file_id,
            "enable_speaker_diarization": True,
            "enable_language_identification": True,
        }
        if self.used_languages is not None:
            body["language_hints"] = list(self.used_languages)
            body["language_hints_strict"] = True
        if self.translation_target_language is not None:
            body["translation"] = {
                "type": "one_way", "target_language": self.translation_target_language,
            }
        return body


class SonioxAsyncGateway:
    """Stateless client for one API key; every method is an independent call."""

    def __init__(self, *, api_key: str, http: httpx.AsyncClient, base_url: str = SONIOX_API_BASE) -> None:
        if not api_key or not api_key.strip():
            raise ValueError("api_key must not be empty")
        if not base_url.startswith("https://"):
            raise ValueError("Soniox API base URL must use https")
        self._api_key = api_key
        self._http = http
        self._base = base_url.rstrip("/")

    @property
    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._api_key}"}

    async def upload(self, *, filename: str, content: bytes) -> UploadedFile:
        """Upload one finite audio payload and return its provider-side identity."""
        if not isinstance(content, bytes) or not content:
            raise ValueError("content must be non-empty bytes")
        response = await self._call(
            "POST", "/files", files={"file": (filename, content, "application/octet-stream")},
        )
        payload = _object(response)
        return UploadedFile(
            id=_identifier(payload.get("id")),
            filename=_text(payload.get("filename"), maximum=512),
            size=_non_negative_int(payload.get("size")),
        )

    async def create(self, *, file_id: str, request: AsyncRequest) -> TranscriptionJob:
        response = await self._call(
            "POST", "/transcriptions", json=request.payload(file_id=_identifier(file_id)),
        )
        return _job(_object(response))

    async def status(self, transcription_id: str) -> TranscriptionJob:
        response = await self._call("GET", f"/transcriptions/{_identifier(transcription_id)}")
        return _job(_object(response))

    async def transcript(self, transcription_id: str) -> AsyncTranscript:
        """Read the finished transcript; only valid once the job reports completed."""
        response = await self._call("GET", f"/transcriptions/{_identifier(transcription_id)}/transcript")
        payload = _object(response)
        raw = payload.get("tokens")
        if not isinstance(raw, list):
            raise SonioxAsyncProtocolError
        return AsyncTranscript(tokens=tuple(_token(value) for value in raw))

    async def delete_file(self, file_id: str) -> None:
        """Best-effort removal; a file already gone is not an error for the caller."""
        await self._call("DELETE", f"/files/{_identifier(file_id)}", absent_is_success=True)

    async def delete_transcription(self, transcription_id: str) -> None:
        """Best-effort removal. The provider refuses while a job is processing."""
        await self._call(
            "DELETE", f"/transcriptions/{_identifier(transcription_id)}", absent_is_success=True,
        )

    async def _call(
        self, method: str, path: str, *, absent_is_success: bool = False, **kwargs: Any,
    ) -> Any:
        try:
            response = await self._http.request(
                method, f"{self._base}{path}", headers=self._headers, **kwargs
            )
        except httpx.HTTPError as error:
            # Transport failures never prove the request was not executed; the
            # caller reconciles by reading job state, not by blind retry.
            raise SonioxAsyncError(
                "Soniox could not be reached.", retryable=True,
            ) from error
        if response.status_code == 404 and absent_is_success:
            return None
        if response.status_code >= 400:
            raise _provider_error(response)
        if response.status_code == 204 or not response.content:
            return None
        if len(response.content) > MAX_RESPONSE_BYTES:
            raise SonioxAsyncProtocolError("Soniox returned a response beyond the accepted size.")
        try:
            return response.json()
        except ValueError as error:
            raise SonioxAsyncProtocolError from error


def _provider_error(response: httpx.Response) -> SonioxAsyncError:
    status = response.status_code
    detail = ""
    try:
        body = response.json()
    except ValueError:
        body = None
    if isinstance(body, dict):
        for field in ("error_type", "message", "error_message"):
            value = body.get(field)
            if isinstance(value, str) and _SAFE_ERROR_VALUE.fullmatch(value):
                detail = f" ({value})"
                break
    # 429 and 5xx clear on their own; 4xx describes a request that will never work.
    retryable = status == 429 or status >= 500
    return SonioxAsyncError(f"Soniox request failed (HTTP {status}{detail}).", retryable=retryable)


def _object(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise SonioxAsyncProtocolError
    return value


def _job(payload: dict[str, Any]) -> TranscriptionJob:
    status = payload.get("status")
    if status not in ("queued", "processing", "completed", "error"):
        raise SonioxAsyncProtocolError
    duration = payload.get("audio_duration_ms")
    if duration is not None:
        duration = _non_negative_int(duration)
    return TranscriptionJob(
        id=_identifier(payload.get("id")),
        status=status,
        audio_duration_ms=duration,
        error_type=_optional_safe_text(payload.get("error_type")),
        error_message=_optional_safe_text(payload.get("error_message")),
    )


def _token(value: Any) -> AsyncToken:
    payload = _object(value)
    text = payload.get("text")
    if not isinstance(text, str):
        raise SonioxAsyncProtocolError
    start_ms = _non_negative_int(payload.get("start_ms"))
    end_ms = _non_negative_int(payload.get("end_ms"))
    if end_ms < start_ms:
        raise SonioxAsyncProtocolError
    confidence = payload.get("confidence")
    if (
        isinstance(confidence, bool)
        or not isinstance(confidence, int | float)
        or not math.isfinite(confidence)
        or not 0 <= confidence <= 1
    ):
        raise SonioxAsyncProtocolError
    status = payload.get("translation_status", "none")
    if status not in ("none", "original", "translation"):
        raise SonioxAsyncProtocolError
    return AsyncToken(
        text=text,
        start_ms=start_ms,
        end_ms=end_ms,
        confidence=float(confidence),
        speaker=_bounded_optional(payload.get("speaker"), maximum=128),
        language=_bounded_optional(payload.get("language"), maximum=32),
        translation_status=status,
    )


def _identifier(value: Any) -> str:
    if not isinstance(value, str) or _UUID.fullmatch(value) is None:
        raise SonioxAsyncProtocolError
    return value


def _text(value: Any, *, maximum: int) -> str:
    if not isinstance(value, str) or not value or len(value) > maximum:
        raise SonioxAsyncProtocolError
    return value


def _bounded_optional(value: Any, *, maximum: int) -> str | None:
    if value is None:
        return None
    return _text(value, maximum=maximum)


def _optional_safe_text(value: Any) -> str | None:
    """Provider-authored error prose, accepted only in a printable bounded shape."""
    if value is None:
        return None
    if not isinstance(value, str) or _SAFE_ERROR_VALUE.fullmatch(value) is None:
        return None
    return value


def _non_negative_int(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise SonioxAsyncProtocolError
    return value
