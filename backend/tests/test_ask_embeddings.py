"""Ask's real HTTP boundary, with authored vectors (not a model-quality evaluation)."""
from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from tests.conftest import FakeHttp
from tests.test_agent_ask import OPENING, add_transcript, configure, prompt_text, stub_answer

MODEL = "qwen/qwen3-embedding-8b"


async def setup(client: httpx.AsyncClient, outbound: FakeHttp) -> str:
    from tests.test_agent_ask import CATALOG

    outbound.json_route("GET", "openrouter.ai/api/v1/models", CATALOG)
    await configure(client)
    outbound.json_route("GET", "/embeddings/models", {"data": [{
        "id": MODEL, "architecture": {"output_modalities": ["embeddings"]},
    }]})
    response = await client.put("/settings", json={"embedding": {"model": MODEL}})
    assert response.status_code == 200, response.text
    outbound.json_route("GET", "/endpoints/zdr", {"data": [{
        "model_id": MODEL, "tag": "deepinfra", "status": 0,
        "context_length": 8192, "pricing": {"prompt": "0.00000001"},
    }]})

    @outbound.route("POST", "/embeddings")
    def embed(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        return httpx.Response(200, json={"model": "Qwen/Qwen3-Embedding-8B",
            "usage": {"prompt_tokens": 10}, "data": [
                {"index": i, "embedding": [1.0, 0.0] if "энтроп" in text or "Query:" in text else [0.0, 1.0]}
                for i, text in enumerate(body["input"])
            ]})

    session = (await client.post("/sessions", json={"title": "Authored fixture"})).json()["id"]
    await add_transcript(client, outbound, session, 0, 0, OPENING)
    await add_transcript(client, outbound, session, 1, 600_000, "Обсуждаем кэширование.")
    stub_answer(outbound, "В начале определили энтропию [P1].")
    return str(session)


async def test_ask_uses_selected_embedding_and_local_cache(
    client: httpx.AsyncClient, outbound: FakeHttp,
) -> None:
    session = await setup(client, outbound)
    for _ in range(2):
        response = await client.post(f"/sessions/{session}/ask", json={
            "question": "Как измеряли неопределённость?", "scope": "search",
        })
        assert response.status_code == 200, response.text
        assert response.json()["citations"][0]["text"] == OPENING
        assert response.json()["citations"][0]["monologue_id"]
        assert response.json()["citations"][0]["labels"] == ["P1"]
        assert response.json()["context"]["retrieval"] == "hybrid"
    detail = (await client.get(f"/sessions/{session}")).json()
    stored = [m for m in detail["messages"] if m["role"] == "assistant"][-1]
    assert "[P1]" in stored["content"]
    assert stored["citations"][0]["labels"] == ["P1"]
    embeds = [json.loads(r.content) for r in outbound.requests
              if r.method == "POST" and "/embeddings" in str(r.url)]
    assert len(embeds) == 3, "one document batch, two independent query requests"
    assert embeds[0]["input"] == [OPENING, "Обсуждаем кэширование."]
    assert embeds[0]["model"] == MODEL
    assert embeds[0]["provider"]["only"] == ["deepinfra"]
    assert embeds[0]["provider"]["data_collection"] == "deny"
    assert embeds[0]["provider"]["zdr"] is True
    assert embeds[0]["provider"]["allow_fallbacks"] is False
    assert "Query: Как измеряли неопределённость?" in embeds[1]["input"][0]
    assert OPENING in prompt_text(outbound)


def embedding_inputs(outbound: FakeHttp) -> list[list[str]]:
    return [json.loads(r.content)["input"] for r in outbound.requests
            if r.method == "POST" and "/embeddings" in str(r.url)]


async def ask_hybrid(client: httpx.AsyncClient, session: str, **over: Any) -> httpx.Response:
    return await client.post(f"/sessions/{session}/ask", json={
        "question": "Как измеряли неопределённость?", "scope": "search",
        **over,
    })


@pytest.mark.parametrize("budget", [0.000001])
async def test_saved_insufficient_budget_sends_no_text(
    client: httpx.AsyncClient, outbound: FakeHttp, budget: float | None,
) -> None:
    session = await setup(client, outbound)
    saved = await client.put("/settings", json={"embedding_budget_usd": budget})
    assert saved.status_code == 200
    before = len(outbound.requests)
    response = await ask_hybrid(client, session)
    assert response.status_code == 400
    assert "$0.00024576" in response.json()["detail"]
    assert all(request.method == "GET" for request in outbound.requests[before:])
    assert "Settings" in response.json()["detail"]
    await client.put("/settings", json={"embedding_budget_usd": None})
    assert (await ask_hybrid(client, session)).status_code == 200



@pytest.mark.parametrize("failure", ["consent", "zdr", "fee", "price", "metadata"])
async def test_privacy_and_price_gates_never_fall_back_or_transmit_text(
    client: httpx.AsyncClient, outbound: FakeHttp, failure: str,
) -> None:
    session = await setup(client, outbound)
    if failure == "consent":
        await client.put("/settings", json={"cloud_consent": False})
    elif failure == "zdr":
        outbound.json_route("GET", "/endpoints/zdr", {"data": []})
    elif failure in ("fee", "price"):
        outbound.json_route("GET", "/endpoints/zdr", {"data": [{
            "model_id": MODEL, "tag": "deepinfra", "status": 0, "context_length": 8192,
            "pricing": {"prompt": "NaN"} if failure == "price" else {"prompt": "0.1", "request": "1"},
        }]})
    else:
        outbound.json_route("GET", "/endpoints/zdr", {"data": "bad"})
    before = len(outbound.requests)
    response = await ask_hybrid(client, session)
    assert response.status_code in (400, 502)
    assert not any(request.method == "POST" for request in outbound.requests[before:])
    assert (await client.get(f"/sessions/{session}")).json()["messages"] == []


@pytest.mark.parametrize("failure", [
    "model", "zero", "overflow", "dimensions", "ordering", "usage", "http", "timeout",
])
async def test_invalid_provider_response_stops_without_retry_or_answer(
    client: httpx.AsyncClient, outbound: FakeHttp, failure: str,
) -> None:
    session = await setup(client, outbound)
    payload: dict[str, Any] = {"model": MODEL, "usage": {"prompt_tokens": 10}, "data": [
        {"index": 0, "embedding": [1, 0]}, {"index": 1, "embedding": [0, 1]},
    ]}
    if failure == "model":
        payload["model"] = "a/different-model"
    if failure == "zero":
        payload["data"][0]["embedding"] = [0, 0]
    if failure == "overflow":
        payload["data"][0]["embedding"] = [10 ** 500, 0]
    if failure == "dimensions":
        payload["data"][0]["embedding"] = [1, 0, 0]
    if failure == "ordering":
        payload["data"][1]["index"] = 0
    if failure == "usage":
        payload.pop("usage")
    if failure == "timeout":
        @outbound.route("POST", "/embeddings")
        def timeout(_request: httpx.Request) -> httpx.Response:
            raise httpx.ReadTimeout("secret provider response")
    else:
        outbound.json_route("POST", "/embeddings", payload, status=503 if failure == "http" else 200)
    before = len(outbound.requests)
    response = await ask_hybrid(client, session)
    assert response.status_code == 502
    assert "secret provider response" not in response.text
    posts = [request for request in outbound.requests[before:] if request.method == "POST"]
    assert len(posts) == 1 and "/embeddings" in str(posts[0].url)
    assert (await client.get(f"/sessions/{session}")).json()["messages"] == []


async def test_new_speech_indexes_only_missing_windows_and_does_not_include_other_sessions_or_notes(
    client: httpx.AsyncClient, outbound: FakeHttp,
) -> None:
    session = await setup(client, outbound)
    foreign = (await client.post("/sessions", json={"title": "Other"})).json()["id"]
    await add_transcript(client, outbound, foreign, 0, 0, "FOREIGN EVIDENCE")
    note = (await client.post(f"/sessions/{session}/notes/empty")).json()
    response = await client.patch(f"/sessions/{session}/notes/{note['id']}", json={
        "expected_revision": note["revision"], "content": "NOTES NOT EVIDENCE",
    })
    assert response.status_code == 200, response.text
    stub_answer(outbound, "Измеряли энтропию [P1].")
    assert (await ask_hybrid(client, session)).status_code == 200
    await add_transcript(client, outbound, session, 2, 800_000, "Новая подтверждённая речь.")
    stub_answer(outbound, "Энтропия [P1].")
    response = await ask_hybrid(client, session)
    assert response.status_code == 200, response.text
    inputs = embedding_inputs(outbound)
    assert inputs[2] == ["Новая подтверждённая речь."]
    assert "FOREIGN EVIDENCE" not in str(inputs) + prompt_text(outbound)
    assert "NOTES NOT EVIDENCE" not in str(inputs) + prompt_text(outbound)


async def test_full_session_reads_every_monologue_without_paid_embedding_search(
    client: httpx.AsyncClient, outbound: FakeHttp,
) -> None:
    session = await setup(client, outbound)
    response = await ask_hybrid(client, session, scope="all")
    assert response.status_code == 200, response.text
    assert response.json()["context"]["retrieval"] == "monologues"
    assert response.json()["context"]["source_count"] == 2
    assert not embedding_inputs(outbound)
    assert OPENING in prompt_text(outbound) and "Обсуждаем кэширование." in prompt_text(outbound)


async def test_oversize_full_review_refuses_before_generation(
    client: httpx.AsyncClient, outbound: FakeHttp,
) -> None:
    session = await setup(client, outbound)
    await add_transcript(client, outbound, session, 2, 800_000, "Very long speech. " * 3000)
    before = len(outbound.requests)
    response = await ask_hybrid(client, session, scope="all")
    assert response.status_code == 400
    assert not any(request.method == "POST" for request in outbound.requests[before:])


async def test_native_confirmed_prefix_and_provenance_exclude_draft_translation_and_post_snapshot_tokens(
    client: httpx.AsyncClient, outbound: FakeHttp, app: Any,
) -> None:
    from audiohelper.gateways.soniox import SonioxEvent, SonioxToken, SonioxTranslationToken

    await setup(client, outbound)
    sid = (await client.post("/sessions", json={"title": "Native snapshot"})).json()["id"]
    store = app.state.runtime.live_store
    connection = store.open(sid, sample_rate=16000, model="stt-rt-v5")
    store.append_audio(connection.id, sequence=0, start_sample=0, pcm=b"\x00\x00" * 1600)
    store.save_event(connection.id, ordinal=0, event=SonioxEvent(
        (SonioxToken("Original prefix", 0, 50, .9, True, "en", "1"),),
        (SonioxToken("DRAFT MUST NOT LEAK", 50, 100, .8, False, "en", "1"),), (), 50, 100, False,
        final_translation_tokens=(
            SonioxTranslationToken("TRANSLATION NOT EVIDENCE", .9, True, "ru", "en", "1"),
        ),
    ))
    original_handler = outbound.routes[("POST", "/embeddings")]
    changed = False

    @outbound.route("POST", "/embeddings")
    def advance(request: httpx.Request) -> httpx.Response:
        nonlocal changed
        if not changed:
            changed = True
            store.save_event(connection.id, ordinal=1, event=SonioxEvent(
                (SonioxToken(" AFTER SNAPSHOT", 50, 100, .9, True, "en", "1"),), (), (), 100, 100, False,
            ))
        return original_handler(request)

    stub_answer(outbound, "Original [P1].")
    response = await ask_hybrid(client, sid)
    assert response.status_code == 200, response.text
    citation = response.json()["citations"][0]
    assert citation["text"] == "Original prefix"
    assert citation["speaker"] == 1
    assert citation["start_token_id"] == citation["end_token_id"]
    assert citation["end_ms"] == 50
    sent = str(embedding_inputs(outbound)) + prompt_text(outbound)
    for excluded in ("DRAFT MUST NOT LEAK", "TRANSLATION NOT EVIDENCE", "AFTER SNAPSHOT"):
        assert excluded not in sent
    outbound.requests.clear()
    response = await ask_hybrid(client, sid)
    assert response.status_code == 200, response.text
    assert embedding_inputs(outbound)[0] == ["Original prefix AFTER SNAPSHOT"]


async def test_cache_survives_backend_restart(
    client: httpx.AsyncClient, outbound: FakeHttp, app: Any,
) -> None:
    from audiohelper.app import create_app
    from tests.conftest import TOKEN

    sid = await setup(client, outbound)
    await client.put("/settings", json={"embedding_budget_usd": 0.01})
    assert (await ask_hybrid(client, sid)).status_code == 200
    runtime = app.state.runtime
    runtime.close()
    reopened = create_app(runtime.config, secret_store=runtime.secrets, http_client=outbound.client())
    try:
        outbound.requests.clear()
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=reopened),
                                     base_url="http://127.0.0.1:8765",
                                     headers={"Authorization": f"Bearer {TOKEN}"}) as restored:
            assert (await restored.get("/settings")).json()["embedding_budget_usd"] == 0.01
            result = await ask_hybrid(restored, sid)
            assert result.status_code == 200, result.text
            assert len(embedding_inputs(outbound)) == 1
            assert "Query:" in embedding_inputs(outbound)[0][0]
    finally:
        reopened.state.runtime.close()


async def test_model_change_never_reuses_old_vector_space(
    client: httpx.AsyncClient, outbound: FakeHttp,
) -> None:
    sid = await setup(client, outbound)
    assert (await ask_hybrid(client, sid)).status_code == 200
    # A new route for the same explicitly selected model is a distinct vector space.
    outbound.json_route("GET", "/endpoints/zdr", {"data": [{
        "model_id": MODEL, "tag": "different-endpoint", "status": 0,
        "context_length": 8192, "pricing": {"prompt": "0.00000001"},
    }]})
    before = len(embedding_inputs(outbound))
    response = await ask_hybrid(client, sid)
    assert response.status_code == 502, "downstream alias is not accepted for another provider"
    assert len(embedding_inputs(outbound)) == before + 1
    assert embedding_inputs(outbound)[-1] == [OPENING, "Обсуждаем кэширование."]


async def test_revocation_during_indexing_stops_before_query_and_chat(
    client: httpx.AsyncClient, outbound: FakeHttp, app: Any,
) -> None:
    sid = await setup(client, outbound)
    original = outbound.routes[("POST", "/embeddings")]

    @outbound.route("POST", "/embeddings")
    def revoke(request: httpx.Request) -> httpx.Response:
        settings = app.state.runtime.settings_store.load()
        settings.cloud_consent = False
        app.state.runtime.settings_store.save(settings)
        return original(request)

    response = await ask_hybrid(client, sid)
    assert response.status_code == 400
    assert len(embedding_inputs(outbound)) == 1


async def test_fabricated_citation_is_rejected_and_not_saved(
    client: httpx.AsyncClient, outbound: FakeHttp,
) -> None:
    sid = await setup(client, outbound)
    stub_answer(outbound, "Сказано [P99].")
    result = await ask_hybrid(client, sid)
    assert result.status_code == 502
    assert (await client.get(f"/sessions/{sid}")).json()["messages"] == []


async def test_exact_number_survives_semantic_mismatch_and_partial_coverage_is_visible(
    client: httpx.AsyncClient, outbound: FakeHttp,
) -> None:
    sid = await setup(client, outbound)
    for sequence in range(2, 16):
        await add_transcript(client, outbound, sid, sequence, sequence * 1_000_000,
                             f"Точное значение {12345 if sequence == 15 else sequence}.")
    stub_answer(outbound, "Источник есть [P2].")
    result = await ask_hybrid(client, sid, question="12345?")
    assert result.status_code == 200, result.text
    assert "12345" in prompt_text(outbound)
    assert result.json()["context"]["selected_count"] == 12
    assert result.json()["context"]["source_count"] == 16
    assert result.json()["context"]["truncated"] is True
    assert "не полный обзор" in result.json()["answer"]
