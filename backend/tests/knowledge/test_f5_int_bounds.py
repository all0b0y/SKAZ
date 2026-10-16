"""QA E2: integers past SQLite's 64-bit range are refused with 422, never a 500 OverflowError."""
from __future__ import annotations

import httpx
import pytest

TOO_BIG = 2**63
LARGEST = 2**63 - 1


async def test_notifications_read_up_to_seq_past_int64_is_422(kb_client: httpx.AsyncClient) -> None:
    response = await kb_client.post("/kb/notifications/read", json={"up_to_seq": TOO_BIG})
    assert response.status_code == 422, response.text
    assert "up_to_seq" in response.json()["detail"]
    assert (await kb_client.post("/kb/notifications/read", json={"up_to_seq": LARGEST})).status_code == 204


@pytest.mark.parametrize("url", [
    f"/kb/notifications?after={TOO_BIG}",
    f"/kb/chats/events?after={TOO_BIG}",
    f"/kb/chats/chat-x/events?after={TOO_BIG}",
    f"/kb/recordings/mat-x/live?since_seg={TOO_BIG}",
])
async def test_cursor_queries_past_int64_are_422(kb_client: httpx.AsyncClient, url: str) -> None:
    response = await kb_client.get(url)
    assert response.status_code == 422, response.text
