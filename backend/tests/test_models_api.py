from __future__ import annotations

import json

import httpx
import pytest

from audiohelper.app import create_app
from audiohelper.config import AppConfig
from audiohelper.secrets import MemorySecretStore
from tests.conftest import TOKEN, FakeHttp, make_wav

CATALOG = {
    "data": [
        {
            "id": "qwen/qwen3-asr-1.7b",
            "name": "Qwen3 ASR 1.7B",
            "architecture": {"input_modalities": ["audio"], "output_modalities": ["transcription"]},
            "pricing": {"prompt": "0.0000075", "completion": "0"},
            "top_provider": {"max_completion_tokens": 0},
        },
        {
            "id": "google/gemini-2.5-flash-lite",
            "name": "Gemini 2.5 Flash Lite",
            "architecture": {"input_modalities": ["text", "image", "audio"], "output_modalities": ["text"]},
        },
        {
            "id": "qwen/qwen3-30b-a3b-instruct-2507",
            "name": "Qwen3 30B",
            "architecture": {"input_modalities": ["text"], "output_modalities": ["text"]},
        },
        {
            "id": "some/image-only",
            "name": "Image only",
            "architecture": {"input_modalities": ["text"], "output_modalities": ["image"]},
        },
        {
            "id": "some/audio-only",
            "name": "Audio only",
            "architecture": {"input_modalities": ["text"], "output_modalities": ["audio"]},
        },
        {
            "id": "some/video-only",
            "name": "Video only",
            "architecture": {"input_modalities": ["text"], "output_modalities": ["video"]},
        },
        # The provider published no capability metadata at all.
        {"id": "vendor/undeclared", "name": "Undeclared modalities"},
        # Metadata is present but unusable: wrong container types and empty lists.
        {
            "id": "vendor/malformed",
            "name": "Malformed modalities",
            "architecture": {"input_modalities": "text", "output_modalities": [None, 7]},
        },
        {
            "id": "vendor/broken-architecture",
            "name": "Architecture is not an object",
            "architecture": "text->text",
        },
    ]
}

TEXT_TASKS = ("agent", "notes")


def _by_id(body: dict[str, object]) -> dict[str, dict[str, object]]:
    models = body["models"]
    assert isinstance(models, list)
    return {model["id"]: model for model in models}


@pytest.fixture(autouse=True)
def _catalog(outbound: FakeHttp) -> None:
    outbound.json_route("GET", "openrouter.ai/api/v1/models", CATALOG)


async def test_asr_task_puts_dedicated_transcription_models_first(client: httpx.AsyncClient) -> None:
    body = (await client.get("/models", params={"provider": "openrouter", "task": "asr"})).json()
    dedicated = [model for model in body["models"] if model["asr_contract"] == "dedicated"]
    assert [model["id"] for model in dedicated] == ["qwen/qwen3-asr-1.7b"]
    assert body["models"][0]["id"] == "qwen/qwen3-asr-1.7b", "the dedicated group must come first"
    assert dedicated[0]["output_modalities"] == ["transcription"]
    assert dedicated[0]["recommended"] is True
    assert dedicated[0]["pricing"] == {"amount_usd": 0.0000075, "unit": "second"}
    assert body.get("error") is None


async def test_audio_input_chat_model_is_offered_only_as_legacy(client: httpx.AsyncClient) -> None:
    """An audio-input LLM is a candidate, not an ASR contract; it must say so."""
    body = (await client.get("/models", params={"provider": "openrouter", "task": "asr"})).json()
    legacy = {model["id"]: model for model in body["models"] if model["asr_contract"] == "legacy"}
    assert set(legacy) == {"google/gemini-2.5-flash-lite"}
    assert legacy["google/gemini-2.5-flash-lite"]["verified"] is False
    assert legacy["google/gemini-2.5-flash-lite"]["recommended"] is False
    note = legacy["google/gemini-2.5-flash-lite"]["note"].lower()
    assert "audio input" in note and "not a dedicated" in note


async def test_text_only_models_never_appear_in_the_asr_picker(client: httpx.AsyncClient) -> None:
    body = (await client.get("/models", params={"provider": "openrouter", "task": "asr"})).json()
    ids = [model["id"] for model in body["models"]]
    assert "qwen/qwen3-30b-a3b-instruct-2507" not in ids
    assert "some/image-only" not in ids


async def test_dedicated_asr_model_is_not_offered_for_chat_tasks(client: httpx.AsyncClient) -> None:
    body = (await client.get("/models", params={"provider": "openrouter", "task": "agent"})).json()
    assert "qwen/qwen3-asr-1.7b" not in [model["id"] for model in body["models"]]


async def test_audio_input_alone_is_not_reported_as_verified_asr(client: httpx.AsyncClient) -> None:
    body = (await client.get("/models", params={"provider": "openrouter", "task": "asr"})).json()
    model = body["models"][0]
    assert model["verified"] is False
    assert "dedicated" in model["note"].lower()


async def test_agent_task_lists_text_output_models(client: httpx.AsyncClient) -> None:
    body = (await client.get("/models", params={"provider": "openrouter", "task": "agent"})).json()
    ids = [model["id"] for model in body["models"]]
    assert "qwen/qwen3-30b-a3b-instruct-2507" in ids
    assert "some/image-only" not in ids


async def test_local_whisper_models_are_listed_without_network(client: httpx.AsyncClient) -> None:
    body = (await client.get("/models", params={"provider": "local-whisper", "task": "asr"})).json()
    ids = [model["id"] for model in body["models"]]
    assert "small" in ids and "large-v3" in ids
    assert all(model["verified"] is False for model in body["models"])


async def test_dedicated_model_stays_dedicated_when_the_stt_listing_is_down(
    client: httpx.AsyncClient, outbound: FakeHttp
) -> None:
    """A transient failure of the filtered listing must not demote a real STT model to legacy."""

    def only_unfiltered(request: httpx.Request) -> httpx.Response:
        if "output_modalities=transcription" in str(request.url):
            return httpx.Response(503, json={"error": "temporarily unavailable"})
        return httpx.Response(200, json=CATALOG)

    outbound.routes[("GET", "openrouter.ai/api/v1/models")] = only_unfiltered
    response = await client.put(
        "/settings",
        json={"provider_keys": {"openrouter": "sk-test"}, "asr": {"provider": "openrouter", "model": "qwen/qwen3-asr-1.7b"},
            "cloud_consent": True,
        },
    )
    assert response.status_code == 200, response.text
    created = await client.post("/sessions", json={"title": "Деградация"})
    outbound.json_route("POST", "audio/transcriptions", {"text": "Настоящий текст."})
    chunk = await client.post(
        f"/sessions/{created.json()['id']}/audio",
        params={"sequence": 0, "start_ms": 0, "end_ms": 1000},
        content=make_wav(1.0),
        headers={"Content-Type": "audio/wav"},
    )
    assert chunk.status_code == 200, chunk.text
    assert [item["text"] for item in chunk.json()["segments"]] == ["Настоящий текст."]
    assert str(outbound.requests[-1].url).endswith("/audio/transcriptions"), "dedicated contract was used"


async def test_catalog_failure_is_reported_without_inventing_models(
    client: httpx.AsyncClient, outbound: FakeHttp
) -> None:
    outbound.json_route("GET", "openrouter.ai/api/v1/models", {"error": "boom"}, status=500)
    body = (await client.get("/models", params={"provider": "openrouter", "task": "agent"})).json()
    assert body["models"] == []
    assert body["error"]


async def test_dedicated_model_becomes_verified_after_a_successful_transcription(
    client: httpx.AsyncClient, outbound: FakeHttp
) -> None:
    await client.put(
        "/settings",
        json={"provider_keys": {"openrouter": "sk-test"}, "asr": {"provider": "openrouter", "model": "qwen/qwen3-asr-1.7b"},
            "cloud_consent": True,
        },
    )
    created = await client.post("/sessions", json={"title": "Проверка"})
    outbound.json_route("POST", "audio/transcriptions", {"text": "Реальный текст."})
    await client.post(
        f"/sessions/{created.json()['id']}/audio",
        params={"sequence": 0, "start_ms": 0, "end_ms": 1000},
        content=make_wav(1.0),
        headers={"Content-Type": "audio/wav"},
    )
    body = (await client.get("/models", params={"provider": "openrouter", "task": "asr"})).json()
    model = body["models"][0]
    assert model["verified"] is True
    assert "verified" in model["note"].lower()


async def test_unknown_provider_or_task_is_rejected(client: httpx.AsyncClient) -> None:
    assert (await client.get("/models", params={"provider": "acme", "task": "asr"})).status_code == 422
    assert (
        await client.get("/models", params={"provider": "openrouter", "task": "dance"})
    ).status_code == 422


async def test_declared_non_text_output_is_excluded_from_text_tasks(client: httpx.AsyncClient) -> None:
    """Image-, audio- and video-only outputs cannot serve a text task, whatever they are called."""
    for task in TEXT_TASKS:
        models = _by_id((await client.get("/models", params={"provider": "openrouter", "task": task})).json())
        assert "some/image-only" not in models
        assert "some/audio-only" not in models
        assert "some/video-only" not in models
        assert "qwen/qwen3-asr-1.7b" not in models, "a transcription-only output is not text output"


async def test_multimodal_model_with_text_output_is_offered_for_text_tasks(
    client: httpx.AsyncClient,
) -> None:
    for task in TEXT_TASKS:
        models = _by_id((await client.get("/models", params={"provider": "openrouter", "task": task})).json())
        gemini = models["google/gemini-2.5-flash-lite"]
        assert gemini["input_modalities"] == ["text", "image", "audio"]
        assert gemini["output_modalities"] == ["text"]


async def test_undeclared_modalities_are_selectable_but_never_reported_as_text(
    client: httpx.AsyncClient,
) -> None:
    """Missing metadata is unknown capability: not invented text, not a fabricated rejection."""
    models = _by_id((await client.get("/models", params={"provider": "openrouter", "task": "agent"})).json())
    unknown = models["vendor/undeclared"]
    assert unknown["input_modalities"] == []
    assert unknown["output_modalities"] == []
    assert unknown["verified"] is False
    note = str(unknown["note"]).lower()
    assert "did not declare" in note and "unknown" in note


async def test_malformed_modality_metadata_is_unknown_and_keeps_the_rest_of_the_catalog(
    client: httpx.AsyncClient,
) -> None:
    models = _by_id((await client.get("/models", params={"provider": "openrouter", "task": "agent"})).json())
    for model_id in ("vendor/malformed", "vendor/broken-architecture"):
        assert models[model_id]["output_modalities"] == []
        assert models[model_id]["input_modalities"] == []
        assert "unknown" in str(models[model_id]["note"]).lower()
    assert models["qwen/qwen3-30b-a3b-instruct-2507"]["output_modalities"] == ["text"]


async def test_openai_catalog_never_claims_modalities_the_provider_did_not_declare(
    client: httpx.AsyncClient, outbound: FakeHttp, secrets: MemorySecretStore
) -> None:
    """OpenAI's /v1/models publishes no modality metadata, so none may be asserted."""
    secrets.set("openai", "sk-test")
    outbound.json_route(
        "GET",
        "api.openai.com/v1/models",
        {"data": [{"id": "gpt-4o"}, {"id": "dall-e-3"}, {"id": "whisper-1"}]},
    )
    text_models = _by_id(
        (await client.get("/models", params={"provider": "openai", "task": "agent"})).json()
    )
    assert text_models["gpt-4o"]["output_modalities"] == []
    assert text_models["dall-e-3"]["output_modalities"] == []
    assert "unknown" in str(text_models["gpt-4o"]["note"]).lower()
    assert "whisper-1" not in text_models, "the transcriptions endpoint is not a text contract"
    asr_models = _by_id((await client.get("/models", params={"provider": "openai", "task": "asr"})).json())
    assert set(asr_models) == {"whisper-1"}


async def test_disk_cached_catalog_keeps_undeclared_modalities_unknown(
    client: httpx.AsyncClient, config: AppConfig, secrets: MemorySecretStore
) -> None:
    """A catalog served from disk after a restart must not gain a text contract on the way."""
    assert (
        await client.get("/models", params={"provider": "openrouter", "task": "agent"})
    ).status_code == 200

    offline = FakeHttp()
    offline.json_route("GET", "openrouter.ai/api/v1/models", {"error": "offline"}, status=503)
    restarted = create_app(config, secret_store=secrets, http_client=offline.client())
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=restarted),
            base_url="http://127.0.0.1:8765",
            headers={"Authorization": f"Bearer {TOKEN}"},
        ) as second_client:
            body = (
                await second_client.get("/models", params={"provider": "openrouter", "task": "agent"})
            ).json()
    finally:
        restarted.state.runtime.close()
    assert body.get("error") is None
    models = _by_id(body)
    assert models["vendor/undeclared"]["output_modalities"] == []
    assert models["qwen/qwen3-30b-a3b-instruct-2507"]["output_modalities"] == ["text"]


async def test_disk_cache_without_the_current_schema_is_ignored(
    client: httpx.AsyncClient, outbound: FakeHttp, config: AppConfig
) -> None:
    """Older caches recorded a defaulted text output; replaying them would keep fabricating it."""
    (config.data_dir / "catalog-openrouter.json").write_text(
        json.dumps(
            [
                {
                    "id": "ghost/model",
                    "name": "Ghost",
                    "input_modalities": ["text"],
                    "output_modalities": ["text"],
                }
            ]
        ),
        "utf-8",
    )
    outbound.json_route("GET", "openrouter.ai/api/v1/models", {"error": "boom"}, status=500)
    body = (await client.get("/models", params={"provider": "openrouter", "task": "agent"})).json()
    assert body["models"] == []
    assert body["error"]


async def test_models_require_auth(client: httpx.AsyncClient) -> None:
    response = await client.get(
        "/models", params={"provider": "openrouter", "task": "asr"}, headers={"Authorization": ""}
    )
    assert response.status_code == 401
