"""Text chat adapters for the agent and the notes writer.

The two tasks use independent profiles, so a session can answer questions with one
model while summarising with another.

Both adapters share one request policy (:func:`_post_completion`): the exact same
body is sent at most twice, only for statuses the provider itself declares
temporary, inside a single deadline shared by the calls and the wait between them.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Protocol

import httpx

from ..activity import record_attempt
from . import ProviderError, ProviderNotConfigured, describe_http_error, describe_transport_error

OPENAI_BASE_URL = "https://api.openai.com/v1"
OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_VERSION = "2023-06-01"

logger = logging.getLogger(__name__)

#: The one operation these adapters perform, named in every log line.
OPERATION = "provider text completion"

#: The original request plus at most one replay. A text completion is not free, and
#: a model that fails twice needs a different model, not a third charge.
MAX_ATTEMPTS = 2

#: Explicit transient HTTP failures eligible for one bounded retry.
#: These statuses do not guarantee that the provider did not process or charge
#: the first request; in particular an upstream gateway timeout is ambiguous.
#:
#: Deliberately narrower than :data:`~audiohelper.gateways.RETRYABLE_HTTP_STATUSES`,
#: which only picks the wording of a message. 500 can mean the request was processed
#: and then failed to serialise, and 408/409/425 say nothing about what was done with
#: the body, so replaying them could charge and answer twice.
RETRY_STATUSES = frozenset({429, 502, 503, 504, 529})

#: Waited before a replay when the provider sends no ``Retry-After``.
DEFAULT_RETRY_DELAY_S = 0.25


class ProviderTimeout(ProviderError):
    """The provider did not answer within the configured timeout."""


@dataclass(frozen=True)
class ChatMessage:
    role: str
    content: str


class ChatGateway(Protocol):
    provider: str
    model: str

    async def complete(self, messages: list[ChatMessage], *, max_tokens: int) -> str: ...


class OpenAICompatibleChat:
    """/chat/completions — used by OpenAI, OpenRouter and self-hosted compatible servers."""

    def __init__(
        self,
        http: httpx.AsyncClient,
        *,
        provider: str,
        model: str,
        api_key: str,
        base_url: str,
        timeout: float,
    ) -> None:
        self._http = http
        self.provider = provider
        self.model = model
        self._api_key = api_key
        self._base = base_url.rstrip("/")
        self._timeout = timeout

    async def complete(self, messages: list[ChatMessage], *, max_tokens: int) -> str:
        request = {
            "model": self.model,
            "temperature": 0.2,
            "max_tokens": max_tokens,
            "messages": [{"role": message.role, "content": message.content} for message in messages],
        }
        return await _post_completion(
            self._http,
            provider=self.provider,
            model=self.model,
            url=f"{self._base}/chat/completions",
            headers={"Authorization": f"Bearer {self._api_key}", "Content-Type": "application/json"},
            body=json.dumps(request).encode("utf-8"),
            timeout=self._timeout,
            read=lambda payload: _text_from_choices(self.provider, payload),
            usage=lambda payload: _token_counts(payload, _OPENAI_TOKEN_FIELDS),
        )


class AnthropicChat:
    """/v1/messages."""

    provider = "anthropic"

    def __init__(self, http: httpx.AsyncClient, *, model: str, api_key: str, timeout: float) -> None:
        self._http = http
        self.model = model
        self._api_key = api_key
        self._timeout = timeout

    async def complete(self, messages: list[ChatMessage], *, max_tokens: int) -> str:
        system = "\n\n".join(message.content for message in messages if message.role == "system")
        turns = [
            {"role": message.role, "content": message.content}
            for message in messages
            if message.role != "system"
        ]
        request: dict[str, Any] = {"model": self.model, "max_tokens": max_tokens, "messages": turns}
        if system:
            request["system"] = system
        return await _post_completion(
            self._http,
            provider=self.provider,
            model=self.model,
            url=ANTHROPIC_MESSAGES_URL,
            headers={
                "x-api-key": self._api_key,
                "anthropic-version": ANTHROPIC_VERSION,
                "Content-Type": "application/json",
            },
            body=json.dumps(request).encode("utf-8"),
            timeout=self._timeout,
            read=_text_from_blocks,
            usage=lambda payload: _token_counts(payload, _ANTHROPIC_TOKEN_FIELDS),
        )


async def _post_completion(
    http: httpx.AsyncClient,
    *,
    provider: str,
    model: str,
    url: str,
    headers: dict[str, str],
    body: bytes,
    timeout: float,
    read: Callable[[dict[str, Any]], str],
    usage: Callable[[dict[str, Any]], dict[str, int]],
) -> str:
    """Post one completion request, replaying it at most once, and log the outcome.

    ``timeout`` is the budget for the whole operation, not for one attempt: the
    deadline covers both requests and the wait between them, so a retry can never
    double how long a question or a note may block.

    A replay only happens for :data:`RETRY_STATUSES`. A timeout, a broken
    connection, any other transport failure and a malformed successful reply are
    never replayed: the provider may already have produced (and charged for) an
    answer. Cancellation is not caught, so a cancelled question stops here.
    """
    deadline = time.monotonic() + timeout
    attempt = 1
    while True:
        started = time.monotonic()
        try:
            remaining = deadline - started
            if remaining <= 0:
                raise TimeoutError
            async with asyncio.timeout(remaining):
                response = await http.post(
                    url, headers=headers, content=body, timeout=remaining
                )
        except (httpx.TimeoutException, TimeoutError) as error:
            _log(provider, model, attempt, started, outcome="timeout")
            raise ProviderTimeout(
                f"{provider} timeout after {timeout:.0f}s. Try again or pick a faster model."
            ) from error
        except httpx.HTTPError as error:
            _log(provider, model, attempt, started, outcome="transport_error")
            raise ProviderError(describe_transport_error(provider, error)) from error

        status = response.status_code
        if status >= 400:
            delay = _retry_delay(response, status=status, attempt=attempt, deadline=deadline)
            if delay is None:
                _log(provider, model, attempt, started, outcome="http_error", status=status)
                raise ProviderError(describe_http_error(provider, status))
            _log(provider, model, attempt, started, outcome="http_error", status=status, retrying=True)
            await asyncio.sleep(delay)
            attempt += 1
            continue

        try:
            payload = _json(response, provider)
            text = read(payload)
        except ProviderError:
            _log(provider, model, attempt, started, outcome="invalid_response", status=status)
            raise
        _log(provider, model, attempt, started, outcome="ok", status=status, usage=usage(payload))
        return text


def _retry_delay(
    response: httpx.Response, *, status: int, attempt: int, deadline: float
) -> float | None:
    """Seconds to wait before replaying, or ``None`` when this must not be replayed.

    A ``Retry-After`` that is not a plain number (an HTTP date, or junk) is an
    instruction that cannot be honoured exactly, so the request is reported instead
    of being replayed at a guessed moment. A delay that does not leave room for the
    second attempt inside the shared deadline is refused for the same reason.
    """
    if attempt >= MAX_ATTEMPTS or status not in RETRY_STATUSES:
        return None
    header = response.headers.get("retry-after")
    if header is None:
        delay = DEFAULT_RETRY_DELAY_S
    else:
        parsed = _retry_after_seconds(header)
        if parsed is None:
            return None
        delay = parsed
    if delay >= deadline - time.monotonic():
        return None
    return delay


def _retry_after_seconds(header: str) -> float | None:
    """A non-negative, finite number of seconds, or ``None`` for any other form."""
    try:
        seconds = float(header.strip())
    except ValueError:
        return None
    if not math.isfinite(seconds) or seconds < 0:
        return None
    return seconds


def _log(
    provider: str,
    model: str,
    attempt: int,
    started: float,
    *,
    outcome: str,
    status: int | None = None,
    retrying: bool = False,
    usage: dict[str, int] | None = None,
) -> None:
    """One technical line per attempt: what ran, where, how long, how it ended.

    Never the messages, the response body, the request headers, the URL or the text
    of an exception — those carry transcript fragments, account details and keys.
    The line is JSON, so a model ID containing a newline or a quote stays one line
    and cannot forge a second record.
    """
    record: dict[str, Any] = {
        "operation": OPERATION,
        "provider": provider,
        "model": model,
        "attempt": attempt,
        "elapsed_ms": round((time.monotonic() - started) * 1000),
        "outcome": outcome,
    }
    if status is not None:
        record["status"] = status
    if retrying:
        record["retrying"] = True
    if usage:
        record["usage"] = usage
    logger.log(logging.INFO if outcome == "ok" else logging.WARNING, "%s", json.dumps(record))
    record_attempt(record)


_OPENAI_TOKEN_FIELDS = {
    "prompt_tokens": "input_tokens",
    "completion_tokens": "output_tokens",
    "total_tokens": "total_tokens",
}
_ANTHROPIC_TOKEN_FIELDS = {"input_tokens": "input_tokens", "output_tokens": "output_tokens"}


def _token_counts(payload: dict[str, Any], fields: dict[str, str]) -> dict[str, int]:
    """Only the known token counters, and only when they arrived as plain integers.

    A provider's ``usage`` object is arbitrary JSON: it can carry request ids, echoed
    prompts or nested billing records, so it is never logged as a whole.
    """
    reported = payload.get("usage")
    if not isinstance(reported, dict):
        return {}
    counts: dict[str, int] = {}
    for source, name in fields.items():
        value = reported.get(source)
        if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
            counts[name] = value
    return counts


def _json(response: httpx.Response, provider: str) -> dict[str, Any]:
    try:
        payload = response.json()
    except ValueError as error:
        raise ProviderError(f"{provider} returned a non-JSON response.") from error
    if not isinstance(payload, dict):
        raise ProviderError(f"{provider} returned an unexpected response shape.")
    return payload


def _joined_text(content: Any) -> str:
    """Text from a plain string or from content parts, ignoring anything else.

    Providers disagree about the shape of a message, so an unexpected part must
    end as an empty answer (a ``ProviderError`` for the caller) and never as a
    ``TypeError`` from inside the join.
    """
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts = []
    for part in content:
        if isinstance(part, str):
            parts.append(part)
        elif isinstance(part, dict) and isinstance(part.get("text"), str):
            parts.append(str(part["text"]))
    return "".join(parts)


def _text_from_blocks(payload: dict[str, Any]) -> str:
    """The assistant message of an Anthropic ``/v1/messages`` reply."""
    blocks = payload.get("content")
    if not isinstance(blocks, list):
        raise ProviderError("anthropic returned no content blocks.")
    text = _joined_text(blocks)
    if not text.strip():
        raise ProviderError("anthropic returned an empty message. Try again or pick another model.")
    return text


def _text_from_choices(provider: str, payload: dict[str, Any]) -> str:
    """The assistant message, with every level of the shape checked.

    The provider's own error payload is not repeated: it can echo the prompt (and
    with it transcript fragments) or the rejected key.
    """
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        raise ProviderError(
            f"{provider} returned no answer choices. Try again or pick another model."
        )
    first = choices[0]
    message = first.get("message") if isinstance(first, dict) else None
    text = _joined_text(message.get("content") if isinstance(message, dict) else None)
    if not text.strip():
        raise ProviderError(f"{provider} returned an empty message. Try again or pick another model.")
    return text


def build_chat(
    *,
    http: httpx.AsyncClient,
    provider: str,
    model: str,
    api_key: str | None,
    timeout: float,
) -> ChatGateway:
    if not model:
        raise ProviderNotConfigured("No model is configured for this task. Pick one in settings.")
    if provider in ("local-whisper", "local-gigachat-mlx"):
        raise ProviderNotConfigured(f"{provider} accepts audio and cannot answer text-only questions.")
    if not api_key:
        raise ProviderNotConfigured(f"No API key stored for provider '{provider}'.")
    if provider == "anthropic":
        return AnthropicChat(http, model=model, api_key=api_key, timeout=timeout)
    if provider == "openrouter":
        base = OPENROUTER_BASE_URL
    elif provider == "openai":
        base = OPENAI_BASE_URL
    else:
        raise ProviderNotConfigured(f"Provider '{provider}' has no chat adapter.")
    return OpenAICompatibleChat(
        http, provider=provider, model=model, api_key=api_key, base_url=base, timeout=timeout
    )
