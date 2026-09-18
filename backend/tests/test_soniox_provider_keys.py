"""The shared credential API preserves Soniox keys and protects cloud capture."""
from __future__ import annotations

import httpx

from audiohelper.secrets import MemorySecretStore


async def test_existing_soniox_key_uses_shared_api_without_reentry(
    client: httpx.AsyncClient, secrets: MemorySecretStore,
) -> None:
    secrets.set("soniox", "existing-fixture")
    current = await client.get("/settings")
    assert current.json()["provider_has_api_key"]["soniox"] is True
    assert "soniox_has_api_key" not in current.json()
    saved = await client.put("/settings", json={"provider_keys": {"soniox": "replacement-fixture"}})
    assert saved.status_code == 200
    assert saved.json()["provider_has_api_key"]["soniox"] is True
    assert saved.json()["cloud_consent"] is False
    assert "replacement-fixture" not in saved.text
    assert secrets.get("soniox") == "replacement-fixture"
    untouched = await client.put("/settings", json={"output_language": "en"})
    assert untouched.json()["provider_has_api_key"]["soniox"] is True
    removed = await client.put("/settings", json={"provider_keys": {"soniox": ""}})
    assert removed.status_code == 200
    assert removed.json()["provider_has_api_key"]["soniox"] is False
    assert secrets.get("soniox") is None


async def test_retired_soniox_key_field_is_not_silently_ignored(client: httpx.AsyncClient) -> None:
    response = await client.put("/settings", json={"soniox_api_key": "old-fixture"})
    assert response.status_code == 422
    assert "old-fixture" not in response.text
