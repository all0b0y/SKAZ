from __future__ import annotations

import httpx
import pytest

from audiohelper.secrets import MemorySecretStore
from tests.conftest import FakeHttp

CATALOG = {
    "data": [
        {
            "id": "google/gemini-2.5-flash-lite",
            "name": "Gemini 2.5 Flash Lite",
            "architecture": {"input_modalities": ["text", "image", "audio"], "output_modalities": ["text"]},
        },
        {
            "id": "qwen/qwen3-30b-a3b-instruct-2507",
            "name": "Qwen3 30B A3B Instruct",
            "architecture": {"input_modalities": ["text"], "output_modalities": ["text"]},
        },
        # Deliberately named so the rejection cannot be produced by a name heuristic.
        {
            "id": "vendor/aurora-3",
            "name": "Aurora 3",
            "architecture": {"input_modalities": ["text"], "output_modalities": ["image"]},
        },
        {"id": "vendor/undeclared", "name": "Undeclared modalities"},
    ]
}


@pytest.fixture(autouse=True)
def _catalog(outbound: FakeHttp) -> None:
    outbound.json_route("GET", "openrouter.ai/api/v1/models", CATALOG)


async def test_default_settings_shape(client: httpx.AsyncClient) -> None:
    body = (await client.get("/settings")).json()
    assert body["asr"]["provider"] == "local-whisper"
    assert body["asr"]["model"] == "small"
    assert body["agent"] == {
        "provider": "openrouter",
        "model": "",
        "base_url": None,
        "has_api_key": False,
        "verified": False,
        "verification_note": "Model is not configured.",
    }
    assert body["notes"]["provider"] == "openrouter"
    assert body["transcript_language"] == "auto"
    assert body["output_language"] == "ru"
    assert body["cloud_consent"] is False


async def test_put_updates_one_profile_and_keeps_others(client: httpx.AsyncClient) -> None:
    before = (await client.get("/settings")).json()
    response = await client.put(
        "/settings",
        json={"agent": {"provider": "openrouter", "model": "qwen/qwen3-30b-a3b-instruct-2507"}},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["agent"]["model"] == "qwen/qwen3-30b-a3b-instruct-2507"
    assert body["asr"] == before["asr"]
    assert body["notes"] == before["notes"]
    assert (await client.get("/settings")).json() == body


async def test_partial_profile_update_keeps_untouched_fields(client: httpx.AsyncClient) -> None:
    await client.put(
        "/settings",
        json={
            "notes": {
                "provider": "openai-compatible",
                "model": "local/model-a",
                "base_url": "http://127.0.0.1:1234/v1",
                "api_key": "secret-value",
            }
        },
    )
    body = (await client.put("/settings", json={"notes": {"model": "local/model-b"}})).json()
    assert body["notes"]["provider"] == "openai-compatible"
    assert body["notes"]["base_url"] == "http://127.0.0.1:1234/v1"
    assert body["notes"]["model"] == "local/model-b"
    assert body["notes"]["has_api_key"] is True


async def test_api_key_is_stored_in_secret_store_and_never_returned(
    client: httpx.AsyncClient, secrets: MemorySecretStore
) -> None:
    response = await client.put(
        "/settings",
        json={
            "agent": {
                "provider": "openrouter",
                "model": "qwen/qwen3-30b-a3b-instruct-2507",
                "api_key": "sk-live",
            }
        },
    )
    assert response.status_code == 200
    assert "sk-live" not in response.text
    assert "api_key" not in response.json()["agent"]
    assert response.json()["agent"]["has_api_key"] is True
    assert secrets.get("openrouter") == "sk-live"
    assert "sk-live" not in (await client.get("/settings")).text


async def test_three_profiles_are_independent(client: httpx.AsyncClient) -> None:
    await client.put("/settings", json={"asr": {"provider": "openai", "model": "whisper-1"}})
    await client.put("/settings", json={"agent": {"provider": "anthropic", "model": "claude-sonnet-4-5"}})
    body = (await client.put("/settings", json={"notes": {"model": "google/gemini-2.5-flash-lite"}})).json()
    assert body["asr"]["provider"] == "openai"
    assert body["asr"]["model"] == "whisper-1"
    assert body["asr"]["verified"] is False
    assert "no successful" in body["asr"]["verification_note"].lower()
    assert body["agent"]["provider"] == "anthropic"
    assert body["notes"]["provider"] == "openrouter"


async def test_rejects_text_only_model_for_asr(client: httpx.AsyncClient) -> None:
    response = await client.put(
        "/settings", json={"asr": {"provider": "openrouter", "model": "qwen/qwen3-30b-a3b-instruct-2507"}}
    )
    assert response.status_code == 400
    assert "audio" in response.json()["detail"].lower()
    assert (await client.get("/settings")).json()["asr"]["provider"] == "local-whisper"


async def test_rejects_anthropic_for_asr(client: httpx.AsyncClient) -> None:
    response = await client.put(
        "/settings", json={"asr": {"provider": "anthropic", "model": "claude-sonnet-4-5"}}
    )
    assert response.status_code == 400


async def test_rejects_local_whisper_for_agent(client: httpx.AsyncClient) -> None:
    response = await client.put("/settings", json={"agent": {"provider": "local-whisper", "model": "small"}})
    assert response.status_code == 400


async def test_rejects_unknown_openai_asr_model(client: httpx.AsyncClient) -> None:
    response = await client.put("/settings", json={"asr": {"provider": "openai", "model": "gpt-4o"}})
    assert response.status_code == 400


async def test_audio_input_model_is_accepted_but_flagged_unverified(client: httpx.AsyncClient) -> None:
    body = (
        await client.put(
            "/settings", json={"asr": {"provider": "openrouter", "model": "google/gemini-2.5-flash-lite"}}
        )
    ).json()
    assert body["asr"]["model"] == "google/gemini-2.5-flash-lite"
    assert body["asr"]["verified"] is False
    assert "audio input" in body["asr"]["verification_note"].lower()


async def test_local_whisper_default_is_not_claimed_verified(client: httpx.AsyncClient) -> None:
    body = (await client.get("/settings")).json()
    assert body["asr"]["verified"] is False
    assert body["asr"]["verification_note"]


async def test_rejects_model_without_text_output_naming_the_declared_modality(
    client: httpx.AsyncClient,
) -> None:
    """The refusal must quote the provider's declared output, not the model name."""
    for task in ("agent", "notes"):
        response = await client.put(
            "/settings", json={task: {"provider": "openrouter", "model": "vendor/aurora-3"}}
        )
        assert response.status_code == 400, response.text
        detail = response.json()["detail"].lower()
        assert "image" in detail and "text" in detail
    assert (await client.get("/settings")).json()["agent"]["model"] == ""


async def test_accepts_model_with_undeclared_modalities_as_unverified(client: httpx.AsyncClient) -> None:
    """Unknown capability is not proof of incompatibility, so the choice stays available."""
    body = (
        await client.put(
            "/settings", json={"agent": {"provider": "openrouter", "model": "vendor/undeclared"}}
        )
    ).json()
    assert body["agent"]["model"] == "vendor/undeclared"
    assert body["agent"]["verified"] is False
    assert "no successful" in body["agent"]["verification_note"].lower()


async def test_rejects_unknown_provider(client: httpx.AsyncClient) -> None:
    response = await client.put("/settings", json={"asr": {"provider": "acme", "model": "x"}})
    assert response.status_code == 422


@pytest.mark.parametrize("task", ["agent", "notes"])
async def test_custom_id_missing_from_catalog_remains_unverified(
    client: httpx.AsyncClient, task: str
) -> None:
    response = await client.put(
        "/settings", json={task: {"provider": "openrouter", "model": "private/Exact-ID"}}
    )
    assert response.status_code == 200
    profile = response.json()[task]
    assert profile["model"] == "private/Exact-ID"
    assert profile["verified"] is False
    assert "no successful" in profile["verification_note"].lower()
    assert (await client.get("/settings")).json()[task] == profile


async def test_updates_languages_and_consent(client: httpx.AsyncClient) -> None:
    body = (await client.put("/settings", json={"output_language": "en", "cloud_consent": True})).json()
    assert body["output_language"] == "en"
    assert body["cloud_consent"] is True
    assert body["transcript_language"] == "auto"
