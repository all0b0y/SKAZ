"""Notification feed of API-B2 §1.1: seq cursor, long poll, read marks, actions and resolving."""

from __future__ import annotations

import asyncio
import sqlite3
import time
from pathlib import Path
from typing import Any

import httpx

from skaz.knowledge.service import KnowledgeService
from skaz.knowledge.store.database import KnowledgeDatabase
from skaz.knowledge.store.schema import MODULES


async def connect(kb_client: httpx.AsyncClient) -> None:
    assert (await kb_client.post("/kb/library", json={})).json()["state"] == "ready"


async def test_feed_shape_counters_and_material_subject(kb_app: Any, kb_client: httpx.AsyncClient) -> None:
    await connect(kb_client)
    kb: KnowledgeService = kb_app.state.runtime.kb
    # S1 and W1 raise their kinds without a subject: a material id in the payload becomes the subject.
    excluded = kb.notify(
        "excluded_instruction",
        "Instruction for AI found in a source — excluded",
        payload={"material_id": "mat-1", "items": []},
    )
    blocked = kb.notify("blocked_output", "Kept out of the wiki", payload={"material_id": "mat-2"})
    plain = kb.notify("material_ready", "Ready")

    feed = (await kb_client.get("/kb/notifications")).json()
    assert set(feed) == {"items", "cursor", "unread", "requires_action"}
    assert [item["id"] for item in feed["items"]] == [plain.id, blocked.id, excluded.id]
    assert feed["cursor"] == max(item["seq"] for item in feed["items"]) == 3
    assert feed["unread"] == 3 and feed["requires_action"] == 0
    by_id = {item["id"]: item for item in feed["items"]}
    assert by_id[excluded.id]["subject"] == {"type": "material", "id": "mat-1", "block_id": None, "seg": None}
    assert by_id[excluded.id]["actions"] == [
        {"id": "open_material", "label": "Open material", "primary": False, "needs_text": False}
    ]
    assert by_id[blocked.id]["actions"][0]["id"] == "open_material"
    assert by_id[plain.id]["subject"] is None and by_id[plain.id]["actions"] == []
    assert by_id[excluded.id]["resolved_at"] is None and by_id[excluded.id]["resolution"] is None
    # The texts and payloads of the other areas are unchanged.
    assert by_id[excluded.id]["payload"] == {"material_id": "mat-1", "items": []}

    # "Open material" only navigates: valid any time, never resolves.
    opened = await kb_client.post(
        f"/kb/notifications/{excluded.id}/resolve", json={"action": "open_material"}
    )
    assert opened.status_code == 200 and opened.json()["resolved_at"] is None


async def test_read_marks_and_dismiss_move_the_cursor(kb_app: Any, kb_client: httpx.AsyncClient) -> None:
    await connect(kb_client)
    kb: KnowledgeService = kb_app.state.runtime.kb
    first = kb.notify("material_ready", "One")
    second = kb.notify("discrepancy", "Two", requires_action=True)
    feed = (await kb_client.get("/kb/notifications")).json()
    assert feed["unread"] == 2 and feed["requires_action"] == 1

    assert (await kb_client.post("/kb/notifications/read", json={"up_to_seq": first.seq})).status_code == 204
    feed = (await kb_client.get("/kb/notifications")).json()
    assert feed["unread"] == 1
    assert (await kb_client.post("/kb/notifications/read", json={"up_to_seq": -1})).status_code == 422

    cursor = feed["cursor"]
    dismissed = (await kb_client.post(f"/kb/notifications/{second.id}/dismiss")).json()
    assert dismissed["dismissed_at"] is not None and dismissed["seq"] > cursor
    delta = (await kb_client.get("/kb/notifications", params={"after": cursor})).json()
    # The change since the cursor includes the dismissed one, so the UI can drop it.
    assert [item["id"] for item in delta["items"]] == [second.id]
    assert delta["cursor"] == dismissed["seq"] and delta["requires_action"] == 0
    assert [item["id"] for item in (await kb_client.get("/kb/notifications")).json()["items"]] == [first.id]
    everything = (await kb_client.get("/kb/notifications", params={"include_dismissed": True})).json()
    assert {item["id"] for item in everything["items"]} == {first.id, second.id}
    assert (await kb_client.post("/kb/notifications/ntf-missing/dismiss")).status_code == 404


async def test_long_poll_waits_for_a_change_from_another_thread(
    kb_app: Any, kb_client: httpx.AsyncClient
) -> None:
    await connect(kb_client)
    kb: KnowledgeService = kb_app.state.runtime.kb
    cursor = (await kb_client.get("/kb/notifications")).json()["cursor"]

    started = time.monotonic()
    empty = (await kb_client.get("/kb/notifications", params={"after": cursor, "wait": 0.3})).json()
    assert empty["items"] == [] and empty["cursor"] == cursor
    assert time.monotonic() - started >= 0.25

    async def later() -> None:
        await asyncio.sleep(0.2)
        await asyncio.to_thread(kb.notify, "material_ready", "Ready")

    task = asyncio.create_task(later())
    started = time.monotonic()
    found = (await kb_client.get("/kb/notifications", params={"after": cursor, "wait": 10})).json()
    await task
    assert [item["title"] for item in found["items"]] == ["Ready"]
    assert time.monotonic() - started < 5
    assert (await kb_client.get("/kb/notifications", params={"wait": 26})).status_code == 422


async def test_resolve_errors(kb_app: Any, kb_client: httpx.AsyncClient) -> None:
    await connect(kb_client)
    kb: KnowledgeService = kb_app.state.runtime.kb
    plain = kb.notify("material_ready", "Ready")
    missing = await kb_client.post("/kb/notifications/ntf-missing/resolve", json={"action": "keep_both"})
    assert missing.status_code == 404
    unknown = await kb_client.post(f"/kb/notifications/{plain.id}/resolve", json={"action": "keep_both"})
    assert unknown.status_code == 422
    assert (await kb_client.post(f"/kb/notifications/{plain.id}/resolve", json={})).status_code == 422


def test_an_older_database_gets_seq_and_the_new_columns(tmp_path: Path) -> None:
    path = tmp_path / "knowledge.sqlite3"
    older = tuple(module for module in MODULES if module.NAME != "wiki2")
    KnowledgeDatabase(path, modules=older).close()
    connection = sqlite3.connect(path)
    connection.execute(
        "INSERT INTO notifications(id, kind, title, created_at) VALUES "
        "('ntf-a', 'x', 'A', '2026-10-01T00:00:00Z'), ('ntf-b', 'x', 'B', '2026-10-02T00:00:00Z')"
    )
    connection.commit()
    connection.close()
    db = KnowledgeDatabase(path)
    try:
        with db.read() as reading:
            rows = reading.execute(
                "SELECT id, seq, subject, resolved_at FROM notifications ORDER BY id"
            ).fetchall()
        assert [(row[0], row[1], row[2], row[3]) for row in rows] == [
            ("ntf-a", 1, None, None),
            ("ntf-b", 2, None, None),
        ]
        assert db.schema_versions()["wiki2"] == 1
    finally:
        db.close()
