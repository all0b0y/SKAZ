"""Settings key regressions; only synthetic keys and injected stores/transports."""
from __future__ import annotations

from pathlib import Path

import httpx
import pytest

from audiohelper import secrets as secrets_module
from audiohelper.secrets import MemorySecretStore
from tests.conftest import FakeHttp


async def test_a_provider_key_storage_failure_is_sanitized(
    client: httpx.AsyncClient, secrets: MemorySecretStore, monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A keychain failure must not echo the key or the keychain path."""
    def fail(provider: str, value: str) -> None:
        raise OSError(f"private-keychain-path {value}")

    monkeypatch.setattr(secrets, "set", fail)
    response = await client.put("/settings", json={"provider_keys": {"openai": "sk-fixture-only"}})
    assert response.status_code == 503
    assert "sk-fixture-only" not in response.text + caplog.text
    assert "private-keychain-path" not in response.text + caplog.text
    assert (await client.get("/settings")).json()["provider_has_api_key"]["openai"] is False


def test_stored_keys_are_scoped_per_provider() -> None:
    """One provider's label must not stand for every provider's credential."""
    names = {p: secrets_module.service_name(p) for p in ("openai", "anthropic", "openrouter")}
    assert len(set(names.values())) == 3
    assert all(name.startswith(f"{secrets_module.SERVICE_NAME}:") for name in names.values())


def test_environment_keys_are_ignored_unless_explicitly_allowed(tmp_path: Path) -> None:
    """A normal desktop run must not pick a credential out of the ambient environment."""
    env = {"OPENAI_API_KEY": "env-fixture-only"}
    store = secrets_module.FileSecretStore(tmp_path / "secrets", env=env)
    assert secrets_module.env_fallback_enabled(env) is False
    assert store.get("openai") is None
    assert secrets_module.env_fallback_enabled(
        {**env, secrets_module.ENV_FALLBACK_FLAG: "1"}
    ) is True


async def test_soniox_key_is_write_only_and_independent_of_legacy_asr(
    client: httpx.AsyncClient, secrets: MemorySecretStore,
) -> None:
    before = (await client.get("/settings")).json()
    response = await client.put("/settings", json={"provider_keys": {"soniox": "soniox-fixture-only"}})
    assert response.status_code == 200
    assert response.json()["provider_has_api_key"]["soniox"] is True
    assert response.json()["cloud_consent"] is False
    assert response.json()["asr"] == before["asr"]
    assert "soniox-fixture-only" not in response.text
    assert secrets.get("soniox") == "soniox-fixture-only"
    untouched = await client.put("/settings", json={"output_language": "en"})
    assert untouched.json()["provider_has_api_key"]["soniox"] is True
    removed = await client.put("/settings", json={"provider_keys": {"soniox": ""}})
    assert removed.status_code == 200
    assert removed.json()["provider_has_api_key"]["soniox"] is False
    assert secrets.get("soniox") is None
    assert (await client.get("/settings")).json()["provider_has_api_key"]["soniox"] is False


async def test_soniox_key_storage_failure_is_sanitized(
    client: httpx.AsyncClient, secrets: MemorySecretStore, monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    def fail(provider: str, value: str) -> None:
        raise OSError(f"private-keychain-path {value}")
    monkeypatch.setattr(secrets, "set", fail)
    response = await client.put("/settings", json={"provider_keys": {"soniox": "secret-fixture-only"}})
    assert response.status_code == 503
    assert "secret-fixture-only" not in response.text + caplog.text
    assert "private-keychain-path" not in response.text + caplog.text
    assert (await client.get("/settings")).json()["provider_has_api_key"]["soniox"] is False
    invalid = await client.put("/settings", json={"provider_keys": {"soniox": ["secret-fixture-only"]}})
    assert invalid.status_code == 422
    assert "secret-fixture-only" not in invalid.text


async def test_first_key_validates_authenticated_catalog_before_persisting(
    client: httpx.AsyncClient, secrets: MemorySecretStore, outbound: FakeHttp
) -> None:
    @outbound.route("GET", "openrouter.ai/api/v1/models")
    def catalog(request: httpx.Request) -> httpx.Response:
        if request.headers.get("Authorization") != "Bearer new-test-key":
            return httpx.Response(401)
        return httpx.Response(200, json={"data": [{
            "id": "private/image-model", "architecture": {
                "input_modalities": ["text"], "output_modalities": ["image"]
            }
        }]})

    response = await client.put("/settings", json={"provider_keys": {"openrouter": "new-test-key"}, "agent": {
        "provider": "openrouter", "model": "private/image-model"}})
    assert response.status_code == 400
    assert secrets.get("openrouter") is None
    assert (await client.get("/settings")).json()["agent"]["model"] == ""



async def test_a_key_is_stored_per_provider_regardless_of_task_assignment(
    client: httpx.AsyncClient, secrets: MemorySecretStore
) -> None:
    """A credential can be saved for a provider no task uses yet, and removed again."""
    saved = await client.put("/settings", json={"provider_keys": {"anthropic": "ant-test-key"}})
    assert saved.status_code == 200
    assert saved.json()["provider_has_api_key"]["anthropic"] is True
    # No task was switched to anthropic by storing its key.
    assert saved.json()["agent"]["provider"] == "openrouter"
    assert secrets.get("anthropic") == "ant-test-key"
    assert "ant-test-key" not in saved.text

    removed = await client.put("/settings", json={"provider_keys": {"anthropic": ""}})
    assert removed.status_code == 200
    assert removed.json()["provider_has_api_key"]["anthropic"] is False
    assert secrets.get("anthropic") is None


async def test_one_key_serves_every_task_on_that_provider(
    client: httpx.AsyncClient, secrets: MemorySecretStore
) -> None:
    """Two tasks on one provider share a single stored credential, not two copies."""
    response = await client.put("/settings", json={
        "provider_keys": {"anthropic": "shared-test-key"},
        "agent": {"provider": "anthropic", "model": "claude-sonnet-4-5"},
        "notes": {"provider": "anthropic", "model": "claude-sonnet-4-5"},
    })
    assert response.status_code == 200
    assert response.json()["provider_has_api_key"]["anthropic"] is True
    assert secrets.get("anthropic") == "shared-test-key"
    assert "shared-test-key" not in response.text


async def test_a_local_provider_has_no_key_slot(client: httpx.AsyncClient) -> None:
    rejected = await client.put(
        "/settings", json={"provider_keys": {"local-whisper": "must-not-be-stored"}}
    )
    assert rejected.status_code == 422
    assert "must-not-be-stored" not in rejected.text
