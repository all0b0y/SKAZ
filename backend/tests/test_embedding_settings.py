"""Embedding is a separate task; saving its profile never performs inference."""
import httpx
import pytest

from tests.conftest import FakeHttp


async def test_embedding_profile_defaults_and_independent_roundtrip(
    client: httpx.AsyncClient, outbound: FakeHttp,
) -> None:
    before = (await client.get("/settings")).json()
    assert before.get("embedding", {}).get("provider") == "openrouter"
    assert before["embedding"]["model"] == ""
    outbound.json_route("GET", "openrouter.ai/api/v1/embeddings/models", {"data": [{
        "id": "qwen/qwen3-embedding-8b", "name": "Qwen Embedding",
        "architecture": {"input_modalities": ["text"], "output_modalities": ["embeddings"]},
    }]})
    response = await client.put("/settings", json={"embedding": {"model": "qwen/qwen3-embedding-8b"}})
    assert response.status_code == 200
    body = response.json()
    assert body["embedding"]["model"] == "qwen/qwen3-embedding-8b"
    assert body["embedding"]["verified"] is False
    for task in ("asr", "agent", "notes"):
        assert body[task] == before[task]
    assert (await client.get("/settings")).json()["embedding"] == body["embedding"]
    assert not any(request.method == "POST" for request in outbound.requests)


async def test_embedding_picker_uses_dedicated_catalog(client: httpx.AsyncClient, outbound: FakeHttp) -> None:
    outbound.json_route("GET", "openrouter.ai/api/v1/embeddings/models", {"data": [{
        "id": "openai/text-embedding-3-small", "name": "Embedding small",
        "architecture": {"input_modalities": ["text"], "output_modalities": ["embeddings"]},
    }, {"id": "not-an-embedding", "architecture": {"output_modalities": ["text"]}}]})
    response = await client.get("/models", params={"provider": "openrouter", "task": "embedding"})
    assert response.status_code == 200
    assert [m["id"] for m in response.json()["models"]] == ["openai/text-embedding-3-small"]
    assert not response.json()["models"][0]["verified"]
    assert all("/embeddings/models" in str(r.url) for r in outbound.requests)


async def test_rejects_wrong_provider_and_chat_model_without_persisting(
    client: httpx.AsyncClient, outbound: FakeHttp,
) -> None:
    before = (await client.get("/settings")).json()["embedding"]
    outbound.json_route("GET", "openrouter.ai/api/v1/embeddings/models", {"data": []})
    for profile in ({"provider": "openai", "model": ""}, {"model": "chat-model"}):
        response = await client.put("/settings", json={"embedding": profile})
        assert response.status_code == 400
        assert (await client.get("/settings")).json()["embedding"] == before


async def test_embedding_validation_fails_closed_when_catalog_is_unavailable(
    client: httpx.AsyncClient,
) -> None:
    response = await client.put("/settings", json={"embedding": {"model": "unknown"}})
    assert response.status_code == 400
    assert "unavailable" in response.json()["detail"].lower()
    assert (await client.get("/settings")).json()["embedding"]["model"] == ""


def test_existing_settings_without_embedding_load_unconfigured() -> None:
    from audiohelper.settings_store import DEFAULT_SETTINGS, StoredSettings

    legacy = DEFAULT_SETTINGS.model_dump()
    legacy.pop("embedding")
    loaded = StoredSettings.model_validate(legacy)
    assert loaded.embedding.provider == "openrouter"
    assert loaded.embedding.model == ""
    assert loaded.agent == DEFAULT_SETTINGS.agent

async def test_optional_embedding_limit_roundtrip(client: httpx.AsyncClient) -> None:
    assert (await client.get("/settings")).json()["embedding_budget_usd"] is None
    saved = await client.put("/settings", json={"embedding_budget_usd": 0.01})
    assert saved.status_code == 200
    assert saved.json()["embedding_budget_usd"] == 0.01
    await client.put("/settings", json={"output_language": "en"})
    assert (await client.get("/settings")).json()["embedding_budget_usd"] == 0.01
    disabled = await client.put("/settings", json={"embedding_budget_usd": None})
    assert disabled.status_code == 200
    assert (await client.get("/settings")).json()["embedding_budget_usd"] is None


@pytest.mark.parametrize("limit", [0, -1, 101, "0.01", True])
async def test_invalid_embedding_limits_are_not_saved(client: httpx.AsyncClient, limit: object) -> None:
    response = await client.put("/settings", json={"embedding_budget_usd": limit})
    assert response.status_code == 422
    assert (await client.get("/settings")).json()["embedding_budget_usd"] is None

