from __future__ import annotations

import httpx

from tests.conftest import TOKEN


async def test_health_needs_no_auth(client: httpx.AsyncClient) -> None:
    response = await client.get("/health", headers={"Authorization": ""})
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


async def test_protected_route_without_token_is_401(client: httpx.AsyncClient) -> None:
    response = await client.get("/settings", headers={"Authorization": ""})
    assert response.status_code == 401
    assert isinstance(response.json()["detail"], str)


async def test_protected_route_with_wrong_token_is_401(client: httpx.AsyncClient) -> None:
    response = await client.get("/settings", headers={"Authorization": "Bearer nope"})
    assert response.status_code == 401


async def test_protected_route_with_token_is_200(client: httpx.AsyncClient) -> None:
    assert (await client.get("/settings")).status_code == 200


async def test_foreign_origin_is_rejected(client: httpx.AsyncClient) -> None:
    response = await client.get("/settings", headers={"Origin": "https://evil.example"})
    assert response.status_code == 403


async def test_local_origins_are_allowed(client: httpx.AsyncClient) -> None:
    for origin in ("null", "file://", "http://localhost:5173", "http://127.0.0.1:5173"):
        response = await client.get("/settings", headers={"Origin": origin})
        assert response.status_code == 200, origin


async def test_non_loopback_host_header_is_rejected(client: httpx.AsyncClient) -> None:
    response = await client.get("/settings", headers={"Host": "audiohelper.example"})
    assert response.status_code == 403


async def test_health_is_reachable_with_bearer_token(client: httpx.AsyncClient) -> None:
    response = await client.get("/health", headers={"Authorization": f"Bearer {TOKEN}"})
    assert response.status_code == 200
