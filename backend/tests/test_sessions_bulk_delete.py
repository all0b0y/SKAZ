"""Bulk session deletion: each id is deleted independently and reported."""
from __future__ import annotations

from dataclasses import replace
from pathlib import Path

import httpx
import pytest

from audiohelper.config import AppConfig


@pytest.fixture
def config(tmp_path: Path) -> AppConfig:
    return replace(AppConfig(token="test-token", data_dir=tmp_path / "data"),
                   session_files_root=tmp_path / "files")


async def create(client: httpx.AsyncClient, title: str) -> str:
    response = await client.post("/sessions", json={"title": title})
    assert response.status_code == 200, response.text
    return str(response.json()["id"])


async def listed(client: httpx.AsyncClient) -> set[str]:
    return {item["id"] for item in (await client.get("/sessions")).json()["sessions"]}


async def test_bulk_delete_removes_every_session(client: httpx.AsyncClient) -> None:
    ids = [await create(client, f"s{n}") for n in range(3)]
    keep = await create(client, "keep")
    response = await client.post("/sessions/delete", json={"ids": ids})
    assert response.status_code == 200, response.text
    assert response.json() == {"deleted": ids, "failed": []}
    assert await listed(client) == {keep}


async def test_bulk_delete_reports_each_failure_and_continues(
    client: httpx.AsyncClient, config: AppConfig,
) -> None:
    first = await create(client, "first")
    blocked = await create(client, "blocked")
    last = await create(client, "last")
    (await client.post(f"/sessions/{blocked}/files")).raise_for_status()
    assert config.session_files_root is not None
    (config.session_files_root / "Ungrouped" / blocked / "personal.txt").write_text("mine")

    body = (await client.post("/sessions/delete",
                              json={"ids": [first, "missing", blocked, last]})).json()

    assert body["deleted"] == [first, last]
    failed = {item["id"]: item["reason"] for item in body["failed"]}
    assert set(failed) == {"missing", blocked}
    assert "does not exist" in failed["missing"]
    assert "Markdown files need attention" in failed[blocked]
    assert await listed(client) == {blocked}


async def test_bulk_delete_ignores_duplicate_ids(client: httpx.AsyncClient) -> None:
    sid = await create(client, "one")
    body = (await client.post("/sessions/delete", json={"ids": [sid, sid]})).json()
    assert body == {"deleted": [sid], "failed": []}


@pytest.mark.parametrize("ids", [[], ["x"] * 1001])
async def test_bulk_delete_validates_size(client: httpx.AsyncClient, ids: list[str]) -> None:
    assert (await client.post("/sessions/delete", json={"ids": ids})).status_code == 422


async def test_bulk_delete_requires_auth(client: httpx.AsyncClient) -> None:
    response = await client.post("/sessions/delete", json={"ids": ["x"]},
                                 headers={"Authorization": ""})
    assert response.status_code == 401
