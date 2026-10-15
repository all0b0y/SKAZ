"""The technical activity log, as ``GET /logs`` reports it.

Records are produced by the provider speech-to-text gateways that remain
(``gateways/asr.py``; the cloud adapters are used by ``scripts/asr_eval.py``,
Local Whisper by dictation): each test runs a gateway inside an installation's
activity scope — exactly what the app's middleware sets for a request — with an
injected ``httpx`` transport on the provider side, and reads the result back
through the public ``GET /logs``.

The session-based HTTP routes these tests used to drive (audio upload, the
session assistant) were removed with the old interface; the chat-completion
records they produced no longer exist anywhere, so their tests went with them.

Three properties are checked everywhere:

* a record names only technical facts — operation, provider, exact model ID,
  attempt, elapsed, status, outcome, whitelisted token counts and a timestamp;
* it never carries transcript text, a request or response body, a header, a URL,
  an API key or the text of an exception;
* the store is per-installation and bounded: the oldest record is dropped, never
  the newest, and it can never grow without limit.
"""

from __future__ import annotations

import asyncio
import sys
from collections.abc import AsyncIterator, Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import httpx
import pytest

from skaz.activity import current_activity
from skaz.app import create_app
from skaz.audio import parse_wav
from skaz.config import AppConfig
from skaz.gateways import ProviderError, ProviderNotConfigured
from skaz.gateways.asr import LocalWhisperTranscriber, OpenAITranscriber, OpenRouterTranscriber
from skaz.secrets import MemorySecretStore
from tests.conftest import TOKEN, FakeHttp, make_wav

# Public log labels, not imports from gateway implementation details.
ASR_OPERATION = "provider audio transcription"
ASR_MODEL = "qwen/qwen3-asr-1.7b"
API_KEY = "sk-live-" + "9f3TOPSECRET"
TRANSCRIPT = "Мы определили энтропию как меру беспорядка."

#: Everything a record must never repeat, whatever the provider sent.
LEAKY_BODY = (
    '{"error": {"message": "key ' + API_KEY + ' rejected for Ivan Petrov; '
    'prompt was: секретное совещание про увольнения"}}'
)
LEAKS = (
    API_KEY,
    "Ivan Petrov",
    "секретное совещание",
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

TINY_CAPACITY = 4

Handler = Callable[[httpx.Request], httpx.Response]


# --- fixtures and helpers ---------------------------------------------------------


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


@contextmanager
def activity_of(app: Any) -> Iterator[None]:
    """The installation's activity scope, as the app's request middleware sets it."""
    token = current_activity.set(app.state.runtime.activity_log)
    try:
        yield
    finally:
        current_activity.reset(token)


async def transcribe(app: Any, outbound: FakeHttp, *, model: str = ASR_MODEL, provider: str = "openrouter",
                     sequence: int = 0) -> None:
    """One provider transcription attempt inside ``app``'s activity scope; provider failures are raised."""
    http = outbound.client()
    gateway: OpenRouterTranscriber | OpenAITranscriber = (
        OpenRouterTranscriber(http, model=model, api_key=API_KEY, timeout=5.0) if provider == "openrouter"
        else OpenAITranscriber(http, model=model, api_key=API_KEY, provider=provider, timeout=5.0))
    with activity_of(app):
        try:
            await gateway.transcribe(parse_wav(make_wav(1.0), max_seconds=30.0), language="auto")
        finally:
            await http.aclose()


async def refused(app: Any, outbound: FakeHttp, **kwargs: Any) -> ProviderError:
    with pytest.raises(ProviderError) as caught:
        await transcribe(app, outbound, **kwargs)
    assert_no_leak(str(caught.value))
    return caught.value


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


# --- transcription attempts ---------------------------------------------------------


async def test_a_transcription_attempt_is_recorded_in_the_same_shape(
    app: Any, client: httpx.AsyncClient, outbound: FakeHttp
) -> None:
    outbound.json_route(
        "POST",
        "audio/transcriptions",
        transcription(
            TRANSCRIPT,
            usage={"type": "tokens", "input_tokens": 14, "output_tokens": 45, "total_tokens": 59},
        ),
    )
    await transcribe(app, outbound)

    recorded = entries(await logs(client))
    asr = [entry for entry in recorded if entry["operation"] == ASR_OPERATION]
    assert len(asr) == 1
    assert_shape(asr[0])
    assert asr[0]["provider"] == "openrouter"
    assert asr[0]["model"] == ASR_MODEL
    assert asr[0]["attempt"] == 1
    assert asr[0]["outcome"] == "ok"
    assert asr[0]["status"] == 200
    assert asr[0]["retrying"] is False
    assert asr[0]["usage"] == {"input_tokens": 14, "output_tokens": 45, "total_tokens": 59}


@pytest.mark.parametrize("status", [401, 402])
async def test_a_failed_transcription_is_recorded_with_its_status_without_the_provider_body(
    app: Any, client: httpx.AsyncClient, outbound: FakeHttp, status: int
) -> None:
    replies(outbound, "audio/transcriptions", failing(status))
    await refused(app, outbound)

    asr = [entry for entry in entries(await logs(client)) if entry["operation"] == ASR_OPERATION]
    assert len(asr) == 1, "a transcription is attempted once; there is no ASR retry policy"
    assert (asr[0]["outcome"], asr[0]["status"], asr[0]["attempt"]) == ("http_error", status, 1)


async def test_a_transcription_transport_failure_is_recorded_without_the_url(
    app: Any, client: httpx.AsyncClient, outbound: FakeHttp
) -> None:
    def fail(_request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError(f"no route to https://openrouter.ai/api/v1?key={API_KEY}")

    outbound.routes[("POST", "audio/transcriptions")] = fail
    await refused(app, outbound)

    asr = [entry for entry in entries(await logs(client)) if entry["operation"] == ASR_OPERATION]
    assert asr[0]["outcome"] == "transport_error"
    assert asr[0]["status"] is None


async def test_a_malformed_transcription_reply_is_recorded_as_an_invalid_response(
    app: Any, client: httpx.AsyncClient, outbound: FakeHttp
) -> None:
    outbound.routes[("POST", "audio/transcriptions")] = lambda _r: httpx.Response(200, text=LEAKY_BODY)
    await refused(app, outbound)

    asr = [entry for entry in entries(await logs(client)) if entry["operation"] == ASR_OPERATION]
    assert (asr[0]["outcome"], asr[0]["status"]) == ("invalid_response", 200)


async def test_a_local_transcription_without_its_dependency_is_recorded(
    app: Any,
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The local profile (dictation's) still produces one honest attempt record."""
    # Model availability on the developer machine must not turn this into inference.
    monkeypatch.setitem(sys.modules, "numpy", None)
    transcriber = LocalWhisperTranscriber(model="small", allow_download=False)
    with activity_of(app), pytest.raises(ProviderNotConfigured) as caught:
        await transcriber.transcribe(parse_wav(make_wav(0.25), max_seconds=1.0), language="auto")
    assert_no_leak(str(caught.value))

    asr = [entry for entry in entries(await logs(client)) if entry["operation"] == ASR_OPERATION]
    assert len(asr) == 1
    assert asr[0]["provider"] == "local-whisper"
    assert asr[0]["model"] == "small"
    assert asr[0]["outcome"] == "not_configured"
    assert asr[0]["status"] is None


# --- ordering, bounds and isolation --------------------------------------------------


async def test_records_are_returned_newest_first(
    app: Any, client: httpx.AsyncClient, outbound: FakeHttp
) -> None:
    outbound.json_route("POST", "audio/transcriptions", transcription(TRANSCRIPT))
    for _ in range(3):
        await transcribe(app, outbound)

    recorded = entries(await logs(client))
    sequences = [entry["sequence"] for entry in recorded]
    assert sequences == sorted(sequences, reverse=True)
    assert len(set(sequences)) == len(sequences)
    stamps = [entry["at_ms"] for entry in recorded]
    assert stamps == sorted(stamps, reverse=True), "a timestamp must never move backwards"


async def test_the_store_drops_the_oldest_records_and_never_grows(
    tiny_app: Any, tiny_client: httpx.AsyncClient, outbound: FakeHttp
) -> None:
    outbound.json_route("POST", "audio/transcriptions", transcription(TRANSCRIPT))
    total = TINY_CAPACITY * 3
    for _ in range(total):
        await transcribe(tiny_app, outbound)

    payload = await logs(tiny_client, limit=100)
    recorded = entries(payload)
    assert len(recorded) == TINY_CAPACITY == payload["capacity"]
    assert payload["dropped"] == total - TINY_CAPACITY
    assert [entry["sequence"] for entry in recorded] == list(range(total, total - TINY_CAPACITY, -1))


async def test_a_limit_returns_only_the_newest_records(
    app: Any, client: httpx.AsyncClient, outbound: FakeHttp
) -> None:
    outbound.json_route("POST", "audio/transcriptions", transcription(TRANSCRIPT))
    for _ in range(3):
        await transcribe(app, outbound)

    everything = entries(await logs(client))
    newest = entries(await logs(client, limit=1))
    assert len(newest) == 1
    assert newest[0] == everything[0]


@pytest.mark.parametrize("limit", [0, -1, "many"])
async def test_an_unusable_limit_is_rejected(client: httpx.AsyncClient, limit: Any) -> None:
    response = await client.get("/logs", params={"limit": limit})
    assert response.status_code == 422


async def test_one_installation_never_sees_another_installations_activity(
    app: Any, client: httpx.AsyncClient, other_client: httpx.AsyncClient, outbound: FakeHttp
) -> None:
    outbound.json_route("POST", "audio/transcriptions", transcription(TRANSCRIPT))
    await transcribe(app, outbound)

    assert entries(await logs(client)) != []
    assert entries(await logs(other_client)) == []


async def test_concurrent_attempts_each_record_their_own_entry(
    app: Any, client: httpx.AsyncClient, outbound: FakeHttp
) -> None:
    outbound.json_route("POST", "audio/transcriptions", transcription(TRANSCRIPT))
    attempts = 6

    await asyncio.gather(*(transcribe(app, outbound) for _ in range(attempts)))

    recorded = entries(await logs(client, limit=100))
    asr = [entry for entry in recorded if entry["operation"] == ASR_OPERATION]
    assert len(asr) == attempts, "no attempt is lost when transcriptions run concurrently"
    assert len({entry["sequence"] for entry in recorded}) == len(recorded), "no sequence is reused"


async def test_a_hostile_model_id_is_stored_verbatim_and_stays_one_record(
    app: Any, client: httpx.AsyncClient, outbound: FakeHttp
) -> None:
    hostile = 'evil/model\n{"operation": "forged", "outcome": "ok"}\r"quote"'
    outbound.json_route("POST", "audio/transcriptions", transcription(TRANSCRIPT))
    await transcribe(app, outbound, model=hostile)

    asr = [entry for entry in entries(await logs(client)) if entry["operation"] == ASR_OPERATION]
    assert len(asr) == 1, "a model ID cannot forge a second record"
    assert asr[0]["model"] == hostile, "the exact model ID survives"


async def test_usage_cannot_smuggle_payloads_into_the_log(
    app: Any, client: httpx.AsyncClient, outbound: FakeHttp
) -> None:
    outbound.json_route("POST", "audio/transcriptions", transcription(TRANSCRIPT, usage={
        "input_tokens": True, "output_tokens": -1, "total_tokens": 7,
        "prompt": TRANSCRIPT, "secret": API_KEY, "details": {"text": TRANSCRIPT},
    }))
    await transcribe(app, outbound)
    (entry,) = entries(await logs(client))
    assert entry["usage"] == {"total_tokens": 7}


async def test_concurrent_installations_keep_independent_logs(
    app: Any, other_app: Any, client: httpx.AsyncClient, other_client: httpx.AsyncClient, outbound: FakeHttp
) -> None:
    outbound.json_route("POST", "audio/transcriptions", transcription(TRANSCRIPT))
    await asyncio.gather(transcribe(app, outbound), transcribe(other_app, outbound))
    for installation in (client, other_client):
        (entry,) = entries(await logs(installation))
        assert entry["sequence"] == 1


async def test_the_openai_asr_adapter_also_rejects_error_payloads_without_leaking(
    app: Any, client: httpx.AsyncClient, outbound: FakeHttp
) -> None:
    provider = "openai"
    outbound.routes[("POST", "audio/transcriptions")] = lambda _r: httpx.Response(200, text=LEAKY_BODY)
    await refused(app, outbound, provider=provider, model="whisper-1")
    (entry,) = entries(await logs(client))
    assert (entry["provider"], entry["outcome"], entry["status"]) == (provider, "invalid_response", 200)
