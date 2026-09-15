"""Bounded native asynchronous gateway for Soniox real-time speech-to-text.

The gateway owns only the provider protocol.  It does not retain audio or a whole
transcript: callers send finite PCM frames and consume final deltas plus the current
replaceable non-final tail from :meth:`SonioxSession.events`.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import math
import re
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Literal, Protocol, cast

from websockets.asyncio.client import connect

from ..languages import validate_languages

SONIOX_WEBSOCKET_URL = "wss://stt-rt.soniox.com/transcribe-websocket"
DEFAULT_MODEL = "stt-rt-v5"
FINALIZATION_TIMEOUT_S = 10.0
MAX_RESPONSE_BYTES = 1_048_576
MAX_FRAME_DURATION_MS = 1_000
CLOSE_TIMEOUT_S = 1.0
_SAFE_ERROR_VALUE = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")

Marker = Literal["end", "fin"]


class SonioxGatewayError(RuntimeError):
    """A sanitized connection, provider, or protocol failure."""


class SonioxProtocolError(SonioxGatewayError):
    """The provider returned a message outside the documented contract."""


class WebSocketTransport(Protocol):
    async def send(self, message: str | bytes) -> None:
        ...

    async def recv(self) -> str | bytes:
        ...

    async def close(self) -> None:
        ...


Connector = Callable[[str], Awaitable[WebSocketTransport]]


@dataclass(frozen=True)
class SonioxConfig:
    """Validated raw PCM session settings.

    Endpoint acceleration is explicitly off: the product favors recognition
    accuracy and lets the model finalize naturally.  Sending end-of-stream is the
    only default finalization performed by this slice.
    """

    sample_rate: int
    model: str = DEFAULT_MODEL
    audio_format: Literal["pcm_s16le"] = "pcm_s16le"
    num_channels: Literal[1] = 1
    event_queue_size: int = 64
    translation_target_language: str | None = None
    used_languages: tuple[str, ...] | None = None

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
            isinstance(self.sample_rate, bool)
            or not isinstance(self.sample_rate, int)
            or not 8_000 <= self.sample_rate <= 48_000
        ):
            raise ValueError("sample_rate must be an integer between 8000 and 48000 Hz")
        if self.audio_format != "pcm_s16le":
            raise ValueError("Soniox live input must use pcm_s16le")
        if self.num_channels != 1:
            raise ValueError("Soniox live input must be mono")
        if (
            not isinstance(self.model, str)
            or not self.model.startswith("stt-rt-")
            or len(self.model) > 64
            or any(character.isspace() for character in self.model)
        ):
            raise ValueError("model must be an explicit Soniox real-time STT model ID")
        if (
            isinstance(self.event_queue_size, bool)
            or not isinstance(self.event_queue_size, int)
            or not 1 <= self.event_queue_size <= 1_024
        ):
            raise ValueError("event_queue_size must be between 1 and 1024")

    @property
    def max_frame_bytes(self) -> int:
        return self.sample_rate * 2 * MAX_FRAME_DURATION_MS // 1_000


@dataclass(frozen=True)
class SonioxToken:
    text: str
    start_ms: int
    end_ms: int
    confidence: float
    is_final: bool
    language: str | None
    speaker: str | None = None


@dataclass(frozen=True)
class SonioxTranslationToken:
    """Translated text has no audio timestamps or inferred word alignment."""

    text: str
    confidence: float
    is_final: bool
    language: str | None
    source_language: str | None
    speaker: str | None = None


@dataclass(frozen=True)
class SonioxTokenRef:
    """Position in a typed token array, in the provider's mixed stream order."""

    translation_status: Literal["none", "original", "translation"]
    is_final: bool
    position: int


@dataclass(frozen=True)
class SonioxEvent:
    """One provider response: final delta and complete replaceable partial tail."""

    final_tokens: tuple[SonioxToken, ...]
    partial_tokens: tuple[SonioxToken, ...]
    markers: tuple[Marker, ...]
    final_audio_proc_ms: int
    total_audio_proc_ms: int
    finished: bool
    final_translation_tokens: tuple[SonioxTranslationToken, ...] = ()
    partial_translation_tokens: tuple[SonioxTranslationToken, ...] = ()
    token_order: tuple[SonioxTokenRef, ...] | None = None


@dataclass(frozen=True)
class SonioxCompletion:
    """Explicit stream outcome; a closed socket alone is never completion."""

    finished: bool
    final_audio_proc_ms: int
    total_audio_proc_ms: int
    error: str | None


async def _default_connector(url: str) -> WebSocketTransport:
    return cast(
        WebSocketTransport,
        await connect(
            url,
            open_timeout=10,
            close_timeout=5,
            max_size=MAX_RESPONSE_BYTES,
            max_queue=16,
        ),
    )


class SonioxGateway:
    """Creates independent Soniox real-time sessions."""

    def __init__(
        self,
        *,
        api_key: str,
        config: SonioxConfig,
        connector: Connector = _default_connector,
        url: str = SONIOX_WEBSOCKET_URL,
    ) -> None:
        if not api_key or not api_key.strip():
            raise ValueError("api_key must not be empty")
        if not url.startswith("wss://"):
            raise ValueError("Soniox WebSocket URL must use wss")
        self._api_key = api_key
        self.config = config
        self._connector = connector
        self._url = url

    async def open(self) -> SonioxSession:
        try:
            socket = await self._connector(self._url)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            raise SonioxGatewayError("Soniox connection could not be established.") from error

        settings: dict[str, object] = {
            "api_key": self._api_key,
            "model": self.config.model,
            "audio_format": self.config.audio_format,
            "sample_rate": self.config.sample_rate,
            "num_channels": self.config.num_channels,
            "enable_language_identification": True,
            "enable_speaker_diarization": True,
            "enable_endpoint_detection": False,
        }
        if self.config.used_languages is not None:
            settings["language_hints"] = list(self.config.used_languages)
            settings["language_hints_strict"] = True
        if self.config.translation_target_language is not None:
            settings["translation"] = {
                "type": "one_way", "target_language": self.config.translation_target_language,
            }
        try:
            await socket.send(json.dumps(settings, separators=(",", ":")))
        except asyncio.CancelledError:
            await _close_socket(socket)
            raise
        except Exception as error:
            await _close_socket(socket)
            raise SonioxGatewayError("Soniox session configuration could not be sent.") from error
        return SonioxSession(socket, self.config)


class SonioxSession:
    """A single concurrently writable/readable Soniox WebSocket session."""

    def __init__(self, socket: WebSocketTransport, config: SonioxConfig) -> None:
        self._socket = socket
        self._config = config
        self._events: asyncio.Queue[SonioxEvent | None] = asyncio.Queue(
            # One reserved slot lets stream termination be signaled without
            # discarding transcript events when the consumer is behind.
            maxsize=config.event_queue_size + 1
        )
        self._event_slots = asyncio.Semaphore(config.event_queue_size)
        self._events_ended = False
        self._completion: asyncio.Future[SonioxCompletion] = asyncio.get_running_loop().create_future()
        self._receiver = asyncio.create_task(self._receive(), name="soniox-receive")
        self._finish_task: asyncio.Task[SonioxCompletion] | None = None
        self._events_claimed = False
        self._sent_end = False
        self._closed = False
        self._final_audio_proc_ms = 0
        self._total_audio_proc_ms = 0

    @property
    def pending_event_count(self) -> int:
        return self._events.qsize()

    async def send_audio(self, frame: bytes) -> None:
        """Send one finite, whole-sample PCM16 mono binary frame."""
        if self._sent_end or self._closed or self._completion.done():
            raise SonioxGatewayError("Soniox session is no longer accepting audio.")
        if not isinstance(frame, bytes):
            raise TypeError("audio frame must be bytes")
        if not frame:
            raise ValueError("audio frame must be non-empty; finish the session separately")
        if len(frame) % 2:
            raise ValueError("audio frame must contain whole PCM16 samples")
        if len(frame) > self._config.max_frame_bytes:
            raise ValueError(f"audio frame exceeds the {self._config.max_frame_bytes}-byte maximum")
        try:
            await self._socket.send(frame)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            await self._fail("Soniox connection ended while sending audio.")
            raise SonioxGatewayError("Soniox connection ended while sending audio.") from error

    async def events(self) -> AsyncIterator[SonioxEvent]:
        """Yield provider events to exactly one consumer until the stream ends."""
        if self._events_claimed:
            raise RuntimeError("Soniox events may only be consumed once")
        self._events_claimed = True
        while True:
            event = await self._events.get()
            if event is None:
                return
            self._event_slots.release()
            yield event

    async def finish(self, *, timeout_s: float = FINALIZATION_TIMEOUT_S) -> SonioxCompletion:
        """Send empty binary end-of-stream once and await ``finished:true``."""
        if not math.isfinite(timeout_s) or timeout_s <= 0:
            raise ValueError("timeout_s must be positive and finite")
        timeout_s = min(timeout_s, FINALIZATION_TIMEOUT_S)
        if self._finish_task is None:
            self._finish_task = asyncio.create_task(self._finish_once(timeout_s), name="soniox-finish")
        return await asyncio.shield(self._finish_task)

    async def _finish_once(self, timeout_s: float) -> SonioxCompletion:
        if self._completion.done():
            return self._completion.result()
        self._sent_end = True
        try:
            # One deadline covers both transport backpressure and the server's
            # remaining results; sending the end marker can itself block.
            async with asyncio.timeout(timeout_s):
                await self._socket.send(b"")
                return await asyncio.shield(self._completion)
        except TimeoutError:
            await self._fail("Soniox finalization timed out.")
            return self._completion.result()
        except asyncio.CancelledError:
            raise
        except Exception:
            await self._fail("Soniox connection ended before finished confirmation.")
            return self._completion.result()

    async def aclose(self) -> None:
        """Release the connection, retaining an explicit incomplete outcome."""
        await self._fail("Soniox session closed before finished confirmation.")
        # finish() is shielded for multiple callers. Explicit close must also
        # release a blocked END send rather than leave its task alive.
        if self._finish_task is not None and not self._finish_task.done():
            self._finish_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._finish_task

    async def _receive(self) -> None:
        try:
            while True:
                raw = await self._socket.recv()
                event = self._parse_message(raw)
                await self._event_slots.acquire()
                await self._events.put(event)
                if event.finished:
                    self._set_completion(
                        SonioxCompletion(
                            finished=True,
                            final_audio_proc_ms=event.final_audio_proc_ms,
                            total_audio_proc_ms=event.total_audio_proc_ms,
                            error=None,
                        )
                    )
                    return
        except asyncio.CancelledError:
            raise
        except SonioxProtocolError:
            self._set_completion(self._incomplete("Soniox returned an invalid protocol message."))
        except _SonioxProviderResponse as error:
            self._set_completion(self._incomplete(error.safe_message))
        except Exception:
            self._set_completion(self._incomplete("Soniox connection ended before finished confirmation."))
        finally:
            if not self._completion.done():
                self._set_completion(
                    self._incomplete("Soniox connection ended before finished confirmation.")
                )
            self._closed = True
            self._signal_events_end()
            await _close_socket(self._socket)

    def _parse_message(self, raw: str | bytes) -> SonioxEvent:
        if not isinstance(raw, str) or len(raw.encode("utf-8")) > MAX_RESPONSE_BYTES:
            raise SonioxProtocolError
        try:
            payload = json.loads(raw)
        except (json.JSONDecodeError, UnicodeError) as error:
            raise SonioxProtocolError from error
        if not isinstance(payload, dict):
            raise SonioxProtocolError
        if "error_code" in payload:
            raise _provider_response(payload)

        tokens_value = payload.get("tokens")
        if not isinstance(tokens_value, list):
            raise SonioxProtocolError
        final_ms = _non_negative_int(payload.get("final_audio_proc_ms"))
        total_ms = _non_negative_int(payload.get("total_audio_proc_ms"))
        if final_ms > total_ms:
            raise SonioxProtocolError
        if final_ms < self._final_audio_proc_ms or total_ms < self._total_audio_proc_ms:
            raise SonioxProtocolError
        finished = payload.get("finished", False)
        if not isinstance(finished, bool):
            raise SonioxProtocolError

        final_tokens: list[SonioxToken] = []
        partial_tokens: list[SonioxToken] = []
        final_translation_tokens: list[SonioxTranslationToken] = []
        partial_translation_tokens: list[SonioxTranslationToken] = []
        markers: list[Marker] = []
        token_order: list[SonioxTokenRef] = []
        for value in tokens_value:
            if not isinstance(value, dict):
                raise SonioxProtocolError
            text = value.get("text")
            is_final = value.get("is_final")
            if not isinstance(text, str) or not isinstance(is_final, bool):
                raise SonioxProtocolError
            if text in {"<end>", "<fin>"}:
                if not is_final:
                    raise SonioxProtocolError
                markers.append("end" if text == "<end>" else "fin")
                continue
            status = value.get("translation_status", "none")
            if status == "translation":
                if self._config.translation_target_language is None:
                    raise SonioxProtocolError
                translated = _translation_token(value, text=text, is_final=is_final)
                target_translation = final_translation_tokens if is_final else partial_translation_tokens
                token_order.append(SonioxTokenRef("translation", is_final, len(target_translation)))
                (final_translation_tokens if is_final else partial_translation_tokens).append(translated)
            elif status in ("none", "original"):
                parsed = _token(value, text=text, is_final=is_final)
                token_order.append(SonioxTokenRef(
                    "original" if status == "original" else "none", is_final,
                    len(final_tokens if is_final else partial_tokens),
                ))
                (final_tokens if is_final else partial_tokens).append(parsed)
            else:
                raise SonioxProtocolError

        self._final_audio_proc_ms = final_ms
        self._total_audio_proc_ms = total_ms
        return SonioxEvent(
            final_tokens=tuple(final_tokens),
            partial_tokens=tuple(partial_tokens),
            markers=tuple(markers),
            final_audio_proc_ms=final_ms,
            total_audio_proc_ms=total_ms,
            finished=finished,
            final_translation_tokens=tuple(final_translation_tokens),
            partial_translation_tokens=tuple(partial_translation_tokens),
            token_order=tuple(token_order),
        )

    def _incomplete(self, error: str) -> SonioxCompletion:
        return SonioxCompletion(
            finished=False,
            final_audio_proc_ms=self._final_audio_proc_ms,
            total_audio_proc_ms=self._total_audio_proc_ms,
            error=error,
        )

    def _set_completion(self, completion: SonioxCompletion) -> None:
        if not self._completion.done():
            self._completion.set_result(completion)

    async def _fail(self, message: str) -> None:
        self._set_completion(self._incomplete(message))
        if self._receiver is not asyncio.current_task() and not self._receiver.done():
            self._receiver.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._receiver
        self._closed = True
        self._signal_events_end()
        await _close_socket(self._socket)

    def _signal_events_end(self) -> None:
        if self._events_ended:
            return
        self._events_ended = True
        self._events.put_nowait(None)


class _SonioxProviderResponse(Exception):
    def __init__(self, safe_message: str) -> None:
        super().__init__(safe_message)
        self.safe_message = safe_message


def _provider_response(payload: dict[str, Any]) -> _SonioxProviderResponse:
    code = payload.get("error_code")
    if isinstance(code, bool) or not isinstance(code, int) or not 400 <= code <= 599:
        raise SonioxProtocolError
    error_type = _safe_error_value(payload.get("error_type"))
    request_id = _safe_error_value(payload.get("request_id"))
    details = [f"HTTP {code}"]
    if error_type is not None:
        details.append(error_type)
    if request_id is not None:
        details.append(f"request {request_id}")
    return _SonioxProviderResponse(f"Soniox request failed ({', '.join(details)}).")


def _safe_error_value(value: object) -> str | None:
    return value if isinstance(value, str) and _SAFE_ERROR_VALUE.fullmatch(value) else None


async def _close_socket(socket: WebSocketTransport) -> None:
    with contextlib.suppress(Exception, TimeoutError):
        async with asyncio.timeout(CLOSE_TIMEOUT_S):
            await socket.close()


def _non_negative_int(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise SonioxProtocolError
    return value


def _token_metadata(value: dict[str, Any]) -> tuple[float, str | None, str | None]:
    confidence_value = value.get("confidence")
    if (
        isinstance(confidence_value, bool)
        or not isinstance(confidence_value, int | float)
        or not math.isfinite(confidence_value)
        or not 0 <= confidence_value <= 1
    ):
        raise SonioxProtocolError
    language = value.get("language")
    if language is not None and (not isinstance(language, str) or not language or len(language) > 32):
        raise SonioxProtocolError

    speaker = value.get("speaker")
    if speaker is not None and (not isinstance(speaker, str) or not speaker or len(speaker) > 128):
        raise SonioxProtocolError
    return float(confidence_value), language, speaker


def _translation_token(
    value: dict[str, Any], *, text: str, is_final: bool,
) -> SonioxTranslationToken:
    confidence, language, speaker = _token_metadata(value)
    source_language = value.get("source_language")
    if source_language is not None and (
        not isinstance(source_language, str) or not source_language or len(source_language) > 32
    ):
        raise SonioxProtocolError
    # Never propagate even unexpected provider timing into translated word provenance.
    return SonioxTranslationToken(text, confidence, is_final, language, source_language, speaker)


def _token(value: dict[str, Any], *, text: str, is_final: bool) -> SonioxToken:
    start_ms = _non_negative_int(value.get("start_ms"))
    end_ms = _non_negative_int(value.get("end_ms"))
    if end_ms < start_ms:
        raise SonioxProtocolError
    confidence, language, speaker = _token_metadata(value)
    return SonioxToken(
        text=text,
        start_ms=start_ms,
        end_ms=end_ms,
        confidence=confidence,
        is_final=is_final,
        language=language,
        speaker=speaker,
    )
