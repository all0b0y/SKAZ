"""Renaming or deleting a native recording never runs the legacy ASR flush.

A native session's transcript belongs to the native writer; the legacy tail flush
is not allowed for it. Rename used to resend the current status, which triggered
that flush on a paused/stopped session and failed with a 409.
"""
from __future__ import annotations

from typing import Any

import httpx
import pytest

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

    deleted = await client.delete(f"/sessions/{sid}")
    assert deleted.status_code == 200, deleted.text
    assert (await client.get(f"/sessions/{sid}")).status_code == 404
