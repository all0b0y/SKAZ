"""The technical activity log, as the desktop status strip reads it.

Everything is driven through the public HTTP API: settings are configured, audio
is ingested, questions are asked, and the resulting records are read back from
``GET /logs``. The provider side is an injected ``httpx`` transport, so the
production request path produces the records under test.

Three properties are checked everywhere:

* a record names only technical facts — operation, provider, exact model ID,
  attempt, elapsed, status, outcome, whitelisted token counts and a timestamp;
* it never carries transcript text, a question, an answer, a request or response
  body, a header, a URL, an API key or the text of an exception;
* the store is per-installation and bounded: the oldest record is dropped, never
  the newest, and it can never grow without limit.
"""

from __future__ import annotations

import asyncio
import sys
from collections.abc import AsyncIterator, Callable, Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest

from audiohelper.app import create_app
from audiohelper.config import AppConfig
from audiohelper.secrets import MemorySecretStore
from tests.conftest import TOKEN, FakeHttp, chat_completion, make_wav

AGENT_MODEL = "qwen/qwen3-30b-a3b-instruct-2507"
# Public log labels, not imports from gateway implementation details.
ASR_OPERATION = "provider audio transcription"
CHAT_OPERATION = "provider text completion"
ASR_MODEL = "qwen/qwen3-asr-1.7b"
API_KEY = "sk-live-9f3TOPSECRET"
QUESTION = "Что решили по бюджету на секретном совещании?"
TRANSCRIPT = "Мы определили энтропию как меру беспорядка."

#: Everything a record must never repeat, whatever the provider sent.
LEAKY_BODY = (
    '{"error": {"message": "key sk-live-9f3TOPSECRET rejected for Ivan Petrov; '
    'prompt was: секретное совещание про увольнения"}}'
)
LEAKS = (
    API_KEY,
    "Ivan Petrov",
    "секретное совещание",
    QUESTION,
    TRANSCRIPT,
    "энтропи",
    "openrouter.ai",
    "audio/transcriptions",
    "Authorization",
    "Bearer",
    TOKEN,
)

#: The complete record shape. Equality, not containment: a new field must be a
#: deliberate decision, never something that slipped in with a payload.
RECORD_FIELDS = {
    "sequence",
    "at_ms",
    "operation",
    "provider",
    "model",
    "attempt",
    "elapsed_ms",
    "outcome",
    "status",
    "retrying",
    "usage",
}

CATALOG = {
    "data": [
        {
            "id": ASR_MODEL,
            "architecture": {"input_modalities": ["audio"], "output_modalities": ["transcription"]},
        },
        {
            "id": AGENT_MODEL,
            "architecture": {"input_modalities": ["text"], "output_modalities": ["text"]},
        },
    ]
}

TINY_CAPACITY = 4

Handler = Callable[[httpx.Request], httpx.Response]


# --- fixtures and helpers ---------------------------------------------------------


@pytest.fixture(autouse=True)
def _catalog(outbound: FakeHttp) -> None:
    outbound.json_route("GET", "openrouter.ai/api/v1/models", CATALOG)


def build_client(config: AppConfig, outbound: FakeHttp, secrets: MemorySecretStore) -> Any:
    return create_app(config, secret_store=secrets, http_client=outbound.client())


def open_client(app: Any) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://127.0.0.1:8765",
        headers={"Authorization": f"Bearer {TOKEN}"},
    )


@pytest.fixture
def tiny_app(tmp_path: Path, outbound: FakeHttp, secrets: MemorySecretStore) -> Iterator[Any]:
    """A second installation whose activity log holds only a handful of records."""
    config = AppConfig(
        token=TOKEN,
        data_dir=tmp_path / "tiny",
        request_timeout_s=5.0,
        activity_log_capacity=TINY_CAPACITY,
    )
    application = build_client(config, outbound, secrets)
    yield application
    application.state.runtime.close()


@pytest.fixture
async def tiny_client(tiny_app: Any) -> AsyncIterator[httpx.AsyncClient]:
    async with open_client(tiny_app) as http:
        yield http


@pytest.fixture
def other_app(tmp_path: Path, outbound: FakeHttp, secrets: MemorySecretStore) -> Iterator[Any]:
    config = AppConfig(token=TOKEN, data_dir=tmp_path / "other", request_timeout_s=5.0)
    application = build_client(config, outbound, secrets)
    yield application
    application.state.runtime.close()


@pytest.fixture
async def other_client(other_app: Any) -> AsyncIterator[httpx.AsyncClient]:
    async with open_client(other_app) as http:
        yield http


def transcription(text: str, usage: Any = None) -> dict[str, Any]:
    payload: dict[str, Any] = {"text": text}
    if usage is not None:
        payload["usage"] = usage
    return payload


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


async def configure(client: httpx.AsyncClient) -> None:
    response = await client.put(
        "/settings",
        json={"provider_keys": {"openrouter": API_KEY}, "asr": {"provider": "openrouter", "model": ASR_MODEL},
            "agent": {"provider": "openrouter", "model": AGENT_MODEL},
            "notes": {"provider": "openrouter", "model": AGENT_MODEL},
            "cloud_consent": True,
        },
    )
    assert response.status_code == 200, response.text


async def start_session(client: httpx.AsyncClient, title: str = "Лекция") -> str:
    created = await client.post("/sessions", json={"title": title})
    assert created.status_code == 200, created.text
    return str(created.json()["id"])


async def upload(client: httpx.AsyncClient, session: str, sequence: int = 0) -> httpx.Response:
    return await client.post(
        f"/sessions/{session}/audio",
        params={"sequence": sequence, "start_ms": sequence * 30_000, "end_ms": (sequence + 1) * 30_000},
        content=make_wav(1.0),
        headers={"Content-Type": "audio/wav"},
    )


async def logs(client: httpx.AsyncClient, **params: Any) -> dict[str, Any]:
    response = await client.get("/logs", params=params)
    assert response.status_code == 200, response.text
    payload: dict[str, Any] = response.json()
    assert_no_leak(response.text)
    for entry in payload["entries"]:
        assert set(entry) == RECORD_FIELDS, entry
    return payload


def entries(payload: dict[str, Any]) -> list[dict[str, Any]]:
    listed: list[dict[str, Any]] = payload["entries"]
    return listed


def assert_no_leak(text: str) -> None:
    for secret in LEAKS:
        assert secret not in text, f"{secret!r} leaked into {text}"


def assert_shape(entry: dict[str, Any]) -> None:
    assert isinstance(entry["sequence"], int) and entry["sequence"] >= 1
    assert isinstance(entry["at_ms"], int) and entry["at_ms"] > 0
    assert isinstance(entry["attempt"], int) and entry["attempt"] >= 1
    assert isinstance(entry["elapsed_ms"], int) and entry["elapsed_ms"] >= 0
    assert isinstance(entry["outcome"], str) and entry["outcome"]
    assert isinstance(entry["retrying"], bool)
    assert entry["status"] is None or isinstance(entry["status"], int)
    assert all(isinstance(value, int) and not isinstance(value, bool) for value in entry["usage"].values())


# --- an empty installation ---------------------------------------------------------


async def test_a_fresh_installation_reports_no_activity(client: httpx.AsyncClient) -> None:
    payload = await logs(client)
    assert entries(payload) == []
    assert payload["dropped"] == 0
    assert payload["capacity"] >= 1


async def test_the_log_requires_the_local_token(app: Any) -> None:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8765"
    ) as anonymous:
        response = await anonymous.get("/logs")
    assert response.status_code == 401


# --- chat attempts ------------------------------------------------------------------


async def test_a_chat_answer_is_recorded_with_the_exact_model_id(
    client: httpx.AsyncClient, outbound: FakeHttp
) -> None:
    await configure(client)
    session = await start_session(client)
    outbound.json_route("POST", "audio/transcriptions", transcription(TRANSCRIPT))
    assert (await upload(client, session)).status_code == 200
    outbound.json_route(
        "POST",
        "chat/completions",
        chat_completion("Про энтропию [S1].") | {"usage": {"prompt_tokens": 120, "completion_tokens": 34}},
    )
    answered = await client.post(f"/sessions/{session}/ask", json={"question": QUESTION})
    assert answered.status_code == 200, answered.text

    recorded = entries(await logs(client))
    chat = [entry for entry in recorded if entry["operation"] == CHAT_OPERATION]
    assert len(chat) == 1
    assert_shape(chat[0])
    assert chat[0]["provider"] == "openrouter"
    assert chat[0]["model"] == AGENT_MODEL
    assert chat[0]["attempt"] == 1
    assert chat[0]["outcome"] == "ok"
    assert chat[0]["status"] == 200
    assert chat[0]["retrying"] is False
    assert chat[0]["usage"] == {"input_tokens": 120, "output_tokens": 34}


async def test_both_attempts_of_a_retried_chat_request_are_recorded(
    client: httpx.AsyncClient, outbound: FakeHttp
) -> None:
    await configure(client)
    session = await start_session(client)
    outbound.json_route("POST", "audio/transcriptions", transcription(TRANSCRIPT))
    assert (await upload(client, session)).status_code == 200
    replies(
        outbound,
        "chat/completions",
        failing(429, **{"retry-after": "0"}),
        answering(chat_completion("Про энтропию [S1].")),
    )
    answered = await client.post(f"/sessions/{session}/ask", json={"question": QUESTION})
    assert answered.status_code == 200, answered.text

    chat = [entry for entry in entries(await logs(client)) if entry["operation"] == CHAT_OPERATION]
    newest, oldest = chat
    assert (oldest["attempt"], oldest["status"], oldest["outcome"]) == (1, 429, "http_error")
    assert oldest["retrying"] is True
    assert (newest["attempt"], newest["status"], newest["outcome"]) == (2, 200, "ok")
    assert newest["retrying"] is False


async def test_a_rejected_key_is_recorded_without_the_provider_body(
    client: httpx.AsyncClient, outbound: FakeHttp
) -> None:
    await configure(client)
    session = await start_session(client)
    outbound.json_route("POST", "audio/transcriptions", transcription(TRANSCRIPT))
    assert (await upload(client, session)).status_code == 200
    replies(outbound, "chat/completions", failing(401))
    refused = await client.post(f"/sessions/{session}/ask", json={"question": QUESTION})
    assert refused.status_code == 502, refused.text

    chat = [entry for entry in entries(await logs(client)) if entry["operation"] == CHAT_OPERATION]
    assert len(chat) == 1
    assert (chat[0]["outcome"], chat[0]["status"], chat[0]["attempt"]) == ("http_error", 401, 1)


async def test_a_chat_transport_failure_is_recorded_without_the_exception_text(
    client: httpx.AsyncClient, outbound: FakeHttp
) -> None:
    await configure(client)
    session = await start_session(client)
    outbound.json_route("POST", "audio/transcriptions", transcription(TRANSCRIPT))
    assert (await upload(client, session)).status_code == 200

    def fail(_request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError(f"no route to https://openrouter.ai/api/v1?key={API_KEY}")

    outbound.routes[("POST", "chat/completions")] = fail
    refused = await client.post(f"/sessions/{session}/ask", json={"question": QUESTION})
    assert refused.status_code == 502, refused.text

    chat = [entry for entry in entries(await logs(client)) if entry["operation"] == CHAT_OPERATION]
    assert chat[0]["outcome"] == "transport_error"
    assert chat[0]["status"] is None


# --- transcription attempts ---------------------------------------------------------


async def test_a_transcription_attempt_is_recorded_in_the_same_shape(
    client: httpx.AsyncClient, outbound: FakeHttp
) -> None:
    await configure(client)
    session = await start_session(client)
    outbound.json_route(
        "POST",
        "audio/transcriptions",
        transcription(
            TRANSCRIPT,
            usage={"type": "tokens", "input_tokens": 14, "output_tokens": 45, "total_tokens": 59},
        ),
    )
    assert (await upload(client, session)).status_code == 200

    recorded = entries(await logs(client))
    asr = [entry for entry in recorded if entry["operation"] == ASR_OPERATION]
    assert len(asr) == 1
    assert_shape(asr[0])
    assert asr[0]["provider"] == "openrouter"
    assert asr[0]["model"] == ASR_MODEL
    assert asr[0]["attempt"] == 1
    assert asr[0]["outcome"] == "ok"
    assert asr[0]["status"] == 200
    assert asr[0]["usage"] == {"input_tokens": 14, "output_tokens": 45, "total_tokens": 59}


async def test_a_failed_transcription_is_recorded_with_its_status(
    client: httpx.AsyncClient, outbound: FakeHttp
) -> None:
    await configure(client)
    session = await start_session(client)
    replies(outbound, "audio/transcriptions", failing(402))
    refused = await upload(client, session)
    assert refused.status_code == 502, refused.text

    asr = [entry for entry in entries(await logs(client)) if entry["operation"] == ASR_OPERATION]
    assert len(asr) == 1, "a transcription is attempted once; there is no ASR retry policy"
    assert (asr[0]["outcome"], asr[0]["status"], asr[0]["attempt"]) == ("http_error", 402, 1)


async def test_a_transcription_transport_failure_is_recorded_without_the_url(
    client: httpx.AsyncClient, outbound: FakeHttp
) -> None:
    await configure(client)
    session = await start_session(client)

    def fail(_request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError(f"no route to https://openrouter.ai/api/v1?key={API_KEY}")

    outbound.routes[("POST", "audio/transcriptions")] = fail
    refused = await upload(client, session)
    assert refused.status_code == 502, refused.text

    asr = [entry for entry in entries(await logs(client)) if entry["operation"] == ASR_OPERATION]
    assert asr[0]["outcome"] == "transport_error"
    assert asr[0]["status"] is None


async def test_a_malformed_transcription_reply_is_recorded_as_an_invalid_response(
    client: httpx.AsyncClient, outbound: FakeHttp
) -> None:
    await configure(client)
    session = await start_session(client)
    outbound.routes[("POST", "audio/transcriptions")] = lambda _r: httpx.Response(200, text=LEAKY_BODY)
    refused = await upload(client, session)
    assert refused.status_code == 502, refused.text

    asr = [entry for entry in entries(await logs(client)) if entry["operation"] == ASR_OPERATION]
    assert (asr[0]["outcome"], asr[0]["status"]) == ("invalid_response", 200)


async def test_a_local_transcription_without_its_dependency_is_recorded(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The default local profile still produces one honest attempt record."""
    # Model availability on the developer machine must not turn this into inference.
    monkeypatch.setitem(sys.modules, "numpy", None)
    session = await start_session(client)
    refused = await upload(client, session)
    assert refused.status_code == 400, refused.text

    asr = [entry for entry in entries(await logs(client)) if entry["operation"] == ASR_OPERATION]
    assert len(asr) == 1
    assert asr[0]["provider"] == "local-whisper"
    assert asr[0]["model"] == "small"
    assert asr[0]["outcome"] == "not_configured"
    assert asr[0]["status"] is None
    assert_no_leak(refused.text)


# --- ordering, bounds and isolation --------------------------------------------------


async def test_records_are_returned_newest_first(client: httpx.AsyncClient, outbound: FakeHttp) -> None:
    await configure(client)
    session = await start_session(client)
    outbound.json_route("POST", "audio/transcriptions", transcription(TRANSCRIPT))
    for sequence in range(3):
        assert (await upload(client, session, sequence)).status_code == 200

    recorded = entries(await logs(client))
    sequences = [entry["sequence"] for entry in recorded]
    assert sequences == sorted(sequences, reverse=True)
    assert len(set(sequences)) == len(sequences)
    stamps = [entry["at_ms"] for entry in recorded]
    assert stamps == sorted(stamps, reverse=True), "a timestamp must never move backwards"


async def test_the_store_drops_the_oldest_records_and_never_grows(
    tiny_client: httpx.AsyncClient, outbound: FakeHttp
) -> None:
    await configure(tiny_client)
    session = await start_session(tiny_client)
    outbound.json_route("POST", "audio/transcriptions", transcription(TRANSCRIPT))
    total = TINY_CAPACITY * 3
    for sequence in range(total):
        assert (await upload(tiny_client, session, sequence)).status_code == 200

    payload = await logs(tiny_client, limit=100)
    recorded = entries(payload)
    assert len(recorded) == TINY_CAPACITY == payload["capacity"]
    assert payload["dropped"] == total - TINY_CAPACITY
    assert [entry["sequence"] for entry in recorded] == list(range(total, total - TINY_CAPACITY, -1))


async def test_a_limit_returns_only_the_newest_records(
    client: httpx.AsyncClient, outbound: FakeHttp
) -> None:
    await configure(client)
    session = await start_session(client)
    outbound.json_route("POST", "audio/transcriptions", transcription(TRANSCRIPT))
    for sequence in range(3):
        assert (await upload(client, session, sequence)).status_code == 200

    everything = entries(await logs(client))
    newest = entries(await logs(client, limit=1))
    assert len(newest) == 1
    assert newest[0] == everything[0]


@pytest.mark.parametrize("limit", [0, -1, "many"])
async def test_an_unusable_limit_is_rejected(client: httpx.AsyncClient, limit: Any) -> None:
    response = await client.get("/logs", params={"limit": limit})
    assert response.status_code == 422


async def test_one_installation_never_sees_another_installations_activity(
    client: httpx.AsyncClient, other_client: httpx.AsyncClient, outbound: FakeHttp
) -> None:
    await configure(client)
    session = await start_session(client)
    outbound.json_route("POST", "audio/transcriptions", transcription(TRANSCRIPT))
    assert (await upload(client, session)).status_code == 200

    assert entries(await logs(client)) != []
    assert entries(await logs(other_client)) == []


async def test_concurrent_sessions_each_record_their_own_attempt(
    client: httpx.AsyncClient, outbound: FakeHttp
) -> None:
    await configure(client)
    outbound.json_route("POST", "audio/transcriptions", transcription(TRANSCRIPT))
    sessions = [await start_session(client, f"Сессия {index}") for index in range(6)]

    results = await asyncio.gather(*(upload(client, session) for session in sessions))
    assert [response.status_code for response in results] == [200] * len(sessions)

    recorded = entries(await logs(client, limit=100))
    asr = [entry for entry in recorded if entry["operation"] == ASR_OPERATION]
    assert len(asr) == len(sessions), "no attempt is lost when sessions run concurrently"
    assert len({entry["sequence"] for entry in recorded}) == len(recorded), "no sequence is reused"


async def test_a_hostile_model_id_is_stored_verbatim_and_stays_one_record(
    client: httpx.AsyncClient, outbound: FakeHttp
) -> None:
    hostile = 'evil/model\n{"operation": "forged", "outcome": "ok"}\r"quote"'
    await configure(client)
    session = await start_session(client)
    outbound.json_route("POST", "audio/transcriptions", transcription(TRANSCRIPT))
    assert (await upload(client, session)).status_code == 200
    configured = await client.put("/settings", json={"agent": {"model": hostile}})
    assert configured.status_code == 200, configured.text
    outbound.json_route("POST", "chat/completions", chat_completion("Ответ."))
    answered = await client.post(f"/sessions/{session}/ask", json={"question": QUESTION})
    assert answered.status_code == 200, answered.text

    chat = [entry for entry in entries(await logs(client)) if entry["operation"] == CHAT_OPERATION]
    assert len(chat) == 1, "a model ID cannot forge a second record"
    assert chat[0]["model"] == hostile, "the exact model ID survives"


async def test_usage_cannot_smuggle_payloads_into_the_log(
    client: httpx.AsyncClient, outbound: FakeHttp
) -> None:
    await configure(client)
    session = await start_session(client)
    outbound.json_route("POST", "audio/transcriptions", transcription(TRANSCRIPT, usage={
        "input_tokens": True, "output_tokens": -1, "total_tokens": 7,
        "prompt": QUESTION, "secret": API_KEY, "details": {"text": TRANSCRIPT},
    }))
    assert (await upload(client, session)).status_code == 200
    (entry,) = entries(await logs(client))
    assert entry["usage"] == {"total_tokens": 7}


async def test_concurrent_installations_keep_independent_logs(
    client: httpx.AsyncClient, other_client: httpx.AsyncClient, outbound: FakeHttp
) -> None:
    await configure(client)
    await configure(other_client)
    session = await start_session(client)
    other = await start_session(other_client)
    outbound.json_route("POST", "audio/transcriptions", transcription(TRANSCRIPT))
    responses = await asyncio.gather(upload(client, session), upload(other_client, other))
    assert [response.status_code for response in responses] == [200, 200]
    for installation in (client, other_client):
        (entry,) = entries(await logs(installation))
        assert entry["sequence"] == 1


async def test_the_openai_asr_adapter_also_rejects_error_payloads_without_leaking(
    client: httpx.AsyncClient, outbound: FakeHttp
) -> None:
    provider = "openai"
    configured = await client.put("/settings", json={
        "provider_keys": {provider: API_KEY},
        "asr": {"provider": provider, "model": "whisper-1"},
        "cloud_consent": True,
    })
    assert configured.status_code == 200
    session = await start_session(client)
    outbound.routes[("POST", "audio/transcriptions")] = lambda _r: httpx.Response(200, text=LEAKY_BODY)
    refused = await upload(client, session)
    assert refused.status_code == 502
    assert_no_leak(refused.text)
    (entry,) = entries(await logs(client))
    assert (entry["provider"], entry["outcome"], entry["status"]) == (provider, "invalid_response", 200)
