"""Q1 n78 H-2 (user decision): with a hard search rule in force (a Never site or «only these sites»,
from Settings or the chat), a Claude Code chat searches only through ``skaz_web_search`` — SKAZ screens
the links before the agent sees them — and Claude's own WebSearch is not used; without hard rules
(nothing, or Prefer only) Claude keeps its own held WebSearch as before.
"""
from __future__ import annotations

from typing import Any

import pytest

from skaz.knowledge.agents.web import WebQuery
from skaz.knowledge.permissions.store import RunRef
from skaz.knowledge.permissions.web_search import NATIVE_HELD, ChatWebGate
from skaz.knowledge.permissions.web_tool import WEB_TOOL

from .chat_support import finished
from .test_n7_search_rules import SEARCH_LINKS, set_settings
from .test_w3b_web_tool import Env, payload
from .test_w3b_web_tool import env as env_fixture  # noqa: F401  (the ``env`` fixture)


@pytest.fixture
def env(env_fixture: Env) -> Env:  # noqa: F811
    return env_fixture


def offered(turn: Any) -> set[str]:
    return {spec.name for spec in turn.tools or ()}


@pytest.mark.parametrize(("rules", "expected_query"), [
    ({"never": ["pinterest.com"]}, "(entropy definition) -site:pinterest.com"),
    ({"only_on": True, "only": ["arxiv.org", "semanticscholar.org"]},
     "(entropy definition) (site:arxiv.org OR site:semanticscholar.org)"),
    ({"beta": False, "never": ["pinterest.com"]}, "(entropy definition) -site:pinterest.com"),
])
async def test_hard_rules_move_a_claude_chat_to_skaz_web_search_with_links_screened(
        env: Env, rules: dict[str, Any], expected_query: str) -> None:
    await set_settings(env, **rules)
    env.claude_search.links = SEARCH_LINKS
    chat_id = await env.chat("claude_code")
    await env.send(chat_id)
    part = await env.pending(chat_id)
    assert part["searcher"] == "claude_code" and part["rules"] is not None  # the same card, via SKAZ
    assert part["query"] == expected_query  # the effective restrictions are visible BEFORE approval
    assert not env.claude_search.calls
    await env.decide(part["id"], "allow")
    await finished(env.runtime.kb_chats)
    (turn,) = env.agents["claude_code"].turns
    assert WEB_TOOL in offered(turn) and turn.web is None  # no native WebSearch for this chat
    assert WEB_TOOL in turn.instructions
    data = payload(env.agents["claude_code"].outputs[0])
    urls = [link["url"] for link in data["links"]]
    assert all("pinterest" not in url for url in urls) and data["hidden_by_rules"] >= 2
    assert env.claude_search.calls == [("claude_code", expected_query)]


async def test_a_chat_level_never_site_moves_the_claude_chat_too(env: Env) -> None:
    chat_id = await env.chat("claude_code")
    put = await env.client.put(f"/kb/chats/{chat_id}/search-rules",
                               json={"web": {"never": ["pinterest.com"], "only_on": False, "only": [],
                                             "prefer": []}})
    assert put.status_code == 200, put.text
    env.agents["claude_code"].queries = []
    await env.send(chat_id, "Привет")
    await finished(env.runtime.kb_chats)
    (turn,) = env.agents["claude_code"].turns
    assert WEB_TOOL in offered(turn) and turn.web is None


@pytest.mark.parametrize("rules", [{}, {"prefer": ["arxiv.org"]}])
async def test_without_hard_rules_claude_keeps_its_own_held_websearch(
        env: Env, rules: dict[str, Any]) -> None:
    if rules:
        await set_settings(env, **rules)
    env.agents["claude_code"].queries = []
    chat_id = await env.chat("claude_code")
    await env.send(chat_id, "Привет")
    await finished(env.runtime.kb_chats)
    (turn,) = env.agents["claude_code"].turns
    assert WEB_TOOL not in offered(turn) and turn.web is not None


async def test_beta_off_pauses_saved_only_for_claude_without_deleting_the_list(env: Env) -> None:
    await set_settings(env, only_on=True, only=["arxiv.org"], prefer=["acm.org"])
    disabled = await env.client.put("/kb/settings/search", json={"beta": False})
    assert disabled.status_code == 200
    assert disabled.json()["only"] == ["arxiv.org"]
    env.agents["claude_code"].queries = []
    chat_id = await env.chat("claude_code")
    await env.send(chat_id, "Привет")
    await finished(env.runtime.kb_chats)
    (turn,) = env.agents["claude_code"].turns
    assert WEB_TOOL not in offered(turn) and turn.web is not None


async def test_a_native_websearch_under_hard_rules_is_refused_with_the_way_to_search(env: Env) -> None:
    """Rules switched on while a Claude answer runs: its own WebSearch is refused before any card."""
    await set_settings(env, never=["pinterest.com"])
    chat_id = await env.chat("claude_code")
    gate = ChatWebGate(env.runtime.kb_web, RunRef("run-x", chat_id, "msg-x", "claude_code"))
    refused = await gate.approve(WebQuery("toolu_1", "wiki staleness"))
    assert not refused.allowed and refused.message == NATIVE_HELD and WEB_TOOL in NATIVE_HELD
    assert refused.search_id is None and await env.parts(chat_id) == []
