"""Outbound provider gateways (ASR and chat)."""

from __future__ import annotations

import httpx


class ProviderNotConfigured(ValueError):
    """The profile cannot be used yet: missing key, missing consent, missing dependency."""


class ProviderError(RuntimeError):
    """The provider was called and did not return a usable answer."""


CLOUD_PROVIDERS = frozenset({"openai", "openrouter", "anthropic", "openai-compatible"})


def require_cloud_consent(provider: str, cloud_consent: bool, material: str) -> None:
    """Block before a gateway can transmit user audio or text."""
    if provider in CLOUD_PROVIDERS and not cloud_consent:
        raise ProviderNotConfigured(
            f"Sending {material} to {provider} requires cloud consent; enable it in settings."
        )


#: Statuses worth a bounded retry later; everything else needs a settings or model change.
RETRYABLE_HTTP_STATUSES = frozenset({408, 409, 425, 429, 500, 502, 503, 504, 522, 524, 529})

_HTTP_REASONS: dict[int, str] = {
    400: "the provider rejected the request as invalid",
    401: "the stored API key was rejected",
    402: "the provider account has no credit left for this key",
    403: "this key may not use this model",
    404: "the model or the endpoint was not found",
    408: "the provider dropped the request before reading it",
    409: "the provider reported a conflicting request",
    413: "the request was too large for this model",
    415: "the provider rejected the request format",
    422: "the provider could not process these request parameters",
    429: "the provider rate limit or quota was reached",
    500: "the provider failed internally",
    502: "the provider gateway failed",
    503: "the provider is temporarily unavailable",
    504: "the provider timed out upstream",
    529: "the provider is overloaded",
}

_HTTP_ACTIONS: dict[int, str] = {
    400: "Pick another model or report the exact model ID.",
    401: "Check the API key stored for this provider in settings.",
    402: "Top up the provider account or pick another provider.",
    403: "Check what this key is allowed to use, or pick another model.",
    404: "Check the exact model ID and the base URL in settings.",
    413: "Ask about a shorter window, or send smaller audio chunks.",
    415: "Pick another model: this one does not accept this request format.",
    422: "Pick another model or change the request parameters.",
}

_RETRY_ACTION = "Try again in a moment, or pick another model."
_PERMANENT_ACTION = "Retrying will not help; change the model or the provider settings."


def is_retryable_http_status(status: int) -> bool:
    """Whether a bounded retry can plausibly succeed; a key or model problem cannot."""
    return status in RETRYABLE_HTTP_STATUSES


def describe_http_error(provider: str, status: int, _body: str = "") -> str:
    """A classified, non-leaking message for the UI.

    The response body is deliberately never used: provider error text can echo the
    prompt (transcript fragments), account details or a rejected key. Callers may
    still pass it — the parameter only keeps existing call sites working.
    """
    reason = _HTTP_REASONS.get(status)
    if reason is None:
        reason = "the provider rejected the request" if status < 500 else "the provider failed"
    action = _HTTP_ACTIONS.get(status)
    if action is None:
        action = _RETRY_ACTION if is_retryable_http_status(status) else _PERMANENT_ACTION
    return f"{provider} request failed with HTTP {status}: {reason}. {action}"


def describe_transport_error(provider: str, error: Exception) -> str:
    """A network failure described by its kind, never by the exception text.

    ``httpx`` puts the full URL — and for some compatible providers the key that
    sits in it — into the exception message, so it must not reach the UI or a log.
    """
    if isinstance(error, httpx.TimeoutException):
        reason = "the connection timed out"
    elif isinstance(error, httpx.ConnectError):
        reason = "the connection could not be established"
    elif isinstance(error, httpx.ProtocolError):
        reason = "the connection broke before a complete response arrived"
    else:
        reason = "the request failed before a response arrived"
    return f"{provider} could not be reached: {reason}. Check the network and the base URL, then try again."
