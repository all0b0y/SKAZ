"""Supported-language discovery, as the transcript and answer pickers read it.

``GET /languages`` answers one question honestly: which languages can *this*
installation claim for the selected provider and exact model ID?

* A faster-whisper checkpoint and an OpenAI transcription model have documented
  language sets, listed per checkpoint / per model, never inferred from a name.
* Anything else — another provider, an undocumented model, a checkpoint this
  build does not know — returns an empty list with an explicit reason. A
  fabricated list would be worse than no list.
* ``auto`` (let the model detect the language) is always offered for the
  transcript, and is never one of the claimed languages.
* The answer/notes language is a separate, provider-independent list. It is a
  request made to a text model, never evidence of an ASR capability.
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from tests.conftest import TOKEN, FakeHttp

ASR_MODEL = "qwen/qwen3-asr-1.7b"

CATALOG = {
    "data": [
        {
            "id": ASR_MODEL,
            "architecture": {"input_modalities": ["audio"], "output_modalities": ["transcription"]},
        }
    ]
}


@pytest.fixture(autouse=True)
def _catalog(outbound: FakeHttp) -> None:
    outbound.json_route("GET", "openrouter.ai/api/v1/models", CATALOG)


async def languages(client: httpx.AsyncClient, **params: Any) -> dict[str, Any]:
    response = await client.get("/languages", params=params)
    assert response.status_code == 200, response.text
    payload: dict[str, Any] = response.json()
    assert set(payload) == {"task", "provider", "model", "auto", "languages", "basis", "reason"}
    assert payload["reason"], "every answer explains where its list comes from"
    for option in payload["languages"]:
        assert set(option) == {"code", "name"}
        assert option["code"] and option["name"]
    return payload


def codes(payload: dict[str, Any]) -> list[str]:
    return [option["code"] for option in payload["languages"]]


# --- local faster-whisper checkpoints ------------------------------------------------


async def test_a_multilingual_checkpoint_lists_the_documented_whisper_languages(
    client: httpx.AsyncClient,
) -> None:
    payload = await languages(client, provider="local-whisper", model="small", task="asr")
    assert payload["basis"] == "documented"
    assert payload["provider"] == "local-whisper"
    assert payload["model"] == "small"
    assert len(codes(payload)) == 99
    assert {"ru", "en", "de", "uk", "kk"} <= set(codes(payload))
    assert "yue" not in codes(payload), "Cantonese arrived only with large-v3"


async def test_large_v3_checkpoints_add_the_language_they_actually_gained(
    client: httpx.AsyncClient,
) -> None:
    for model in ("large-v3", "large-v3-turbo"):
        payload = await languages(client, provider="local-whisper", model=model)
        assert payload["basis"] == "documented"
        assert len(codes(payload)) == 100
        assert "yue" in codes(payload)


@pytest.mark.parametrize("model", ["distil-small.en", "distil-large-v3"])
async def test_an_english_only_checkpoint_claims_only_english(
    client: httpx.AsyncClient, model: str
) -> None:
    payload = await languages(client, provider="local-whisper", model=model)
    assert payload["basis"] == "documented"
    assert codes(payload) == ["en"]


async def test_an_unknown_checkpoint_claims_nothing(client: httpx.AsyncClient) -> None:
    payload = await languages(client, provider="local-whisper", model="large-v9-turbo")
    assert payload["basis"] == "unknown"
    assert payload["languages"] == []
    assert "large-v9-turbo" in payload["reason"]


async def test_every_offered_local_checkpoint_has_a_documented_language_set(
    client: httpx.AsyncClient,
) -> None:
    catalog = await client.get("/models", params={"provider": "local-whisper", "task": "asr"})
    assert catalog.status_code == 200, catalog.text
    offered = [model["id"] for model in catalog.json()["models"]]
    assert offered, "the local catalog is not empty"
    for model in offered:
        payload = await languages(client, provider="local-whisper", model=model)
        assert payload["basis"] == "documented", model
        assert payload["languages"], model


# --- OpenAI transcription models -----------------------------------------------------


@pytest.mark.parametrize("model", ["whisper-1", "gpt-4o-transcribe", "gpt-4o-mini-transcribe"])
async def test_a_documented_openai_transcription_model_lists_its_documented_languages(
    client: httpx.AsyncClient, model: str
) -> None:
    payload = await languages(client, provider="openai", model=model)
    assert payload["basis"] == "documented"
    assert len(codes(payload)) == 57
    assert {"ru", "en", "uk"} <= set(codes(payload))
    assert "openai" in payload["reason"].lower()


@pytest.mark.parametrize("model", ["gpt-4o", "gpt-4o-audio-preview", "o3", "whisper-2"])
async def test_an_openai_model_outside_the_documented_endpoint_claims_nothing(
    client: httpx.AsyncClient, model: str
) -> None:
    """A transcription-sounding name is not evidence of a transcription contract."""
    payload = await languages(client, provider="openai", model=model)
    assert payload["basis"] == "unknown"
    assert payload["languages"] == []


# --- providers with no published language set ----------------------------------------


@pytest.mark.parametrize(
    ("provider", "model"),
    [
        ("openrouter", ASR_MODEL),
        ("openrouter", "google/gemini-2.5-flash-lite"),
        ("openai-compatible", "whisper-1"),
        ("anthropic", "claude-test-1"),
    ],
)
async def test_a_provider_without_a_published_language_set_returns_an_explicit_unknown(
    client: httpx.AsyncClient, provider: str, model: str
) -> None:
    payload = await languages(client, provider=provider, model=model)
    assert payload["basis"] == "unknown"
    assert payload["languages"] == []
    assert provider in payload["reason"]


async def test_a_model_that_was_not_named_is_not_guessed(client: httpx.AsyncClient) -> None:
    payload = await languages(client, provider="openai", task="asr")
    assert payload["basis"] == "unknown"
    assert payload["languages"] == []
    assert payload["model"] is None


# --- the auto option -----------------------------------------------------------------


@pytest.mark.parametrize(
    ("provider", "model"),
    [("local-whisper", "small"), ("openai", "whisper-1"), ("openrouter", ASR_MODEL)],
)
async def test_auto_is_offered_for_every_transcript_answer(
    client: httpx.AsyncClient, provider: str, model: str
) -> None:
    payload = await languages(client, provider=provider, model=model)
    assert payload["auto"] == {"code": "auto", "name": payload["auto"]["name"]}
    assert payload["auto"]["name"]


@pytest.mark.parametrize("model", ["small", "large-v3", "distil-large-v3"])
async def test_auto_is_never_one_of_the_claimed_languages(
    client: httpx.AsyncClient, model: str
) -> None:
    payload = await languages(client, provider="local-whisper", model=model)
    assert "auto" not in codes(payload)


# --- the installation's own configuration --------------------------------------------


async def test_without_arguments_the_configured_asr_profile_is_described(
    client: httpx.AsyncClient,
) -> None:
    configured = await client.put("/settings", json={"asr": {"provider": "local-whisper", "model": "medium"}})
    assert configured.status_code == 200, configured.text

    payload = await languages(client)
    assert payload["task"] == "asr"
    assert (payload["provider"], payload["model"]) == ("local-whisper", "medium")
    assert payload["basis"] == "documented"
    assert len(codes(payload)) == 99


async def test_a_provider_asked_about_without_a_model_does_not_borrow_the_stored_one(
    client: httpx.AsyncClient,
) -> None:
    configured = await client.put("/settings", json={"asr": {"provider": "local-whisper", "model": "medium"}})
    assert configured.status_code == 200, configured.text

    payload = await languages(client, provider="openai")
    assert payload["basis"] == "unknown"
    assert payload["model"] is None


# --- the answer / notes language is a different question ------------------------------


async def test_the_output_language_list_is_independent_of_the_asr_provider(
    client: httpx.AsyncClient,
) -> None:
    plain = await languages(client, task="output")
    with_provider = await languages(client, task="output", provider="local-whisper", model="distil-large-v3")
    assert plain == with_provider, "the answer language does not depend on the ASR model"
    assert plain["provider"] is None and plain["model"] is None


async def test_the_output_language_list_is_never_presented_as_a_verified_capability(
    client: httpx.AsyncClient,
) -> None:
    payload = await languages(client, task="output")
    assert payload["basis"] == "requested"
    assert payload["languages"], "the picker still has something to offer"
    assert {"ru", "en"} <= set(codes(payload))
    assert payload["auto"] is None, "the answer language is always explicit"


async def test_an_english_only_transcript_model_does_not_narrow_the_answer_language(
    client: httpx.AsyncClient,
) -> None:
    configured = await client.put(
        "/settings", json={"asr": {"provider": "local-whisper", "model": "distil-small.en"}}
    )
    assert configured.status_code == 200, configured.text

    transcript = await languages(client, task="asr")
    assert codes(transcript) == ["en"]
    assert "ru" in codes(await languages(client, task="output"))


# --- request validation ---------------------------------------------------------------


@pytest.mark.parametrize("task", ["agent", "notes", "", "ASR"])
async def test_a_task_this_endpoint_does_not_answer_is_rejected(
    client: httpx.AsyncClient, task: str
) -> None:
    response = await client.get("/languages", params={"task": task})
    assert response.status_code == 422


async def test_an_unknown_provider_is_rejected(client: httpx.AsyncClient) -> None:
    response = await client.get("/languages", params={"provider": "acme-speech", "task": "asr"})
    assert response.status_code == 422


async def test_languages_require_the_local_token(app: Any) -> None:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8765"
    ) as anonymous:
        response = await anonymous.get("/languages", params={"task": "asr"})
    assert response.status_code == 401
    assert TOKEN not in response.text
