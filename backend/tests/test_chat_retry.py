"""Bounded chat retries and the technical log line.

Everything is driven through the public gateway (``build_chat``) over an injected
``httpx`` transport, and through the public HTTP API where the user sees the
result, so the production request path is the one under test.

Two properties are checked everywhere: a request is replayed only when the
provider itself said it was not served, and the log line carries operation,
provider, exact model ID, attempt, elapsed and outcome — never the conversation,
the response body, the headers, the URL or an exception text.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import AsyncIterator, Callable
from typing import Any

import httpx
import pytest

from audiohelper.gateways import ProviderError, is_retryable_http_status
from audiohelper.gateways.chat import (
    MAX_ATTEMPTS,
    OPERATION,
    RETRY_STATUSES,
    ChatGateway,
    ChatMessage,
    ProviderTimeout,
    build_chat,
)
from tests.conftest import FakeHttp, chat_completion, make_wav

LOGGER_NAME = "audiohelper.gateways.chat"

AGENT_MODEL = "qwen/qwen3-30b-a3b-instruct-2507"
ASR_MODEL = "google/gemini-2.5-flash-lite"
ANTHROPIC_MODEL = "claude-test-1"
API_KEY = "sk-live-9f3TOPSECRET"

# Everything that must never appear in a log record or in a user-facing message.
LEAKY_BODY = (
    '{"error": {"message": "key sk-live-9f3TOPSECRET rejected for Ivan Petrov; '
    'prompt was: секретное совещание про увольнения"}}'
)
QUESTION = "Что решили по бюджету на секретном совещании?"
LEAKS = (
    API_KEY,
    "Ivan Petrov",
    "секретное совещание",
    QUESTION,
    "openrouter.ai",
    "api.anthropic.com",
    "Authorization",
    "x-api-key",
)

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

Handler = Callable[[httpx.Request], httpx.Response]


@pytest.fixture(autouse=True)
def _catalog(outbound: FakeHttp) -> None:
    outbound.json_route("GET", "openrouter.ai/api/v1/models", CATALOG)


@pytest.fixture(autouse=True)
def _record_logs(caplog: pytest.LogCaptureFixture) -> Any:
    with caplog.at_level(logging.INFO, logger=LOGGER_NAME):
        yield


@pytest.fixture
async def transport(outbound: FakeHttp) -> AsyncIterator[httpx.AsyncClient]:
    http = outbound.client()
    yield http
    await http.aclose()


# --- helpers --------------------------------------------------------------------


def openrouter_chat(
    http: httpx.AsyncClient, *, timeout: float = 5.0, model: str = AGENT_MODEL
) -> ChatGateway:
    return build_chat(
        http=http, provider="openrouter", model=model, api_key=API_KEY, timeout=timeout
    )


def anthropic_chat(http: httpx.AsyncClient, *, timeout: float = 5.0) -> ChatGateway:
    return build_chat(
        http=http,
        provider="anthropic",
        model=ANTHROPIC_MODEL,
        api_key=API_KEY,
        timeout=timeout,
    )


async def complete(gateway: ChatGateway) -> str:
    return await gateway.complete([ChatMessage(role="user", content=QUESTION)], max_tokens=100)


def replies(outbound: FakeHttp, fragment: str, *responses: Handler) -> None:
    """Answer the n-th call with the n-th handler; repeat the last one afterwards."""
    calls = iter(range(len(responses)))

    def handle(request: httpx.Request) -> httpx.Response:
        index = next(calls, len(responses) - 1)
        return responses[index](request)

    outbound.routes[("POST", fragment)] = handle


def failing(status: int, **headers: str) -> Handler:
    return lambda _request: httpx.Response(status, text=LEAKY_BODY, headers=headers)


def answering(payload: dict[str, Any]) -> Handler:
    return lambda _request: httpx.Response(200, json=payload)


def chat_calls(outbound: FakeHttp) -> list[httpx.Request]:
    return [request for request in outbound.requests if request.method == "POST"]


def records(caplog: pytest.LogCaptureFixture) -> list[dict[str, Any]]:
    """The technical log lines, parsed. Each record must be exactly one JSON line."""
    parsed = []
    for record in caplog.records:
        if record.name != LOGGER_NAME:
            continue
        message = record.getMessage()
        assert "\n" not in message, "a log record must stay on one line"
        payload = json.loads(message)
        assert isinstance(payload, dict)
        parsed.append(payload)
    return parsed


def assert_no_leak(text: str) -> None:
    for secret in LEAKS:
        assert secret not in text, text


def assert_logs_are_clean(caplog: pytest.LogCaptureFixture) -> None:
    for entry in records(caplog):
        assert_no_leak(json.dumps(entry, ensure_ascii=False))
        assert set(entry) <= {
            "operation",
            "provider",
            "model",
            "attempt",
            "elapsed_ms",
            "outcome",
            "status",
            "retrying",
            "usage",
        }, entry


# --- what is replayed, and what is not -------------------------------------------


@pytest.mark.parametrize("status", sorted(RETRY_STATUSES))
async def test_a_temporary_status_is_replayed_once_and_can_succeed(
    outbound: FakeHttp, transport: httpx.AsyncClient, status: int
) -> None:
    replies(
        outbound,
        "chat/completions",
        failing(status, **{"retry-after": "0"}),
        answering(chat_completion("Ответ модели")),
    )
    assert await complete(openrouter_chat(transport)) == "Ответ модели"
    assert len(chat_calls(outbound)) == 2


@pytest.mark.parametrize("status", sorted(RETRY_STATUSES))
async def test_a_second_temporary_failure_is_reported_and_never_replayed_again(
    outbound: FakeHttp, transport: httpx.AsyncClient, caplog: pytest.LogCaptureFixture, status: int
) -> None:
    replies(outbound, "chat/completions", failing(status, **{"retry-after": "0"}))
    with pytest.raises(ProviderError) as failure:
        await complete(openrouter_chat(transport))
    assert len(chat_calls(outbound)) == MAX_ATTEMPTS == 2
    message = str(failure.value)
    assert "openrouter" in message and str(status) in message
    assert_no_leak(message)
    assert_logs_are_clean(caplog)


@pytest.mark.parametrize("status", [400, 401, 402, 403, 404, 413, 415, 422, 418])
async def test_a_permanent_status_is_reported_after_one_attempt(
    outbound: FakeHttp, transport: httpx.AsyncClient, status: int
) -> None:
    replies(outbound, "chat/completions", failing(status))
    with pytest.raises(ProviderError):
        await complete(openrouter_chat(transport))
    assert len(chat_calls(outbound)) == 1


@pytest.mark.parametrize("status", [408, 409, 425, 500, 522, 524])
async def test_an_ambiguous_status_is_worded_as_temporary_but_still_not_replayed(
    outbound: FakeHttp, transport: httpx.AsyncClient, status: int
) -> None:
    """These say nothing about whether the request was served, so a replay could charge twice."""
    assert is_retryable_http_status(status), "the wording of these stays 'try again'"
    replies(outbound, "chat/completions", failing(status, **{"retry-after": "0"}))
    with pytest.raises(ProviderError):
        await complete(openrouter_chat(transport))
    assert len(chat_calls(outbound)) == 1


@pytest.mark.parametrize(
    "error",
    [
        httpx.ConnectError("connection refused to https://secret-host.internal/v1?key=sk-live-9f3"),
        httpx.RemoteProtocolError("peer closed while sending sk-live-9f3"),
        httpx.TooManyRedirects("redirect loop via https://secret-host.internal"),
    ],
)
async def test_a_transport_failure_is_never_replayed(
    outbound: FakeHttp, transport: httpx.AsyncClient, error: Exception
) -> None:
    def fail(_request: httpx.Request) -> httpx.Response:
        raise error

    outbound.routes[("POST", "chat/completions")] = fail
    with pytest.raises(ProviderError):
        await complete(openrouter_chat(transport))
    assert len(chat_calls(outbound)) == 1


async def test_a_timeout_is_never_replayed(outbound: FakeHttp, transport: httpx.AsyncClient) -> None:
    """The provider may have answered a request we stopped waiting for."""

    def timeout(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("timed out talking to sk-live-9f3", request=request)

    outbound.routes[("POST", "chat/completions")] = timeout
    with pytest.raises(ProviderTimeout):
        await complete(openrouter_chat(transport))
    assert len(chat_calls(outbound)) == 1


@pytest.mark.parametrize(
    "payload",
    [{}, {"choices": []}, {"choices": [{"message": {"content": "   "}}]}, {"error": {"code": 7}}],
)
async def test_a_malformed_successful_reply_is_never_replayed(
    outbound: FakeHttp, transport: httpx.AsyncClient, payload: dict[str, Any]
) -> None:
    outbound.json_route("POST", "chat/completions", payload)
    with pytest.raises(ProviderError):
        await complete(openrouter_chat(transport))
    assert len(chat_calls(outbound)) == 1


async def test_the_replay_repeats_the_same_provider_model_and_body(
    outbound: FakeHttp, transport: httpx.AsyncClient
) -> None:
    """No hidden fallback: a retry is the same request, not a cheaper model."""
    replies(
        outbound,
        "chat/completions",
        failing(503, **{"retry-after": "0"}),
        answering(chat_completion("Ответ")),
    )
    await complete(openrouter_chat(transport))
    first, second = chat_calls(outbound)
    assert first.url == second.url
    assert dict(first.headers) == dict(second.headers)
    assert outbound.bodies[-2] == outbound.bodies[-1]
    assert outbound.bodies[-1]["model"] == AGENT_MODEL


# --- Retry-After and the shared deadline -----------------------------------------


async def test_a_numeric_retry_after_is_waited_out_before_the_replay(
    outbound: FakeHttp, transport: httpx.AsyncClient
) -> None:
    replies(
        outbound,
        "chat/completions",
        failing(429, **{"retry-after": "0.2"}),
        answering(chat_completion("Ответ")),
    )
    started = time.monotonic()
    assert await complete(openrouter_chat(transport)) == "Ответ"
    assert time.monotonic() - started >= 0.2
    assert len(chat_calls(outbound)) == 2


async def test_without_a_retry_after_a_short_default_wait_is_used(
    outbound: FakeHttp, transport: httpx.AsyncClient
) -> None:
    replies(
        outbound,
        "chat/completions",
        failing(503),
        answering(chat_completion("Ответ")),
    )
    started = time.monotonic()
    assert await complete(openrouter_chat(transport)) == "Ответ"
    assert 0.25 <= time.monotonic() - started < 5.0
    assert len(chat_calls(outbound)) == 2


@pytest.mark.parametrize(
    "retry_after",
    ["Wed, 21 Oct 2015 07:28:00 GMT", "soon", "", "-1", "1,5", "nan", "inf"],
)
async def test_a_retry_after_that_is_not_a_plain_number_stops_the_retry(
    outbound: FakeHttp, transport: httpx.AsyncClient, retry_after: str
) -> None:
    replies(outbound, "chat/completions", failing(503, **{"retry-after": retry_after}))
    with pytest.raises(ProviderError):
        await complete(openrouter_chat(transport))
    assert len(chat_calls(outbound)) == 1


async def test_a_server_delay_longer_than_the_budget_skips_the_retry(
    outbound: FakeHttp, transport: httpx.AsyncClient
) -> None:
    replies(outbound, "chat/completions", failing(429, **{"retry-after": "120"}))
    started = time.monotonic()
    with pytest.raises(ProviderError) as failure:
        await complete(openrouter_chat(transport, timeout=5.0))
    assert time.monotonic() - started < 1.0, "the wait must not happen at all"
    assert len(chat_calls(outbound)) == 1
    assert "429" in str(failure.value)


async def test_a_budget_too_short_for_the_default_wait_skips_the_retry(
    outbound: FakeHttp, transport: httpx.AsyncClient
) -> None:
    replies(outbound, "chat/completions", failing(503))
    started = time.monotonic()
    with pytest.raises(ProviderError):
        await complete(openrouter_chat(transport, timeout=0.05))
    assert time.monotonic() - started < 0.5
    assert len(chat_calls(outbound)) == 1


async def test_the_deadline_is_shared_by_the_two_attempts_and_the_wait(
    outbound: FakeHttp, transport: httpx.AsyncClient
) -> None:
    """The second attempt inherits what is left of the budget, it does not restart it."""
    replies(
        outbound,
        "chat/completions",
        failing(503, **{"retry-after": "0.3"}),
        answering(chat_completion("Ответ")),
    )
    await complete(openrouter_chat(transport, timeout=5.0))
    first, second = (
        float(request.extensions["timeout"]["read"]) for request in chat_calls(outbound)
    )
    assert first <= 5.0
    assert second <= 5.0 - 0.3
    assert second < first


# --- cancellation ----------------------------------------------------------------


async def test_cancelling_during_the_wait_stops_the_replay(
    outbound: FakeHttp, transport: httpx.AsyncClient
) -> None:
    asked = asyncio.Event()

    def refuse(_request: httpx.Request) -> httpx.Response:
        asked.set()
        return httpx.Response(429, headers={"retry-after": "5"})

    outbound.routes[("POST", "chat/completions")] = refuse
    task = asyncio.ensure_future(complete(openrouter_chat(transport, timeout=30.0)))
    await asked.wait()
    await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert len(chat_calls(outbound)) == 1


async def test_cancellation_from_the_transport_is_not_turned_into_a_provider_error(
    outbound: FakeHttp, transport: httpx.AsyncClient
) -> None:
    def cancel(_request: httpx.Request) -> httpx.Response:
        raise asyncio.CancelledError

    outbound.routes[("POST", "chat/completions")] = cancel
    with pytest.raises(asyncio.CancelledError):
        await complete(openrouter_chat(transport))
    assert len(chat_calls(outbound)) == 1


# --- the technical log line ------------------------------------------------------


async def test_a_successful_call_logs_the_operation_provider_model_and_outcome(
    outbound: FakeHttp, transport: httpx.AsyncClient, caplog: pytest.LogCaptureFixture
) -> None:
    outbound.json_route("POST", "chat/completions", chat_completion("Ответ модели"))
    await complete(openrouter_chat(transport))
    (entry,) = records(caplog)
    assert entry["operation"] == OPERATION
    assert entry["provider"] == "openrouter"
    assert entry["model"] == AGENT_MODEL
    assert entry["attempt"] == 1
    assert entry["outcome"] == "ok"
    assert entry["status"] == 200
    assert isinstance(entry["elapsed_ms"], int) and entry["elapsed_ms"] >= 0
    assert_logs_are_clean(caplog)


async def test_each_attempt_is_logged_with_its_number_and_status(
    outbound: FakeHttp, transport: httpx.AsyncClient, caplog: pytest.LogCaptureFixture
) -> None:
    replies(
        outbound,
        "chat/completions",
        failing(503, **{"retry-after": "0"}),
        answering(chat_completion("Ответ")),
    )
    await complete(openrouter_chat(transport))
    first, second = records(caplog)
    assert (first["attempt"], first["status"], first["outcome"]) == (1, 503, "http_error")
    assert first["retrying"] is True
    assert (second["attempt"], second["status"], second["outcome"]) == (2, 200, "ok")
    assert "retrying" not in second
    assert_logs_are_clean(caplog)


async def test_a_final_failure_is_logged_without_a_further_attempt_marker(
    outbound: FakeHttp, transport: httpx.AsyncClient, caplog: pytest.LogCaptureFixture
) -> None:
    replies(outbound, "chat/completions", failing(429, **{"retry-after": "0"}))
    with pytest.raises(ProviderError):
        await complete(openrouter_chat(transport))
    first, second = records(caplog)
    assert first["retrying"] is True
    assert (second["attempt"], second["outcome"]) == (2, "http_error")
    assert "retrying" not in second


@pytest.mark.parametrize(
    ("handler", "outcome"),
    [
        (lambda _r: httpx.Response(200, text=LEAKY_BODY), "invalid_response"),
        (lambda _r: httpx.Response(200, json={"choices": []}), "invalid_response"),
        (lambda _r: httpx.Response(401, text=LEAKY_BODY), "http_error"),
    ],
)
async def test_failure_outcomes_are_named_without_the_body(
    outbound: FakeHttp,
    transport: httpx.AsyncClient,
    caplog: pytest.LogCaptureFixture,
    handler: Handler,
    outcome: str,
) -> None:
    outbound.routes[("POST", "chat/completions")] = handler
    with pytest.raises(ProviderError):
        await complete(openrouter_chat(transport))
    (entry,) = records(caplog)
    assert entry["outcome"] == outcome
    assert_logs_are_clean(caplog)


async def test_a_transport_failure_is_logged_without_the_exception_text(
    outbound: FakeHttp, transport: httpx.AsyncClient, caplog: pytest.LogCaptureFixture
) -> None:
    def fail(_request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route to https://openrouter.ai/api/v1?key=sk-live-9f3TOPSECRET")

    outbound.routes[("POST", "chat/completions")] = fail
    with pytest.raises(ProviderError):
        await complete(openrouter_chat(transport))
    (entry,) = records(caplog)
    assert entry["outcome"] == "transport_error"
    assert "status" not in entry
    assert_logs_are_clean(caplog)


async def test_a_timeout_is_logged_as_its_own_outcome(
    outbound: FakeHttp, transport: httpx.AsyncClient, caplog: pytest.LogCaptureFixture
) -> None:
    def timeout(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("timed out on sk-live-9f3TOPSECRET", request=request)

    outbound.routes[("POST", "chat/completions")] = timeout
    with pytest.raises(ProviderTimeout):
        await complete(openrouter_chat(transport))
    (entry,) = records(caplog)
    assert entry["outcome"] == "timeout"
    assert_logs_are_clean(caplog)


async def test_a_model_id_with_a_newline_cannot_forge_a_second_record(
    outbound: FakeHttp, transport: httpx.AsyncClient, caplog: pytest.LogCaptureFixture
) -> None:
    hostile = 'evil/model\n{"operation": "forged", "outcome": "ok"}\r"quote"'
    outbound.json_route("POST", "chat/completions", chat_completion("Ответ"))
    await complete(openrouter_chat(transport, model=hostile))
    (entry,) = records(caplog)  # asserts the single line
    assert entry["model"] == hostile, "the exact model ID survives escaping"
    assert entry["operation"] == OPERATION


async def test_only_numeric_token_counters_are_logged_from_usage(
    outbound: FakeHttp, transport: httpx.AsyncClient, caplog: pytest.LogCaptureFixture
) -> None:
    payload = chat_completion("Ответ")
    payload["usage"] = {
        "prompt_tokens": 120,
        "completion_tokens": 34,
        "total_tokens": 154,
        "cost": "0.0004 USD",
        "prompt": QUESTION,
        "id": API_KEY,
        "cached": True,
        "refund_tokens": -5,
        "details": {"reasoning_tokens": 9},
    }
    outbound.json_route("POST", "chat/completions", payload)
    await complete(openrouter_chat(transport))
    (entry,) = records(caplog)
    assert entry["usage"] == {"input_tokens": 120, "output_tokens": 34, "total_tokens": 154}
    assert_logs_are_clean(caplog)


@pytest.mark.parametrize(
    "usage",
    ["unavailable", None, [], {"prompt_tokens": "many"}, {"prompt_tokens": True}, {}],
)
async def test_an_unusable_usage_object_is_dropped_entirely(
    outbound: FakeHttp, transport: httpx.AsyncClient, caplog: pytest.LogCaptureFixture, usage: Any
) -> None:
    payload = chat_completion("Ответ")
    payload["usage"] = usage
    outbound.json_route("POST", "chat/completions", payload)
    await complete(openrouter_chat(transport))
    (entry,) = records(caplog)
    assert "usage" not in entry


# --- the Anthropic gateway follows the same policy --------------------------------


async def test_anthropic_replays_a_temporary_status_once_with_the_same_body(
    outbound: FakeHttp, transport: httpx.AsyncClient, caplog: pytest.LogCaptureFixture
) -> None:
    replies(
        outbound,
        "api.anthropic.com",
        failing(529, **{"retry-after": "0"}),
        answering({"content": [{"type": "text", "text": "Ответ"}], "usage": {"input_tokens": 11}}),
    )
    assert await complete(anthropic_chat(transport)) == "Ответ"
    calls = chat_calls(outbound)
    assert len(calls) == 2
    assert calls[0].url == calls[1].url
    assert outbound.bodies[-2] == outbound.bodies[-1]
    assert outbound.bodies[-1]["model"] == ANTHROPIC_MODEL
    first, second = records(caplog)
    assert (first["provider"], first["model"], first["status"]) == ("anthropic", ANTHROPIC_MODEL, 529)
    assert second["usage"] == {"input_tokens": 11}
    assert_logs_are_clean(caplog)


@pytest.mark.parametrize("status", [401, 404, 500])
async def test_anthropic_does_not_replay_permanent_or_ambiguous_statuses(
    outbound: FakeHttp, transport: httpx.AsyncClient, status: int
) -> None:
    replies(outbound, "api.anthropic.com", failing(status, **{"retry-after": "0"}))
    with pytest.raises(ProviderError):
        await complete(anthropic_chat(transport))
    assert len(chat_calls(outbound)) == 1


async def test_anthropic_does_not_replay_a_malformed_successful_reply(
    outbound: FakeHttp, transport: httpx.AsyncClient, caplog: pytest.LogCaptureFixture
) -> None:
    outbound.json_route("POST", "api.anthropic.com", {"content": "text"})
    with pytest.raises(ProviderError):
        await complete(anthropic_chat(transport))
    assert len(chat_calls(outbound)) == 1
    (entry,) = records(caplog)
    assert entry["outcome"] == "invalid_response"


async def test_anthropic_output_tokens_are_logged_as_numbers_only(
    outbound: FakeHttp, transport: httpx.AsyncClient, caplog: pytest.LogCaptureFixture
) -> None:
    outbound.json_route(
        "POST",
        "api.anthropic.com",
        {
            "content": [{"type": "text", "text": "Ответ"}],
            "usage": {"input_tokens": 7, "output_tokens": 3, "server_tool_use": {"web": 1}},
        },
    )
    await complete(anthropic_chat(transport))
    (entry,) = records(caplog)
    assert entry["usage"] == {"input_tokens": 7, "output_tokens": 3}
    assert_logs_are_clean(caplog)


# --- as the user sees it, through the public API ----------------------------------


async def prepared_session(client: httpx.AsyncClient, outbound: FakeHttp) -> str:
    configured = await client.put(
        "/settings",
        json={"provider_keys": {"openrouter": "sk-test"}, "asr": {"provider": "openrouter", "model": ASR_MODEL},
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


async def test_ask_recovers_from_one_rate_limit(
    client: httpx.AsyncClient, outbound: FakeHttp, caplog: pytest.LogCaptureFixture
) -> None:
    session = await prepared_session(client, outbound)
    replies(
        outbound,
        "chat/completions",
        failing(429, **{"retry-after": "0"}),
        answering(chat_completion("Про энтропию [S1].")),
    )
    response = await client.post(f"/sessions/{session}/ask", json={"question": QUESTION})
    assert response.status_code == 200, response.text
    assert "энтропию" in response.json()["answer"]
    assert_logs_are_clean(caplog)


async def test_notes_still_report_a_provider_that_stays_unavailable(
    client: httpx.AsyncClient, outbound: FakeHttp, caplog: pytest.LogCaptureFixture
) -> None:
    session = await prepared_session(client, outbound)
    before = len(chat_calls(outbound))
    replies(outbound, "chat/completions", failing(503, **{"retry-after": "0"}))
    response = await client.post(f"/sessions/{session}/notes", json={})
    assert response.status_code == 502, response.text
    detail = response.json()["detail"]
    assert "503" in detail and "try again" in detail.lower()
    assert_no_leak(detail)
    assert len(chat_calls(outbound)) - before == MAX_ATTEMPTS
    assert_logs_are_clean(caplog)


async def test_ask_reports_a_rejected_key_after_a_single_attempt(
    client: httpx.AsyncClient, outbound: FakeHttp
) -> None:
    session = await prepared_session(client, outbound)
    before = len(chat_calls(outbound))
    replies(outbound, "chat/completions", failing(401))
    response = await client.post(f"/sessions/{session}/ask", json={"question": QUESTION})
    assert response.status_code == 502, response.text
    detail = response.json()["detail"]
    assert "401" in detail and "api key" in detail.lower()
    assert len(chat_calls(outbound)) - before == 1, "a rejected key is never retried"
