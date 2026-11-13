"""EX3 UX-4: Explore is the only scientific search entry; retired research/reading routes are absent."""
from __future__ import annotations

import httpx
import pytest


@pytest.mark.parametrize(("method", "path"), [
    ("POST", "/kb/research/proposals"),
    ("POST", "/kb/research/tasks"),
    ("GET", "/kb/research/tasks"),
    ("GET", "/kb/research/tasks/task-old"),
    ("POST", "/kb/research/tasks/task-old/pause"),
    ("POST", "/kb/research/tasks/task-old/continue"),
    ("POST", "/kb/research/tasks/task-old/cancel"),
    ("POST", "/kb/research/permissions/request-old/decide"),
    ("GET", "/kb/chats/chat-old/research-grant"),
    ("DELETE", "/kb/chats/chat-old/research-grant"),
    ("POST", "/kb/explore/findings/f-old/explore"),
    ("POST", "/kb/explore/findings/f-old/wiki"),
    ("GET", "/kb/explore/exploring"),
])
async def test_retired_entry_points_are_unavailable(
    kb_client: httpx.AsyncClient, method: str, path: str,
) -> None:
    response = await kb_client.request(method, path, json={})
    assert response.status_code == 404
