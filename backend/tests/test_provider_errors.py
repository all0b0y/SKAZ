"""Provider failure descriptions (``skaz.gateways``) never carry provider text.

Kept from the chat-gateway diagnostics when the chat gateway and the session
assistant/notes routes were removed: the shared descriptions remain in use by the
speech-to-text gateways."""

from __future__ import annotations

import httpx

from skaz.gateways import (
    describe_http_error,
    describe_transport_error,
    is_retryable_http_status,
)

# A provider body that carries everything that must never reach the user or a log line.
LEAKY_BODY = (
    '{"error": {"message": "key sk-live-9f3TOPSECRET rejected for user Ivan Petrov; '
    'prompt was: секретное совещание про увольнения", "code": "internal-trace-42"}}'
)
LEAKS = ("sk-live-9f3TOPSECRET", "Ivan Petrov", "секретное совещание", "internal-trace-42")


def assert_no_leak(message: str) -> None:
    for secret in LEAKS:
        assert secret not in message, message


# --- HTTP status classification -------------------------------------------------


def test_describe_http_error_ignores_a_body_passed_by_a_caller() -> None:
    """Siblings still pass ``response.text``; the helper must drop it."""
    message = describe_http_error("openai", 401, LEAKY_BODY)
    assert_no_leak(message)
    assert "401" in message


def test_temporary_and_permanent_failures_are_told_apart() -> None:
    assert is_retryable_http_status(429)
    assert is_retryable_http_status(503)
    assert not is_retryable_http_status(401)
    assert not is_retryable_http_status(404)
    assert "try again" in describe_http_error("openai", 503).lower()
    assert "try again" not in describe_http_error("openai", 404).lower()


# --- transport failures ---------------------------------------------------------


def test_describe_transport_error_covers_timeouts_without_the_exception_text() -> None:
    message = describe_transport_error("openai", httpx.ReadTimeout("read timeout on sk-live-9f3"))
    assert "openai" in message and "timed out" in message.lower()
    assert "sk-live-9f3" not in message


# --- malformed provider payloads ------------------------------------------------


# --- the same failures as seen through the public API ----------------------------


