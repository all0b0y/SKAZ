"""Public model API regressions for exact identifiers and safe failures."""

import httpx
import pytest

from audiohelper.secrets import MemorySecretStore
from tests.conftest import FakeHttp


@pytest.mark.parametrize("provider", ["openai", "anthropic", "openrouter"])
async def test_catalog_preserves_exact_model_id(
    client: httpx.AsyncClient, outbound: FakeHttp, secrets: MemorySecretStore, provider: str
) -> None:
    secrets.set(provider, "test")
    host = {"openai": "api.openai.com", "anthropic": "api.anthropic.com", "openrouter": "openrouter.ai/api"}
    outbound.json_route("GET", f"{host[provider]}/v1/models", {"data": [{"id": " vendor/Exact-ID "}]})
    response = await client.get("/models", params={"provider": provider, "task": "agent"})
    assert response.status_code == 200
    assert response.json()["models"][0]["id"] == " vendor/Exact-ID "


async def test_catalog_transport_failure_does_not_echo_exception(
    client: httpx.AsyncClient, outbound: FakeHttp
) -> None:
    def fail(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("PRIVATE_TRANSCRIPT fake-credential", request=request)

    outbound.routes[("GET", "openrouter.ai/api/v1/models")] = fail
    response = await client.get("/models", params={"provider": "openrouter", "task": "agent"})
    assert response.status_code == 200
    message = response.json()["error"]
    assert "PRIVATE_TRANSCRIPT" not in message
    assert "fake-credential" not in message
    assert "unavailable" in message


@pytest.mark.parametrize("task", ["agent", "notes"])
async def test_known_openai_transcription_model_cannot_be_saved_for_text(
    client: httpx.AsyncClient, task: str
) -> None:
    response = await client.put(
        "/settings", json={task: {"provider": "openai", "model": "whisper-1"}}
    )
    assert response.status_code == 400
    assert "transcription" in response.json()["detail"]
    assert (await client.get("/settings")).json()[task]["model"] == ""
