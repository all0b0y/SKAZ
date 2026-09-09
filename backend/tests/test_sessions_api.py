from __future__ import annotations

import httpx


async def create(client: httpx.AsyncClient, title: str = "Lecture") -> dict[str, object]:
    response = await client.post("/sessions", json={"title": title})
    assert response.status_code == 200, response.text
    return response.json()  # type: ignore[no-any-return]


async def test_create_session_returns_contract_shape(client: httpx.AsyncClient) -> None:
    session = await create(client)
    assert set(session) >= {"id", "title", "created_at", "status", "duration_ms"}
    assert isinstance(session["id"], str) and session["id"]
    assert session["title"] == "Lecture"
    assert session["status"] == "recording"
    assert session["duration_ms"] == 0


async def test_list_sessions_is_newest_first(client: httpx.AsyncClient) -> None:
    first = await create(client, "one")
    second = await create(client, "two")
    listed = (await client.get("/sessions")).json()["sessions"]
    assert [item["id"] for item in listed] == [second["id"], first["id"]]


async def test_get_session_detail_of_empty_session(client: httpx.AsyncClient) -> None:
    session = await create(client)
    body = (await client.get(f"/sessions/{session['id']}")).json()
    assert body["session"]["id"] == session["id"]
    assert body["segments"] == []
    assert body["messages"] == []
    assert body["notes"] is None


async def test_patch_status_and_title(client: httpx.AsyncClient) -> None:
    session = await create(client)
    paused = (await client.patch(f"/sessions/{session['id']}", json={"status": "paused"})).json()
    assert paused["status"] == "paused"
    renamed = (await client.patch(f"/sessions/{session['id']}", json={"title": "Renamed"})).json()
    assert renamed["title"] == "Renamed"
    assert renamed["status"] == "paused"


async def test_patch_rejects_unknown_status(client: httpx.AsyncClient) -> None:
    session = await create(client)
    assert (await client.patch(f"/sessions/{session['id']}", json={"status": "flying"})).status_code == 422


async def test_unknown_session_is_404(client: httpx.AsyncClient) -> None:
    assert (await client.get("/sessions/missing")).status_code == 404
    assert (await client.patch("/sessions/missing", json={"title": "x"})).status_code == 404
    assert (await client.delete("/sessions/missing")).status_code == 404


async def test_delete_removes_session(client: httpx.AsyncClient) -> None:
    session = await create(client)
    response = await client.delete(f"/sessions/{session['id']}")
    assert response.status_code == 200
    assert response.json() == {"deleted": True}
    assert (await client.get(f"/sessions/{session['id']}")).status_code == 404
    assert (await client.get("/sessions")).json()["sessions"] == []


async def test_sessions_require_auth(client: httpx.AsyncClient) -> None:
    session = await create(client)
    for request in (
        client.get("/sessions", headers={"Authorization": ""}),
        client.get(f"/sessions/{session['id']}", headers={"Authorization": ""}),
        client.post("/sessions", json={"title": "x"}, headers={"Authorization": ""}),
    ):
        assert (await request).status_code == 401
