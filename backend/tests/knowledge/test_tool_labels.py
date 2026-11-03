"""Readable tool actions at the chat API seam; no actual provider/tool execution."""
from __future__ import annotations

import pytest

from skaz.knowledge.agents.engine import EngineId, ToolCall, ToolResult
from skaz.knowledge.chats.model import Message, ToolPart
from skaz.knowledge.chats.resolve import MaterialReader, Resolver
from tests.knowledge.chat_support import chips, text

from .test_chats_api import Env
from .test_chats_api import env as env_fixture  # noqa: F401


@pytest.fixture
async def env(env_fixture: Env) -> Env:  # noqa: F811
    return env_fixture


@pytest.mark.parametrize("engine", ["codex", "claude_code", "hermes", "opencode"])
async def test_read_web_page_is_a_readable_action_for_every_engine(env: Env, engine: EngineId) -> None:
    name = "mcp__skaz__skaz_web_read"
    env.agents.scripts[engine] = lambda _turn: [
        ToolCall("", "web-read-1", name, {"url": "https://example.org/evidence"}),
        ToolResult("", "web-read-1", "Authored metadata fixture; no real page read."),
        *text("A controlled answer."),
    ]
    chat = await env.chat(engine=engine)
    message = await env.answered(chat["id"], "Controlled tool display check")
    part = chips(message, "tool")[0]
    assert part["name"] == "skaz_web_read"
    assert part["label"] == "Read Web Page"
    assert part["status"] == "done"
    assert part["call_id"] == "web-read-1"
    assert chips(await env.message(chat["id"], message["id"]), "tool") == [part]


async def test_every_registered_tool_has_a_readable_action(env: Env) -> None:
    resolver = Resolver(env.chats.kb, MaterialReader(env.chats.kb))
    assert "skaz_web_read" in env.chats.tools.names
    for name in env.chats.tools.names:
        part = resolver.tool(name, {})
        assert part.name == name
        assert not part.label.startswith("Used "), (name, part.label)
        assert "skaz_" not in part.label, (name, part.label)
        assert part.label != "Use Tool", name  # registry additions need an explicit, meaningful action


@pytest.mark.parametrize("name", ["skaz_web_read", "mcp__skaz__skaz_web_read"])
async def test_old_generic_labels_are_projected_readably_without_rewriting_history(
        env: Env, name: str) -> None:
    chat = await env.chat()
    original = ToolPart(name, f"Used {name}", call_id="historic-read", status="done", duration_ms=71)
    message = Message(id="historic-tools", chat_id=chat["id"], seq=0, role="assistant", state="done",
                      created_at="2026-11-02T10:00:00Z", parts=(original,))
    env.chats.repo.add_messages([message], {})
    restored = chips(await env.message(chat["id"], message.id), "tool")[0]
    assert restored["name"] == name
    assert restored["label"] == "Read Web Page"
    assert restored["duration_ms"] == 71 and restored["call_id"] == "historic-read"
    stored = env.chats.repo.message(chat["id"], message.id)
    assert stored is not None and stored.parts == (original,)
