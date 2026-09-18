"""Persisted next-recording preferences through the public settings API."""
from __future__ import annotations

import json
import sqlite3

import httpx
import pytest
from starlette.testclient import TestClient

from audiohelper.app import create_app
from audiohelper.config import AppConfig
from audiohelper.secrets import MemorySecretStore
from tests.conftest import TOKEN, FakeHttp


async def test_recording_preferences_are_independent_and_partial_updates_preserve_them(
    client: httpx.AsyncClient,
) -> None:
    before = (await client.get("/settings")).json()
    assert before["native_recording_mode"] == "transcription"
    assert before["translation_target_language"] == "ru"
    saved = await client.put("/settings", json={
        "native_recording_mode": "translation", "translation_target_language": "en",
    })
    assert saved.status_code == 200, saved.text
    assert saved.json()["native_recording_mode"] == "translation"
    assert saved.json()["translation_target_language"] == "en"
    assert saved.json()["cloud_consent"] is False
    assert saved.json()["transcript_language"] == before["transcript_language"]
    assert saved.json()["output_language"] == before["output_language"]
    assert saved.json()["asr"] == before["asr"]
    for patch in ({"output_language": "de"}, {
        "native_recording_mode": None, "translation_target_language": None,
    }):
        response = await client.put("/settings", json=patch)
        assert response.status_code == 200
        assert response.json()["native_recording_mode"] == "translation"
        assert response.json()["translation_target_language"] == "en"
    assert (await client.get("/settings")).json()["translation_target_language"] == "en"


@pytest.mark.parametrize("mode", ["transcription", "translation", "audio_only"])
def test_recording_preferences_survive_restart_without_network_or_enabling_consent(
    config: AppConfig, outbound: FakeHttp, mode: str,
) -> None:
    headers = {"Authorization": f"Bearer {TOKEN}"}
    for restart in (False, True):
        application = create_app(
            config, secret_store=MemorySecretStore(), http_client=outbound.client(),
        )
        with TestClient(application, base_url="http://127.0.0.1", headers=headers) as http:
            if not restart:
                response = http.put("/settings", json={
                    "native_recording_mode": mode, "translation_target_language": "de",
                    "used_languages": ["ru", "en"],
                })
                assert response.status_code == 200, response.text
            settings = http.get("/settings").json()
            assert settings["native_recording_mode"] == mode
            assert settings["translation_target_language"] == "de"
            assert settings["used_languages"] == ["ru", "en"]
            assert settings["cloud_consent"] is False
    assert outbound.requests == []


def test_old_settings_document_gets_defaults_without_losing_existing_values(
    config: AppConfig, outbound: FakeHttp,
) -> None:
    # A pre-migration settings document: fixture setup, not a storage-side assertion.
    config.data_dir.mkdir(parents=True)
    with sqlite3.connect(config.db_path) as db:
        db.execute("CREATE TABLE app_settings (id INTEGER PRIMARY KEY, doc TEXT NOT NULL)")
        db.execute("INSERT INTO app_settings VALUES (1, ?)", (json.dumps({
            "asr": {"provider": "local-whisper", "model": "small"},
            "agent": {"provider": "openrouter", "model": ""},
            "notes": {"provider": "openrouter", "model": ""},
            "transcript_language": "fr", "output_language": "de", "cloud_consent": False,
        }),))
    application = create_app(
        config, secret_store=MemorySecretStore(), http_client=outbound.client(),
    )
    with TestClient(application, base_url="http://127.0.0.1", headers={
        "Authorization": f"Bearer {TOKEN}",
    }) as http:
        settings = http.get("/settings").json()
        assert settings["native_recording_mode"] == "transcription"
        assert settings["translation_target_language"] == "ru"
        assert settings["transcript_language"] == "fr"
        assert settings["used_languages"] is None
        assert settings["output_language"] == "de"
        assert settings["cloud_consent"] is False
    assert outbound.requests == []


def test_a_retired_provider_in_a_stored_profile_does_not_break_startup(
    config: AppConfig, outbound: FakeHttp,
) -> None:
    """A profile saved on a since-removed provider falls back instead of crashing.

    The user is asked to pick a model again rather than being locked out of settings.
    """
    config.data_dir.mkdir(parents=True)
    with sqlite3.connect(config.db_path) as db:
        db.execute("CREATE TABLE app_settings (id INTEGER PRIMARY KEY, doc TEXT NOT NULL)")
        db.execute("INSERT INTO app_settings VALUES (1, ?)", (json.dumps({
            "asr": {"provider": "local-whisper", "model": "small"},
            "agent": {
                "provider": "openai-compatible",
                "model": "local/model-a",
                "base_url": "http://127.0.0.1:1234/v1",
            },
            "notes": {"provider": "openrouter", "model": ""},
            "transcript_language": "auto", "output_language": "ru", "cloud_consent": False,
        }),))
    application = create_app(
        config, secret_store=MemorySecretStore(), http_client=outbound.client(),
    )
    with TestClient(application, base_url="http://127.0.0.1", headers={
        "Authorization": f"Bearer {TOKEN}",
    }) as http:
        settings = http.get("/settings").json()
        assert settings["agent"]["provider"] == "openrouter"
        assert settings["agent"]["model"] == ""
        assert "base_url" not in settings["agent"]
        # Untouched profiles keep their stored values.
        assert settings["asr"]["provider"] == "local-whisper"
    assert outbound.requests == []


async def test_changing_mode_keeps_the_last_target_language(client: httpx.AsyncClient) -> None:
    response = await client.put("/settings", json={
        "native_recording_mode": "translation", "translation_target_language": "pt-BR",
    })
    assert response.status_code == 200
    for mode in ("audio_only", "transcription", "translation"):
        response = await client.put("/settings", json={"native_recording_mode": mode})
        assert response.status_code == 200
        assert response.json()["native_recording_mode"] == mode
        assert response.json()["translation_target_language"] == "pt-BR"


@pytest.mark.parametrize("patch", [
    {"native_recording_mode": "legacy"},
    {"native_recording_mode": ""},
    {"native_recording_mode": True},
    {"translation_target_language": ""},
    {"translation_target_language": "auto"},
    {"translation_target_language": "EN"},
    {"translation_target_language": " en"},
    {"translation_target_language": "en\n"},
    {"translation_target_language": "en-"},
    {"translation_target_language": "en" + "-abcdefgh" * 4},
    {"translation_target_language": ["en"]},
])
async def test_invalid_recording_preferences_do_not_partially_apply(
    client: httpx.AsyncClient, patch: dict[str, object],
) -> None:
    before = (await client.get("/settings")).json()
    response = await client.put("/settings", json={"output_language": "fr", **patch})
    assert response.status_code == 422, response.text
    assert (await client.get("/settings")).json() == before
