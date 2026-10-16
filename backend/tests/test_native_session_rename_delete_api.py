"""Renaming or deleting a native recording never runs the legacy ASR flush.

A native session's transcript belongs to the native writer; the legacy tail flush
is not allowed for it. Rename used to resend the current status, which triggered
that flush on a paused/stopped session and failed with a 409.
"""
from __future__ import annotations

import asyncio
import threading
from typing import Any

import httpx
import pytest

from skaz import repository as repo
from skaz.db import Database
from tests.sessions_support import adelete, create_session, session_gone
from tests.test_native_event_pages_api import recording


@pytest.mark.parametrize("status", ["paused", "stopped"])
async def test_native_session_renames_and_deletes_after_pause_or_stop(
    client: httpx.AsyncClient, app: Any, status: str,
) -> None:
    sid, _cid = await recording(client, app)
    changed = await client.patch(f"/sessions/{sid}", json={"status": status})
    assert changed.status_code == 200, changed.text

    renamed = await client.patch(f"/sessions/{sid}", json={"title": "Lecture 3"})
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["title"] == "Lecture 3"
    assert renamed.json()["status"] == status

    # An older client that still resends the unchanged status must not flush either.
    resent = await client.patch(f"/sessions/{sid}", json={"status": status, "title": "Lecture 4"})
    assert resent.status_code == 200, resent.text
    assert resent.json()["title"] == "Lecture 4"

    await adelete(client, sid)
    assert session_gone(client, sid)


async def test_concurrent_deletions_join_one_removal(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A second deletion of the same session waits for the first instead of failing with 404."""
    sid = create_session(client, "Concurrent delete")
    entered, release = threading.Event(), threading.Event()
    calls: list[str] = []
    original = repo.delete_session

    def delayed(db: Database, session_id: str) -> bool:
        calls.append(session_id)
        entered.set()
        assert release.wait(5)
        return original(db, session_id)

    monkeypatch.setattr(repo, "delete_session", delayed)
    first = asyncio.create_task(adelete(client, sid))
    second = None
    try:
        assert await asyncio.to_thread(entered.wait, 5)
        second = asyncio.create_task(adelete(client, sid))
        done, _ = await asyncio.wait({second}, timeout=0.1)
        assert not done
    finally:
        release.set()
        results = await asyncio.gather(first, *([second] if second else []), return_exceptions=True)
    assert not any(isinstance(result, BaseException) for result in results), results
    assert calls == [sid]
    assert session_gone(client, sid)
