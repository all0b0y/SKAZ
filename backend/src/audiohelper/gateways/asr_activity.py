"""ASR attempt instrumentation, independent of transcript contents."""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable, Coroutine
from contextvars import ContextVar
from dataclasses import dataclass, field
from functools import wraps
from typing import Any, Concatenate, ParamSpec, Protocol, TypeVar

import httpx

from ..activity import record_attempt
from . import ProviderNotConfigured

OPERATION = "provider audio transcription"


@dataclass
class _Attempt:
    status: int | None = None
    usage: dict[str, int] = field(default_factory=dict)


_attempt: ContextVar[_Attempt | None] = ContextVar("asr_attempt", default=None)


class _Transcriber(Protocol):
    provider: str
    model: str


_S = TypeVar("_S", bound=_Transcriber)
_P = ParamSpec("_P")
_R = TypeVar("_R")


def observed_transcription(
    method: Callable[Concatenate[_S, _P], Awaitable[_R]],
) -> Callable[Concatenate[_S, _P], Coroutine[Any, Any, _R]]:
    @wraps(method)
    async def observed(self: _S, /, *args: _P.args, **kwargs: _P.kwargs) -> _R:
        started = time.monotonic()
        attempt = _Attempt()
        token = _attempt.set(attempt)
        outcome = "ok"
        try:
            return await method(self, *args, **kwargs)
        except ProviderNotConfigured:
            outcome = "not_configured"
            raise
        except asyncio.CancelledError:
            outcome = "cancelled"
            raise
        except Exception as error:
            if isinstance(error, httpx.HTTPError) or isinstance(error.__cause__, httpx.HTTPError):
                outcome = "transport_error"
            elif attempt.status is not None and attempt.status >= 400:
                outcome = "http_error"
            elif attempt.status is not None:
                outcome = "invalid_response"
            else:
                outcome = "error"
            raise
        finally:
            _attempt.reset(token)
            record_attempt({
                "operation": OPERATION,
                "provider": self.provider,
                "model": self.model,
                "attempt": 1,
                "elapsed_ms": round((time.monotonic() - started) * 1000),
                "outcome": outcome,
                "status": attempt.status,
                "usage": attempt.usage,
            })

    return observed


def observe_response(response: httpx.Response) -> None:
    attempt = _attempt.get()
    if attempt is None:
        return
    attempt.status = response.status_code
    if response.status_code >= 400:
        return
    try:
        payload = response.json()
    except ValueError:
        return
    usage = payload.get("usage") if isinstance(payload, dict) else None
    if not isinstance(usage, dict):
        return
    for source, target in {
        "prompt_tokens": "input_tokens", "completion_tokens": "output_tokens",
        "input_tokens": "input_tokens", "output_tokens": "output_tokens", "total_tokens": "total_tokens",
    }.items():
        value = usage.get(source)
        if type(value) is int and value >= 0:
            attempt.usage[target] = value
