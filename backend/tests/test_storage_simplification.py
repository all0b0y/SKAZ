"""Removed storage features must not silently survive behind the old API."""
from __future__ import annotations

from typing import Any

import httpx


async def test_note_edits_keep_only_current_text_and_conflict_counter(
    client: httpx.AsyncClient, app: Any
) -> None:
    sid = (await client.post("/sessions", json={"title": "Fixture"})).json()["id"]
    note = (await client.post(f"/sessions/{sid}/notes/empty")).json()
    path = f"/sessions/{sid}/notes/{note['id']}"
    for revision in range(1, 4):
        response = await client.patch(
            path, json={"content": f"text {revision}", "expected_revision": revision}
        )
        assert response.status_code == 200
    assert (await client.patch(path, json={"content": "late", "expected_revision": 1})).status_code == 409
    assert (await client.get(path + "/history")).status_code == 404
    assert (
        await client.post(path + "/history/old/restore", json={"expected_revision": 4})
    ).status_code == 404
    with app.state.runtime.db.read() as db:
        assert db.execute("SELECT 1 FROM sqlite_master WHERE name='note_history'").fetchone() is None
        assert "deleted_at" not in {row["name"] for row in db.execute("PRAGMA table_info(notes)")}
    notes = (await client.get(f"/sessions/{sid}/notes")).json()["notes"]
    assert [(n["content"], n["revision"]) for n in notes] == [("text 3", 4)]


async def test_delete_is_permanent_and_session_scoped(client: httpx.AsyncClient, app: Any) -> None:
    sid = (await client.post("/sessions", json={"title": "Fixture"})).json()["id"]
    other = (await client.post("/sessions", json={"title": "Fixture"})).json()["id"]
    kept = (await client.post(f"/sessions/{sid}/notes/empty")).json()
    doomed = (await client.post(f"/sessions/{sid}/notes/empty")).json()
    assert (await client.delete(f"/sessions/{other}/notes/{doomed['id']}")).status_code == 404
    assert (await client.delete(f"/sessions/{sid}/notes/{doomed['id']}")).status_code == 200
    with app.state.runtime.db.read() as db:
        assert db.execute("SELECT 1 FROM notes WHERE id=?", (doomed["id"],)).fetchone() is None
        assert db.execute("SELECT 1 FROM notes WHERE id=?", (kept["id"],)).fetchone() is not None


async def test_legacy_deleted_notes_and_history_are_not_erased_or_resurrected(
    client: httpx.AsyncClient, app: Any
) -> None:
    sid = (await client.post("/sessions", json={"title": "Fixture"})).json()["id"]
    note = (await client.post(f"/sessions/{sid}/notes/empty")).json()
    with app.state.runtime.db.write() as db:
        if "deleted_at" not in {row["name"] for row in db.execute("PRAGMA table_info(notes)")}:
            db.execute("ALTER TABLE notes ADD COLUMN deleted_at TEXT")
        db.execute("UPDATE notes SET deleted_at='legacy' WHERE id=?", (note["id"],))
        db.execute(
            "CREATE TABLE IF NOT EXISTS note_history("
            "id TEXT PRIMARY KEY, note_id TEXT, snapshot TEXT, expires_at REAL)"
        )
        db.execute("INSERT INTO note_history VALUES ('old', ?, 'old text', 0)", (note["id"],))
    assert (await client.get(f"/sessions/{sid}/notes")).json()["notes"] == []
    assert (await client.get(f"/sessions/{sid}")).json()["notes"] is None
    with app.state.runtime.db.read() as db:
        assert db.execute("SELECT snapshot FROM note_history WHERE id='old'").fetchone()[0] == "old text"
        assert db.execute("SELECT deleted_at FROM notes WHERE id=?", (note["id"],)).fetchone()[0] == "legacy"
