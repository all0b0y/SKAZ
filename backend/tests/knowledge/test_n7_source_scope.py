"""N7-4: «Use only these sources» / «Exclude from this chat» are kept by SKAZ's library tools.

A chat answer is held open (a gate in the fake agent's script) while the test calls the library tools
the way Codex's dynamic tools or an MCP ``tools/call`` would: ``ToolRegistry.call`` with the run's
context. Nothing outside the chat's sources reaches the agent; runs that are no chat answer are not
narrowed; the agent is told the sources before the question (strict mode).
"""
from __future__ import annotations

import asyncio
import json

from skaz.knowledge.agents.fake import Gate
from skaz.knowledge.agents.tools import ToolContext
from skaz.knowledge.permissions.source_scope import EXCLUDED, NOT_IN_SOURCES, PAGE_NOT_IN_SOURCES, SCOPED_NOTE
from tests.knowledge.chat_support import finished, text
from tests.knowledge.ingest_support import settle

from .test_chats_api import Env, env  # noqa: F401  (``env`` is the fixture)


async def held_turn(env: Env, rules: dict[str, object]) -> tuple[str, ToolContext, asyncio.Event]:
    gate = asyncio.Event()
    env.agents.scripts["codex"] = lambda _turn: [*text("…"), Gate(gate)]
    chat = await env.chat()
    response = await env.client.put(f"/kb/chats/{chat['id']}/search-rules", json=rules)
    assert response.status_code == 200, response.text
    await env.ask(chat["id"], "Что такое энтропия?")
    await settle(lambda: bool(env.agents.engines["codex"].active_runs()))
    turn = env.agents.engines["codex"].turns[-1]
    return chat["id"], ToolContext(turn.run_id, "codex"), gate


async def test_only_these_sources_reach_the_agent_through_the_library_tools(env: Env) -> None:
    lib = env.library
    _chat, context, gate = await held_turn(env, {"sources_only": True, "sources": [lib.lecture, lib.concept],
                                                 "excluded": [lib.textbook]})
    call = env.runtime.kb_tools.call
    excluded = await call("skaz_read_material", {"material_id": lib.textbook}, context)
    assert excluded.is_error and excluded.text == EXCLUDED
    outside = await call("skaz_get_fragment", {"material_id": lib.live, "seg": 1}, context)
    assert outside.is_error and outside.text == NOT_IN_SOURCES
    page = await call("skaz_read_page", {"title": "Старый разбор"}, context)
    assert page.is_error and page.text == PAGE_NOT_IN_SOURCES
    inside = await call("skaz_read_material", {"material_id": lib.lecture}, context)
    assert not inside.is_error and "Энтропия — мера беспорядка" in inside.text

    found = await call("skaz_search", {"query": "энтропия"}, context)
    assert not found.is_error and SCOPED_NOTE in found.text
    assert lib.lecture in found.text and lib.textbook not in found.text and "Старый разбор" not in found.text
    listed = await call("skaz_list_materials", {}, context)
    assert lib.lecture in listed.text and lib.textbook not in listed.text and lib.live not in listed.text
    index = await call("skaz_wiki_index", {}, context)
    assert lib.concept in index.text and "pg-old-answer" not in index.text

    # The same tools outside a chat answer (no run) are not narrowed.
    free = await call("skaz_read_material", {"material_id": lib.textbook}, None)
    assert not free.is_error

    # Strict mode: the agent is told the sources before the question.
    request = env.agents.engines["codex"].turns[-1].messages[-1].content
    assert "[SKAZ — sources of this chat, set by the user] Use only these sources: «Лекция 8»" in request
    assert "[SKAZ — excluded from this chat by the user] Don't use: «Учебник химии»" in request
    assert request.rstrip().endswith("Что такое энтропия?")
    gate.set()
    await finished(env.chats)


async def test_excluded_material_only_is_dropped_and_page_quotes_of_it_are_hidden(env: Env) -> None:
    lib = env.library
    _chat, context, gate = await held_turn(env, {"excluded": [lib.lecture]})
    call = env.runtime.kb_tools.call
    assert (await call("skaz_read_material", {"material_id": lib.textbook}, context)).is_error is False
    assert (await call("skaz_read_material", {"material_id": lib.lecture}, context)).text == EXCLUDED
    page = await call("skaz_read_page", {"page_id": lib.concept}, context)
    assert not page.is_error and "мера беспорядка системы\"" not in page.text
    assert '"excluded":true' in page.text.replace(" ", "")
    gate.set()
    await finished(env.chats)


async def test_a_chat_without_narrowed_sources_is_as_before(env: Env) -> None:
    lib = env.library
    _chat, context, gate = await held_turn(env, {})
    call = env.runtime.kb_tools.call
    found = await call("skaz_search", {"query": "энтропия"}, context)
    assert SCOPED_NOTE not in found.text and lib.textbook in found.text
    assert "[SKAZ — sources" not in env.agents.engines["codex"].turns[-1].messages[-1].content
    gate.set()
    await finished(env.chats)
    assert json.dumps({"ok": True})
