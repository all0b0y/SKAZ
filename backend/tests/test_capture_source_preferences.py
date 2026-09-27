"""Capture-source preferences (microphone, system audio) persist like the recording mode."""
from __future__ import annotations

import httpx
import pytest
from starlette.testclient import TestClient

from skaz.app import create_app
from skaz.config import AppConfig
from skaz.secrets import MemorySecretStore
from tests.conftest import TOKEN, FakeHttp


async def test_defaults_are_default_microphone_without_system_audio(client: httpx.AsyncClient) -> None:
    settings = (await client.get("/settings")).json()
    assert settings["input_device_id"] is None
    assert settings["capture_system_audio"] is False


async def test_partial_updates_keep_each_other_and_empty_device_means_default(
    client: httpx.AsyncClient,
) -> None:
    saved = (await client.put("/settings", json={"input_device_id": "abc123"})).json()
    assert saved["input_device_id"] == "abc123"
    assert saved["capture_system_audio"] is False
    saved = (await client.put("/settings", json={"capture_system_audio": True})).json()
    assert saved["input_device_id"] == "abc123"
    assert saved["capture_system_audio"] is True
    saved = (await client.put("/settings", json={"output_language": "de"})).json()
    assert (saved["input_device_id"], saved["capture_system_audio"]) == ("abc123", True)
    saved = (await client.put("/settings", json={"input_device_id": ""})).json()
    assert saved["input_device_id"] is None
    assert saved["capture_system_audio"] is True


def test_capture_preferences_survive_restart(config: AppConfig, outbound: FakeHttp) -> None:
    headers = {"Authorization": f"Bearer {TOKEN}"}
    for restart in (False, True):
        application = create_app(config, secret_store=MemorySecretStore(), http_client=outbound.client())
        with TestClient(application, base_url="http://127.0.0.1", headers=headers) as http:
            if not restart:
                response = http.put("/settings", json={
                    "input_device_id": "usb-mic", "capture_system_audio": True,
                })
                assert response.status_code == 200, response.text
            settings = http.get("/settings").json()
            assert settings["input_device_id"] == "usb-mic"
            assert settings["capture_system_audio"] is True
    assert outbound.requests == []


@pytest.mark.parametrize("patch", [
    {"input_device_id": "x" * 513},
    {"input_device_id": 5},
    {"capture_system_audio": "yes"},
])
async def test_invalid_capture_preferences_do_not_partially_apply(
    client: httpx.AsyncClient, patch: dict[str, object],
) -> None:
    before = (await client.get("/settings")).json()
    response = await client.put("/settings", json={"output_language": "fr", **patch})
    assert response.status_code == 422, response.text
    assert (await client.get("/settings")).json() == before
