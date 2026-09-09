"""Chat gateway failure diagnostics.

Two seams are exercised here:

* the gateway itself (``build_chat`` driven through an injected ``httpx`` mock
  transport), because that is where provider status codes and malformed payloads
  are turned into ``ProviderError``;
* the public HTTP API (``/sessions/{id}/ask`` and ``/sessions/{id}/notes``),
  because that is what the desktop UI actually shows to the user.

Every assertion checks two things at once: the message must be useful (it names
the provider, the status and what to do next) and it must never carry provider
response text, exception text, keys or transcript fragments.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest

from audiohelper.gateways import (
    ProviderError,
    describe_http_error,
    describe_transport_error,
    is_retryable_http_status,
)
from audiohelper.gateways.chat import ChatGateway, ChatMessage, ProviderTimeout, build_chat
from tests.conftest import FakeHttp, chat_completion, make_wav

AGENT_MODEL = "qwen/qwen3-30b-a3b-instruct-2507"
ASR_MODEL = "google/gemini-2.5-flash-lite"

# A provider body that carries everything that must never reach the user or a log line.
LEAKY_BODY = (
    '{"error": {"message": "key sk-live-9f3TOPSECRET rejected for user Ivan Petrov; '
    'prompt was: секретное совещание про увольнения", "code": "internal-trace-42"}}'
)
LEAKS = ("sk-live-9f3TOPSECRET", "Ivan Petrov", "секретное совещание", "internal-trace-42")

CATALOG = {
    "data": [
        {
            "id": ASR_MODEL,
            "architecture": {"input_modalities": ["text", "audio"], "output_modalities": ["text"]},
        },
        {
            "id": AGENT_MODEL,
            "architecture": {"input_modalities": ["text"], "output_modalities": ["text"]},
        },
    ]
}


@pytest.fixture(autouse=True)
def _catalog(outbound: FakeHttp) -> None:
    outbound.json_route("GET", "openrouter.ai/api/v1/models", CATALOG)


@pytest.fixture
async def transport(outbound: FakeHttp) -> AsyncIterator[httpx.AsyncClient]:
    http = outbound.client()
    yield http
    await http.aclose()


def openrouter_chat(http: httpx.AsyncClient) -> ChatGateway:
    return build_chat(
        http=http,
        provider="openrouter",
        model=AGENT_MODEL,
        api_key="sk-test",
        base_url=None,
        timeout=5.0,
    )


def anthropic_chat(http: httpx.AsyncClient) -> ChatGateway:
    return build_chat(
        http=http,
        provider="anthropic",
        model="claude-test",
        api_key="sk-test",
        base_url=None,
        timeout=5.0,
    )


async def complete(gateway: ChatGateway) -> str:
    return await gateway.complete([ChatMessage(role="user", content="Вопрос")], max_tokens=100)


def assert_no_leak(message: str) -> None:
    for secret in LEAKS:
        assert secret not in message, message


# --- HTTP status classification -------------------------------------------------


@pytest.mark.parametrize(
    ("status", "expected"),
    [
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
    ],
)
async def test_http_status_is_explained_without_the_provider_body(
    outbound: FakeHttp, transport: httpx.AsyncClient, status: int, expected: str
) -> None:
    outbound.routes[("POST", "chat/completions")] = lambda _r: httpx.Response(status, text=LEAKY_BODY)
    with pytest.raises(ProviderError) as failure:
        await complete(openrouter_chat(transport))
    message = str(failure.value)
    assert "openrouter" in message
    assert str(status) in message
    assert expected in message.lower(), message
    assert_no_leak(message)


async def test_unknown_status_still_names_the_provider_and_the_code(
    outbound: FakeHttp, transport: httpx.AsyncClient
) -> None:
    outbound.routes[("POST", "chat/completions")] = lambda _r: httpx.Response(418, text=LEAKY_BODY)
    with pytest.raises(ProviderError) as failure:
        await complete(openrouter_chat(transport))
    message = str(failure.value)
    assert "openrouter" in message and "418" in message
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


@pytest.mark.parametrize(
    "error",
    [
        httpx.ConnectError("connection refused to https://secret-host.internal/v1?key=sk-live-9f3"),
        httpx.RemoteProtocolError("peer closed while sending sk-live-9f3"),
        httpx.TooManyRedirects("redirect loop via https://secret-host.internal"),
    ],
)
async def test_transport_failures_do_not_leak_the_exception_text(
    outbound: FakeHttp, transport: httpx.AsyncClient, error: Exception
) -> None:
    def fail(request: httpx.Request) -> httpx.Response:
        raise error

    outbound.routes[("POST", "chat/completions")] = fail
    with pytest.raises(ProviderError) as failure:
        await complete(openrouter_chat(transport))
    message = str(failure.value)
    assert "openrouter" in message
    assert "sk-live-9f3" not in message and "secret-host.internal" not in message


def test_describe_transport_error_covers_timeouts_without_the_exception_text() -> None:
    message = describe_transport_error("openai", httpx.ReadTimeout("read timeout on sk-live-9f3"))
    assert "openai" in message and "timed out" in message.lower()
    assert "sk-live-9f3" not in message


async def test_timeout_stays_a_provider_timeout_and_says_so(
    outbound: FakeHttp, transport: httpx.AsyncClient
) -> None:
    def timeout(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("timed out talking to sk-live-9f3", request=request)

    outbound.routes[("POST", "chat/completions")] = timeout
    with pytest.raises(ProviderTimeout) as failure:
        await complete(openrouter_chat(transport))
    message = str(failure.value)
    assert "timeout" in message.lower()
    assert "sk-live-9f3" not in message


# --- malformed provider payloads ------------------------------------------------


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"choices": "text"},
        {"choices": []},
        {"choices": ["oops"]},
        {"choices": [None]},
        {"choices": [{"message": "oops"}]},
        {"choices": [{"message": None}]},
        {"choices": [{"message": {"content": 5}}]},
        {"choices": [{"message": {"content": None}}]},
        {"choices": [{"message": {"content": [{"text": 5}]}}]},
        {"choices": [{"message": {"content": [None]}}]},
        {"choices": [{"message": {"content": "   "}}]},
    ],
)
async def test_malformed_openai_payloads_raise_provider_error(
    outbound: FakeHttp, transport: httpx.AsyncClient, payload: dict[str, Any]
) -> None:
    outbound.json_route("POST", "chat/completions", payload)
    with pytest.raises(ProviderError):
        await complete(openrouter_chat(transport))


async def test_missing_choices_does_not_echo_the_provider_error_payload(
    outbound: FakeHttp, transport: httpx.AsyncClient
) -> None:
    outbound.json_route(
        "POST",
        "chat/completions",
        {"error": {"message": "key sk-live-9f3TOPSECRET rejected", "code": "internal-trace-42"}},
    )
    with pytest.raises(ProviderError) as failure:
        await complete(openrouter_chat(transport))
    assert_no_leak(str(failure.value))


async def test_non_json_response_does_not_echo_the_body(
    outbound: FakeHttp, transport: httpx.AsyncClient
) -> None:
    outbound.routes[("POST", "chat/completions")] = lambda _r: httpx.Response(200, text=LEAKY_BODY)
    with pytest.raises(ProviderError) as failure:
        await complete(openrouter_chat(transport))
    message = str(failure.value)
    assert "openrouter" in message
    assert_no_leak(message)


async def test_valid_content_parts_still_produce_an_answer(
    outbound: FakeHttp, transport: httpx.AsyncClient
) -> None:
    outbound.json_route(
        "POST",
        "chat/completions",
        {"choices": [{"message": {"content": [{"text": "Ответ "}, {"text": "модели"}]}}]},
    )
    assert await complete(openrouter_chat(transport)) == "Ответ модели"


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"content": "text"},
        {"content": []},
        {"content": [None]},
        {"content": [{"text": 5}]},
        {"content": [{"text": None}]},
        {"content": [{"type": "text", "text": "  "}]},
    ],
)
async def test_malformed_anthropic_payloads_raise_provider_error(
    outbound: FakeHttp, transport: httpx.AsyncClient, payload: dict[str, Any]
) -> None:
    outbound.json_route("POST", "api.anthropic.com", payload)
    with pytest.raises(ProviderError):
        await complete(anthropic_chat(transport))


async def test_valid_anthropic_blocks_still_produce_an_answer(
    outbound: FakeHttp, transport: httpx.AsyncClient
) -> None:
    outbound.json_route(
        "POST",
        "api.anthropic.com",
        {"content": [{"type": "text", "text": "Ответ "}, {"type": "thinking"}, {"text": "модели"}]},
    )
    assert await complete(anthropic_chat(transport)) == "Ответ модели"


# --- the same failures as seen through the public API ----------------------------


async def prepared_session(client: httpx.AsyncClient, outbound: FakeHttp) -> str:
    configured = await client.put(
        "/settings",
        json={
            "asr": {"provider": "openrouter", "model": ASR_MODEL, "api_key": "sk-test"},
            "agent": {"provider": "openrouter", "model": AGENT_MODEL},
            "notes": {"provider": "openrouter", "model": AGENT_MODEL},
            "cloud_consent": True,
        },
    )
    assert configured.status_code == 200, configured.text
    created = await client.post("/sessions", json={"title": "Лекция"})
    session_id = str(created.json()["id"])
    outbound.json_route("POST", "chat/completions", chat_completion("Определили энтропию."))
    stored = await client.post(
        f"/sessions/{session_id}/audio",
        params={"sequence": 0, "start_ms": 0, "end_ms": 30_000},
        content=make_wav(1.0),
        headers={"Content-Type": "audio/wav"},
    )
    assert stored.status_code == 200, stored.text
    return session_id


async def test_ask_reports_a_rejected_key_without_leaking_the_body(
    client: httpx.AsyncClient, outbound: FakeHttp
) -> None:
    session = await prepared_session(client, outbound)
    outbound.routes[("POST", "chat/completions")] = lambda _r: httpx.Response(401, text=LEAKY_BODY)
    response = await client.post(f"/sessions/{session}/ask", json={"question": "Что было?"})
    assert response.status_code == 502, response.text
    detail = response.json()["detail"]
    assert "401" in detail and "api key" in detail.lower()
    assert_no_leak(detail)


async def test_notes_report_an_unavailable_provider_without_leaking_the_body(
    client: httpx.AsyncClient, outbound: FakeHttp
) -> None:
    session = await prepared_session(client, outbound)
    outbound.routes[("POST", "chat/completions")] = lambda _r: httpx.Response(503, text=LEAKY_BODY)
    response = await client.post(f"/sessions/{session}/notes", json={})
    assert response.status_code == 502, response.text
    detail = response.json()["detail"]
    assert "503" in detail and "try again" in detail.lower()
    assert_no_leak(detail)


async def test_malformed_answer_payload_is_a_bad_gateway_not_a_crash(
    client: httpx.AsyncClient, outbound: FakeHttp
) -> None:
    session = await prepared_session(client, outbound)
    outbound.json_route("POST", "chat/completions", {"choices": [{"message": "oops"}]})
    response = await client.post(f"/sessions/{session}/ask", json={"question": "Что было?"})
    assert response.status_code == 502, response.text
    assert isinstance(response.json()["detail"], str)
