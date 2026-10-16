"""A recording's technical session: created by managed storage, patched by the recorder, deleted by
the speech area. The list/detail/create/delete routes of the old interface are gone; only
``PATCH /sessions/{id}`` (the recorder's status fallback) remains on HTTP."""
from __future__ import annotations

import httpx
import pytest
from fastapi import HTTPException

from tests.sessions_support import adelete, create_session, get_session, session_detail, session_gone


async def test_created_session_has_the_contract_shape(client: httpx.AsyncClient) -> None:
    session = get_session(client, create_session(client, "Lecture"))
    assert session is not None
    assert session.id and session.title == "Lecture"
    assert session.status == "recording"
    assert session.duration_ms == 0
    assert session.mode == "legacy"


async def test_detail_of_an_empty_session(client: httpx.AsyncClient) -> None:
    sid = create_session(client)
    body = session_detail(client, sid)
    assert body is not None
    assert body["session"]["id"] == sid
    assert body["segments"] == []


async def test_patch_status_and_title(client: httpx.AsyncClient) -> None:
    sid = create_session(client)
    paused = (await client.patch(f"/sessions/{sid}", json={"status": "paused"})).json()
    assert paused["status"] == "paused"
    renamed = (await client.patch(f"/sessions/{sid}", json={"title": "Renamed"})).json()
    assert renamed["title"] == "Renamed"
    assert renamed["status"] == "paused"


async def test_patch_rejects_unknown_status(client: httpx.AsyncClient) -> None:
    sid = create_session(client)
    assert (await client.patch(f"/sessions/{sid}", json={"status": "flying"})).status_code == 422


async def test_unknown_session_is_404(client: httpx.AsyncClient) -> None:
    assert (await client.patch("/sessions/missing", json={"title": "x"})).status_code == 404
    with pytest.raises(HTTPException) as missing:
        await adelete(client, "missing")
    assert missing.value.status_code == 404


async def test_delete_removes_session(client: httpx.AsyncClient) -> None:
    sid = create_session(client)
    await adelete(client, sid)
    assert session_gone(client, sid)


async def test_patch_requires_auth(client: httpx.AsyncClient) -> None:
    sid = create_session(client)
    response = await client.patch(f"/sessions/{sid}", json={"title": "x"}, headers={"Authorization": ""})
    assert response.status_code == 401
