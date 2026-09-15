"""Settings key regressions; only synthetic keys and injected stores/transports."""
from __future__ import annotations

import httpx
import pytest

from audiohelper.secrets import MemorySecretStore
from tests.conftest import FakeHttp


async def test_soniox_key_is_write_only_and_independent_of_legacy_asr(
    client: httpx.AsyncClient, secrets: MemorySecretStore,
) -> None:
    before = (await client.get("/settings")).json()
    response = await client.put("/settings", json={"soniox_api_key": "soniox-fixture-only"})
    assert response.status_code == 200
    assert response.json()["soniox_has_api_key"] is True
    assert response.json()["cloud_consent"] is False
    assert response.json()["asr"] == before["asr"]
    assert "soniox-fixture-only" not in response.text
    assert secrets.get("soniox") == "soniox-fixture-only"
    untouched = await client.put("/settings", json={"output_language": "en"})
    assert untouched.json()["soniox_has_api_key"] is True
    removed = await client.put("/settings", json={"soniox_api_key": ""})
    assert removed.status_code == 200
    assert removed.json()["soniox_has_api_key"] is False
    assert secrets.get("soniox") is None
    assert (await client.get("/settings")).json()["soniox_has_api_key"] is False


async def test_soniox_key_storage_failure_is_sanitized(
    client: httpx.AsyncClient, secrets: MemorySecretStore, monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    def fail(provider: str, value: str) -> None:
        raise OSError(f"private-keychain-path {value}")
    monkeypatch.setattr(secrets, "set", fail)
    response = await client.put("/settings", json={"soniox_api_key": "secret-fixture-only"})
    assert response.status_code == 503
    assert "secret-fixture-only" not in response.text + caplog.text
    assert "private-keychain-path" not in response.text + caplog.text
    assert (await client.get("/settings")).json()["soniox_has_api_key"] is False
    invalid = await client.put("/settings", json={"soniox_api_key": ["secret-fixture-only"]})
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

    response = await client.put("/settings", json={"agent": {
        "provider": "openrouter", "model": "private/image-model", "api_key": "new-test-key"
    }})
    assert response.status_code == 400
    assert secrets.get("openrouter") is None
    assert (await client.get("/settings")).json()["agent"]["model"] == ""



@pytest.mark.parametrize("second", ["other-test-key", ""])
async def test_conflicting_provider_keys_are_rejected_without_mutation(
    client: httpx.AsyncClient, secrets: MemorySecretStore, second: str
) -> None:
    secrets.set("openrouter", "original-test-key")
    before = (await client.get("/settings")).json()
    response = await client.put("/settings", json={
        "agent": {"api_key": "new-test-key"}, "notes": {"api_key": second},
        "output_language": "en",
    })
    assert response.status_code == 400
    assert secrets.get("openrouter") == "original-test-key"
    assert (await client.get("/settings")).json() == before
    assert "new-test-key" not in response.text
