"""Q1 n78 M-6: the chat overview's «Looked at» never lists a read SKAZ refused — a read outside the
chat's sources gets no target, and a call whose result came back as an error loses its target."""
from __future__ import annotations

import pytest

from skaz.knowledge.agents.engine import ToolCall, ToolResult
from tests.knowledge.chat_support import chips, text

from .test_chats_api import Env
from .test_chats_api import env as env_fixture  # noqa: F401  (the ``env`` fixture)


@pytest.fixture
def env(env_fixture: Env) -> Env:  # noqa: F811
    return env_fixture


async def test_refused_or_failed_reads_are_not_looked_at(env: Env) -> None:
    lib = env.library
    env.agents.scripts["codex"] = lambda _turn: [
        ToolCall("", "c1", "skaz_read_material", {"material_id": lib.textbook}),  # excluded: refused
        ToolCall("", "c2", "skaz_read_page", {"page_id": lib.concept}),
        ToolResult("", "c2", "Page not readable.", is_error=True),  # failed
        ToolCall("", "c3", "skaz_read_material", {"material_id": lib.lecture}),
        ToolResult("", "c3", "{}", is_error=False),
        *text("Готово."),
    ]
    chat = await env.chat()
    put = await env.client.put(f"/kb/chats/{chat['id']}/search-rules", json={"excluded": [lib.textbook]})
    assert put.status_code == 200, put.text
    message = await env.answered(chat["id"], "Прочитай")
    assert [part["target"] for part in chips(message, "tool")] == [
        None, None, {"type": "material", "id": lib.lecture}]
    stored = (await env.client.get(f"/kb/chats/{chat['id']}")).json()["messages"][-1]
    assert [part["target"] for part in chips(stored, "tool")] == [
        None, None, {"type": "material", "id": lib.lecture}]
