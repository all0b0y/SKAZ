"""Provider failure descriptions (``skaz.gateways``) never carry provider text.

Two seams are exercised:

* the shared helpers ``describe_http_error`` / ``describe_transport_error``;
* the OpenAI speech-to-text decoder (``gateways.openai_stream``), the live caller
  that turns provider replies into ``LiveAsrError`` messages shown to the user.

Every assertion checks two things at once: the message must be useful (it names
the provider, the status and what to do next) and it must never carry provider
response text, exception text, keys, hosts or transcript fragments.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

import httpx
import pytest

from skaz.gateways import (
    LiveAsrError,
    describe_http_error,
    describe_transport_error,
    is_retryable_http_status,
)
from skaz.gateways.openai_stream import OPENAI_TRANSCRIPTIONS_URL, OpenAIWindowDecoder
from skaz.gateways.whisper_stream import SAMPLE_RATE
from tests.conftest import FakeHttp

# A provider body that carries everything that must never reach the user or a log line.
LEAKY_BODY = (
    '{"error": {"message": "key sk-live-9f3TOPSECRET rejected for user Ivan Petrov; '
    'prompt was: секретное совещание про увольнения", "code": "internal-trace-42"}}'
)
LEAKS = ("sk-live-9f3TOPSECRET", "Ivan Petrov", "секретное совещание", "internal-trace-42")

#: One second of silence: long enough for the decoder to call the provider.
ONE_SECOND_PCM = b"\x00\x00" * SAMPLE_RATE

HTTP_STATUSES = [
    (400, "invalid"),
    (401, "api key"),
    (402, "credit"),
    (403, "may not use"),
    (404, "not found"),
    (413, "too large"),
    (422, "parameters"),
    (429, "rate limit"),
    (500, "failed internally"),
    (502, "gateway"),
    (503, "temporarily unavailable"),
    (504, "timed out"),
    (529, "overloaded"),
]

TRANSPORT_ERRORS = [
    httpx.ConnectError("connection refused to https://secret-host.internal/v1?key=sk-live-9f3"),
    httpx.RemoteProtocolError("peer closed while sending sk-live-9f3"),
    httpx.TooManyRedirects("redirect loop via https://secret-host.internal"),
]


def assert_no_leak(message: str) -> None:
    for secret in LEAKS:
        assert secret not in message, message


@pytest.fixture
async def transport(outbound: FakeHttp) -> AsyncIterator[httpx.AsyncClient]:
    http = outbound.client()
    yield http
    await http.aclose()


async def decode_with_openai(http: httpx.AsyncClient) -> None:
    decoder = OpenAIWindowDecoder(http, api_key="sk-test", model="whisper-1", timeout=5.0)
    await decoder.decode(ONE_SECOND_PCM, language="ru", languages=None, prompt="")


# --- HTTP status classification -------------------------------------------------


@pytest.mark.parametrize(("status", "expected"), HTTP_STATUSES)
def test_http_status_is_explained_without_the_provider_body(status: int, expected: str) -> None:
    message = describe_http_error("OpenAI", status, LEAKY_BODY)
    assert "OpenAI" in message
    assert str(status) in message
    assert expected in message.lower(), message
    assert_no_leak(message)


def test_unknown_status_still_names_the_provider_and_the_code() -> None:
    message = describe_http_error("OpenAI", 418, LEAKY_BODY)
    assert "OpenAI" in message and "418" in message
    assert_no_leak(message)


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


@pytest.mark.parametrize("error", TRANSPORT_ERRORS)
def test_transport_failures_do_not_leak_the_exception_text(error: Exception) -> None:
    message = describe_transport_error("OpenAI", error)
    assert "OpenAI" in message
    assert "sk-live-9f3" not in message and "secret-host.internal" not in message


def test_describe_transport_error_covers_timeouts_without_the_exception_text() -> None:
    message = describe_transport_error("openai", httpx.ReadTimeout("read timeout on sk-live-9f3"))
    assert "openai" in message and "timed out" in message.lower()
    assert "sk-live-9f3" not in message


# --- the same failures as seen through OpenAI speech-to-text ---------------------


@pytest.mark.parametrize(("status", "expected"), HTTP_STATUSES)
async def test_openai_transcription_explains_the_status_without_the_body(
    outbound: FakeHttp, transport: httpx.AsyncClient, status: int, expected: str
) -> None:
    outbound.routes[("POST", OPENAI_TRANSCRIPTIONS_URL)] = lambda _r: httpx.Response(status, text=LEAKY_BODY)
    with pytest.raises(LiveAsrError) as failure:
        await decode_with_openai(transport)
    message = str(failure.value)
    assert "OpenAI" in message and str(status) in message
    assert expected in message.lower(), message
    assert failure.value.retryable is is_retryable_http_status(status)
    assert_no_leak(message)


async def test_openai_transcription_names_an_unknown_status_without_the_body(
    outbound: FakeHttp, transport: httpx.AsyncClient
) -> None:
    outbound.routes[("POST", OPENAI_TRANSCRIPTIONS_URL)] = lambda _r: httpx.Response(418, text=LEAKY_BODY)
    with pytest.raises(LiveAsrError) as failure:
        await decode_with_openai(transport)
    message = str(failure.value)
    assert "OpenAI" in message and "418" in message
    assert_no_leak(message)


@pytest.mark.parametrize("error", TRANSPORT_ERRORS)
async def test_openai_transcription_transport_failure_does_not_leak_the_exception_text(
    outbound: FakeHttp, transport: httpx.AsyncClient, error: Exception
) -> None:
    def fail(request: httpx.Request) -> httpx.Response:
        raise error

    outbound.routes[("POST", OPENAI_TRANSCRIPTIONS_URL)] = fail
    with pytest.raises(LiveAsrError) as failure:
        await decode_with_openai(transport)
    message = str(failure.value)
    assert "OpenAI" in message
    assert failure.value.retryable
    assert "sk-live-9f3" not in message and "secret-host.internal" not in message


async def test_openai_transcription_non_json_reply_does_not_echo_the_body(
    outbound: FakeHttp, transport: httpx.AsyncClient
) -> None:
    html = f"<html>{LEAKY_BODY}</html>"
    outbound.routes[("POST", OPENAI_TRANSCRIPTIONS_URL)] = lambda _r: httpx.Response(200, text=html)
    with pytest.raises(LiveAsrError) as failure:
        await decode_with_openai(transport)
    assert_no_leak(str(failure.value))
