"""Effective approved site constraints at the real chat/gate/search-runner seam; no model calls."""
from __future__ import annotations

import pytest

from skaz.knowledge.agents.web import WebLink
from skaz.knowledge.permissions.search_rules import ChatRules, WebRules

from .chat_support import finished
from .test_w3b_web_tool import Env, payload
from .test_w3b_web_tool import env as env_fixture  # noqa: F401


@pytest.fixture
async def env(env_fixture: Env) -> Env:  # noqa: F811
    env_fixture.runtime.kb_search_rules.set_beta(True)
    return env_fixture


@pytest.mark.parametrize("engine", ["codex", "claude_code", "hermes", "opencode"])
async def test_only_and_never_reach_the_card_and_searcher_before_results_are_filtered(
        env: Env, engine: str) -> None:
    query = "COBIT 2019 IT governance framework"
    expected = f"({query}) site:scholar.google.com -site:blocked.example.org"
    env.runtime.kb_search_rules.set_global(WebRules(
        only_on=True, only=("scholar.google.com",), never=("blocked.example.org",)))
    env.agents[engine].queries = [query]
    links = (WebLink("Allowed result", "https://scholar.google.com/example"),
             WebLink("Outside result", "https://isaca.org/example"),
             WebLink("Never result", "https://blocked.example.org/example"))
    env.codex_search.links = env.claude_search.links = links
    chat = await env.chat(engine)
    await env.send(chat)
    pending = await env.pending(chat)
    assert pending["query"] == expected
    assert not env.codex_search.calls and not env.claude_search.calls
    assert (await env.decide(pending["id"], "allow")).status_code == 200
    await finished(env.runtime.kb_chats)
    calls = [*env.codex_search.calls, *env.claude_search.calls]
    assert len(calls) == 1 and calls[0][1] == expected
    result = payload(env.agents[engine].outputs[0])
    assert result["links"] == [{"title": "Allowed result", "url": links[0].url}]
    assert result["hidden_by_rules"] == 2
    assert (await env.parts(chat))[0]["query"] == expected


async def test_filtered_results_do_not_claim_that_allowed_sites_have_no_information(env: Env) -> None:
    env.runtime.kb_search_rules.set_global(WebRules(only_on=True, only=("scholar.google.com",)))
    env.codex_search.links = (WebLink("Outside result", "https://isaca.org/example"),)
    chat = await env.chat("codex")
    await env.send(chat)
    await env.decide((await env.pending(chat))["id"], "allow")
    await finished(env.runtime.kb_chats)
    result = payload(env.agents["codex"].outputs[0])
    assert result["links"] == [] and result["hidden_by_rules"] == 1
    assert "Nothing was found" not in result["note"]
    assert "not proof" in result["note"]


@pytest.mark.parametrize(("rules", "expected"), [
    (WebRules(only_on=True, only=("arxiv.org", "acm.org")),
     "(biology OR chemistry) (site:arxiv.org OR site:acm.org)"),
    (WebRules(never=("blocked.example.org",)), "(biology OR chemistry) -site:blocked.example.org"),
    (WebRules(prefer=("arxiv.org",)), "biology OR chemistry"),
])
async def test_multiple_only_never_and_prefer_are_distinct_in_the_actual_query(
        env: Env, rules: WebRules, expected: str) -> None:
    env.runtime.kb_search_rules.set_global(rules)
    env.agents["codex"].queries = ["biology OR chemistry"]
    chat = await env.chat("codex")
    await env.send(chat)
    pending = await env.pending(chat)
    assert pending["query"] == expected
    await env.decide(pending["id"], "allow")
    await finished(env.runtime.kb_chats)
    assert env.codex_search.calls == [("codex", expected)]


async def test_generated_domain_operators_are_not_cut_to_the_raw_query_limit(env: Env) -> None:
    allowed = tuple(f"d{index}.example.org" for index in range(100))
    never = tuple(f"n{index}.example.net" for index in range(100))
    query = "concept " * 49
    env.runtime.kb_search_rules.set_global(WebRules(only_on=True, only=allowed, never=never))
    env.agents["codex"].queries = [query]
    chat = await env.chat("codex")
    await env.send(chat)
    pending = await env.pending(chat)
    effective = pending["query"]
    assert len(effective) > 400
    assert all(f"site:{site}" in effective for site in allowed)
    assert all(f"-site:{site}" in effective for site in never)
    await env.decide(pending["id"], "allow")
    await finished(env.runtime.kb_chats)
    assert env.codex_search.calls == [("codex", effective)]
    assert not env.agents["codex"].outputs[0][1]


async def test_deny_prevents_the_effective_query_from_being_sent(env: Env) -> None:
    env.runtime.kb_search_rules.set_global(WebRules(only_on=True, only=("scholar.google.com",)))
    chat = await env.chat("codex")
    await env.send(chat)
    pending = await env.pending(chat)
    assert "site:scholar.google.com" in pending["query"]
    await env.decide(pending["id"], "deny")
    await finished(env.runtime.kb_chats)
    assert not env.codex_search.calls and not env.claude_search.calls


async def test_everywhere_once_lifts_only_in_the_query_but_never_is_always_sent(env: Env) -> None:
    env.runtime.kb_search_rules.set_global(WebRules(
        only_on=True, only=("scholar.google.com",), never=("blocked.example.org",)))
    env.agents["codex"].queries = ["first topic", "second topic"]
    chat = await env.chat("codex")
    env.runtime.kb_search_rules.set_chat(chat, ChatRules(everywhere_once=True))
    await env.send(chat)
    pending = await env.pending(chat)
    first = "(first topic) -site:blocked.example.org"
    second = "(second topic) site:scholar.google.com -site:blocked.example.org"
    assert pending["query"] == first
    await env.decide(pending["id"], "allow_chat")
    await finished(env.runtime.kb_chats)
    assert env.codex_search.calls == [("codex", first), ("codex", second)]
    assert [part["query"] for part in await env.parts(chat)] == [first, second]
    assert not env.runtime.kb_search_rules.chat(chat).everywhere_once
