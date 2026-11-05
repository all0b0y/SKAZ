"""Q1 n78 M-1 / L-2: the chat's sources narrow ``skaz_search``, ``skaz_list_materials`` and
``skaz_wiki_index`` *before* ranking cuts and paging — a chosen source that is not in the library's
global top hits is still found, and totals / ``has_more`` count only what the chat allows.
"""
from __future__ import annotations

import json
from typing import Any

import pytest

from skaz.knowledge.markdown.source import FragmentInput
from tests.knowledge.chat_support import finished

from .test_chats_api import Env
from .test_chats_api import env as env_fixture  # noqa: F401  (the ``env`` fixture)
from .test_n7_source_scope import held_turn


@pytest.fixture
def env(env_fixture: Env) -> Env:  # noqa: F811
    return env_fixture


def _data(text: str) -> dict[str, object]:
    body = text.split("<untrusted-data", 1)[1].split(">", 1)[1].rsplit("</untrusted-data>", 1)[0]
    data: dict[str, object] = json.loads(body)
    return data


def _crowd(env: Env, count: int = 12) -> list[str]:
    """Materials that match «энтропия» better than the textbook does (more hits per fragment)."""
    kb = env.runtime.kb
    return [kb.create_material(env.library.physics, f"Шум {n}", "pdf", [
        FragmentInput(text="энтропия энтропия энтропия энтропия энтропия", page=1),
        FragmentInput(text="энтропия энтропия энтропия энтропия", page=2),
    ]).manifest.id for n in range(count)]


async def test_a_chosen_source_outside_the_global_top_hits_is_still_found(env: Env) -> None:
    _crowd(env)
    lib = env.library
    _chat, context, gate = await held_turn(env, {"sources_only": True, "sources": [lib.textbook]})
    found = await env.runtime.kb_tools.call("skaz_search", {"query": "энтропия", "limit": 2}, context)
    assert not found.is_error, found.text
    assert lib.textbook in found.text and "Шум" not in found.text
    gate.set()
    await finished(env.chats)


async def test_scoped_lists_count_and_page_only_what_the_chat_allows(env: Env) -> None:
    crowd = _crowd(env, 5)
    lib = env.library
    _chat, context, gate = await held_turn(env, {"excluded": crowd})
    call = env.runtime.kb_tools.call
    listed: Any = _data((await call("skaz_list_materials", {"limit": 2}, context)).text)
    assert listed["total"] == 3 and not set(crowd) & {m["id"] for m in listed["materials"]}
    assert len(listed["materials"]) == 2 and listed["has_more"] is True
    rest: Any = _data((await call("skaz_list_materials", {"limit": 2, "offset": 2}, context)).text)
    assert rest["total"] == 3 and len(rest["materials"]) == 1 and rest["has_more"] is False
    gate.set()
    await finished(env.chats)

    _chat2, context2, gate2 = await held_turn(env, {"excluded": [lib.analysis]})
    every: Any = _data((await call("skaz_wiki_index", {"limit": 50}, None)).text)
    pages = [page["id"] for page in every["pages"]]
    assert lib.analysis in pages
    scoped: Any = _data((await call("skaz_wiki_index", {"limit": 50}, context2)).text)
    assert scoped["total"] == len(pages) - 1 == every["total"] - 1
    assert [page["id"] for page in scoped["pages"]] == [p for p in pages if p != lib.analysis]
    last: Any = _data((await call("skaz_wiki_index", {"limit": 1, "offset": len(pages) - 2}, context2)).text)
    assert last["has_more"] is False and last["next_offset"] is None
    gate2.set()
    await finished(env.chats)
