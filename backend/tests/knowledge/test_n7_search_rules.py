"""N7: the user's search rules are kept by SKAZ's code, not by the model.

Covers the rules model (sites, subdomains, levels), the screening of every search result before the
agent gets it (``skaz_web_search``), the domain filters a Claude Code WebSearch is sent with, the card
(rules in force, hidden links counted per site), «Search everywhere once» (the user's click only),
the agent's instructions, and the ``/kb/settings/search`` + ``/kb/chats/{id}/search-rules`` routes.
Agents and searchers are recording stand-ins (no model, no network).
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from skaz.knowledge.agents.web import WebLink, WebQuery, WebVerdict
from skaz.knowledge.permissions.search_rules import (
    ActiveRules,
    BadSite,
    ChatRules,
    WebRules,
    active_rules,
    covers,
    engine_domains,
    normalize_site,
    rules_instructions,
    screen,
    sites,
)
from skaz.knowledge.permissions.store import RunRef
from skaz.knowledge.permissions.web_search import NATIVE_HELD, ChatWebGate
from skaz.knowledge.permissions.web_tool import WEB_TOOL

from .chat_support import finished
from .test_w2_web_claude import ASKED, QUERY, RecordingGate, drain, engine_for, responses, turn
from .test_w3b_web_tool import Env, payload
from .test_w3b_web_tool import env as env_fixture  # noqa: F401  (the ``env`` fixture)


@pytest.fixture
def env(env_fixture: Env) -> Env:  # noqa: F811  (the imported fixture, by parameter)
    """The imported environment under its usual name."""
    return env_fixture


SEARCH_LINKS = (
    WebLink("Staleness checks", "https://arxiv.org/abs/1"),
    WebLink("Provenance", "https://www.semanticscholar.org/paper/2"),
    WebLink("Pin", "https://www.pinterest.com/pin/3"),
    WebLink("Pin 2", "https://ru.pinterest.com/pin/4"),
    WebLink("Blog", "https://medium.com/x"),
)


# -- the model -----------------------------------------------------------------------------------


@pytest.mark.parametrize(("raw", "site"), [
    ("example.com", "example.com"), ("https://www.Example.com/path?q=1", "example.com"),
    ("*.arxiv.org", "arxiv.org"), ("pubmed.ncbi.nlm.nih.gov", "pubmed.ncbi.nlm.nih.gov"),
    ("example.com:8080", "example.com"), ("пример.рф", "xn--e1afmkfd.xn--p1ai"),
    ("localhost", None), ("not a site", None), ("", None), ("1.2.3.4", None), ("-bad-.com", None),
])
def test_sites_are_normalised_or_refused(raw: str, site: str | None) -> None:
    assert normalize_site(raw) == site


def test_a_bad_site_in_a_list_is_refused_with_its_reason() -> None:
    with pytest.raises(BadSite, match="not a site"):
        sites(["arxiv.org", "not a site"])
    assert sites(["arxiv.org", "www.arxiv.org", "nope nope"], strict=False) == ("arxiv.org",)


def test_a_site_covers_its_subdomains_only() -> None:
    assert covers("pinterest.com", "ru.pinterest.com") and covers("pinterest.com", "pinterest.com")
    assert not covers("pinterest.com", "notpinterest.com") and not covers("pinterest.com", "")


def test_a_chat_starts_from_settings_and_can_only_add_never_sites() -> None:
    settings = WebRules(never=("pinterest.com",), only_on=True, only=("arxiv.org",), prefer=("acm.org",))
    assert active_rules(settings, None) == ActiveRules(never=("pinterest.com",), only=("arxiv.org",),
                                                       prefer=("acm.org",), origin="settings")
    # The chat's own lists replace Only / Prefer; its Never sites are added to Settings' ones.
    own = ChatRules(web=WebRules(never=("habr.com",), only_on=False, prefer=()))
    rules = active_rules(settings, own)
    assert rules.never == ("pinterest.com", "habr.com") and rules.only == () and rules.origin == "chat"
    # «Search everywhere once» lifts «only these sites», never the Never sites.
    once = active_rules(settings, ChatRules(everywhere_once=True))
    assert once.only == () and once.everywhere_once and once.never == ("pinterest.com",)


def test_screening_drops_never_sites_and_sites_outside_only_and_counts_them() -> None:
    rules = ActiveRules(never=("pinterest.com",), only=("arxiv.org", "semanticscholar.org"))
    result = screen(SEARCH_LINKS, rules)
    assert [link.url for link in result.kept] == ["https://arxiv.org/abs/1",
                                                  "https://www.semanticscholar.org/paper/2"]
    assert result.hidden == (("pinterest.com", 1), ("ru.pinterest.com", 1), ("medium.com", 1))
    assert result.hidden_count == 3
    assert screen(SEARCH_LINKS, None).kept == SEARCH_LINKS


def test_engine_domains_send_one_kind_of_filter() -> None:
    never = ActiveRules(never=("pinterest.com",))
    assert engine_domains(never, (), ("quora.com",)).blocked == ("pinterest.com", "quora.com")
    # The agent's own narrowing stays, minus the Never sites; all of them blocked → nothing is sent.
    assert engine_domains(never, ("arxiv.org", "pinterest.com"), ()).allowed == ("arxiv.org",)
    assert engine_domains(never, ("ru.pinterest.com",), ()).refused
    only = ActiveRules(never=("pinterest.com",), only=("arxiv.org", "acm.org"))
    assert engine_domains(only, (), ("x.com",)) .allowed == ("arxiv.org", "acm.org")
    assert engine_domains(only, ("dl.acm.org", "medium.com"), ()).allowed == ("dl.acm.org",)
    assert engine_domains(only, ("medium.com",), ()).refused


def test_the_rules_text_names_every_list_and_says_nothing_without_rules() -> None:
    assert rules_instructions(ActiveRules()) == ""
    text = rules_instructions(ActiveRules(never=("pinterest.com",), only=("arxiv.org",), prefer=("acm.org",)))
    assert "Never search these sites: pinterest.com." in text
    assert "Search only these sites: arxiv.org." in text and "say so plainly" in text
    assert "Prefer these sites (a hint; you may still search elsewhere): acm.org." in text


# -- Claude Code: the rules go out as its domain filters ----------------------------------------


class RulesGate(RecordingGate):
    async def approve(self, query: WebQuery) -> WebVerdict:
        self.asked.append(query)
        return WebVerdict(True, search_id="web-1", allowed_domains=(), blocked_domains=("pinterest.com",))


async def test_claude_code_sends_the_users_never_sites_as_blocked_domains(tmp_path: Path) -> None:
    engine, fake = engine_for(tmp_path, ASKED)
    await drain(engine, turn(RulesGate()))
    (answer,) = responses(fake)
    assert answer["response"]["response"] == {
        "behavior": "allow", "updatedInput": {"query": QUERY, "blocked_domains": ["pinterest.com"]}}


# -- through a chat ------------------------------------------------------------------------------


async def set_settings(env: Env, **rules: Any) -> dict[str, Any]:
    response = await env.client.put("/kb/settings/search", json=rules)
    assert response.status_code == 200, response.text
    data: dict[str, Any] = response.json()
    return data


async def test_links_outside_the_rules_never_reach_the_agent_and_are_counted_on_the_card(env: Env) -> None:
    await set_settings(env, never=["pinterest.com"], only_on=True, only=["arxiv.org", "semanticscholar.org"],
                       prefer=["arxiv.org"])
    env.codex_search.links = SEARCH_LINKS
    chat_id = await env.chat("codex")
    await env.send(chat_id)
    part = await env.pending(chat_id)
    assert part["rules"] == {"never": ["pinterest.com"], "settings_never": ["pinterest.com"],
                             "only": ["arxiv.org", "semanticscholar.org"], "prefer": ["arxiv.org"],
                             "origin": "settings", "everywhere_once": False}
    await env.decide(part["id"], "allow")
    await finished(env.runtime.kb_chats)
    data = payload(env.agents["codex"].outputs[0])
    assert [link["url"] for link in data["links"]] == ["https://arxiv.org/abs/1",
                                                       "https://www.semanticscholar.org/paper/2"]
    assert data["hidden_by_rules"] == 3 and "pinterest" not in json.dumps(data)
    (done,) = await env.parts(chat_id)
    assert [link["site"] for link in done["links"]] == ["arxiv.org", "semanticscholar.org"]
    assert done["hidden"] == [{"site": "pinterest.com", "count": 1}, {"site": "ru.pinterest.com", "count": 1},
                              {"site": "medium.com", "count": 1}]
    # The agent was told the rules (a hint for Prefer; the hard ones are kept in code anyway).
    (agent_turn,) = env.agents["codex"].turns
    assert "Never search these sites: pinterest.com." in agent_turn.instructions
    prefer = "Prefer these sites (a hint; you may still search elsewhere): arxiv.org."
    assert prefer in agent_turn.instructions


async def test_nothing_on_the_allowed_sites_tells_the_agent_and_everywhere_once_is_the_users_click(
        env: Env) -> None:
    await set_settings(env, never=["pinterest.com"], only_on=True, only=["arxiv.org"])
    env.codex_search.links = SEARCH_LINKS[2:]
    chat_id = await env.chat("codex")
    await env.send(chat_id)
    await env.decide((await env.pending(chat_id))["id"], "allow_chat")
    await finished(env.runtime.kb_chats)
    data = payload(env.agents["codex"].outputs[0])
    assert data["links"] == []
    assert "Nothing was found on the sites the user allows (arxiv.org)" in data["note"]
    assert "Search everywhere once" in data["note"]

    # The user's click on the card: the next search only ignores «only these sites», once.
    response = await env.client.post(f"/kb/chats/{chat_id}/search-rules/everywhere-once")
    assert response.status_code == 200 and response.json()["everywhere_once"] is True
    await env.send(chat_id, "Ищи везде")
    await finished(env.runtime.kb_chats)
    data = payload(env.agents["codex"].outputs[1])
    assert [link["url"] for link in data["links"]] == ["https://medium.com/x"]  # Never still applies
    second = (await env.parts(chat_id))[1]
    assert second["rules"]["everywhere_once"] is True and second["rules"]["only"] == []
    # Spent: the third search is limited again.
    assert (await env.client.get(f"/kb/chats/{chat_id}/search-rules")).json()["everywhere_once"] is False
    await env.send(chat_id, "Ещё раз")
    await finished(env.runtime.kb_chats)
    assert payload(env.agents["codex"].outputs[2])["links"] == []


async def test_without_rules_the_search_is_as_before(env: Env) -> None:
    chat_id = await env.chat("codex")
    await env.send(chat_id)
    part = await env.pending(chat_id)
    assert part["rules"] is None and part["hidden"] == []
    await env.decide(part["id"], "allow")
    await finished(env.runtime.kb_chats)
    assert "hidden_by_rules" not in payload(env.agents["codex"].outputs[0])
    assert "Search rules the user set" not in env.agents["codex"].turns[0].instructions
    # N7-5: «what now» questions — the window line, the year in the query, undated web links (prompt only).
    window = "start the answer with one line \"Looking at YYYY–YYYY\""
    assert window in env.agents["codex"].turns[0].instructions
    assert "date unknown" in payload(env.agents["codex"].outputs[0])["note"]


async def test_claude_codes_own_gate_is_refused_under_hard_rules_and_as_before_with_prefer_only(
        env: Env) -> None:
    """Q1 n78 H-2: Claude's own WebSearch can't be screened before its model sees the results, so with a
    Never site or «only these sites» it is refused before any card (the chat searches through
    ``skaz_web_search``); with Prefer only, it goes out with the agent's own filters, as before."""
    await set_settings(env, never=["pinterest.com"])
    chat_id = await env.chat("claude_code")
    env.runtime.kb_web.store.grant(chat_id, "2026-10-27T00:00:00Z")  # «Allow in this chat»: no wait
    gate = ChatWebGate(env.runtime.kb_web, RunRef("run-x", chat_id, "msg-x", "claude_code"))
    refused = await gate.approve(WebQuery("toolu_1", "pins", allowed_domains=("ru.pinterest.com",)))
    assert not refused.allowed and refused.message == NATIVE_HELD and refused.search_id is None
    await set_settings(env, never=[], prefer=["arxiv.org"])
    allowed = await gate.approve(WebQuery("toolu_2", "wiki staleness", blocked_domains=("quora.com",)))
    assert allowed.allowed and allowed.blocked_domains == ("quora.com",) and allowed.allowed_domains == ()
    card = env.runtime.kb_web.get(allowed.search_id)
    assert card.blocked_domains == ("quora.com",)
    assert card.rules is not None and card.rules.prefer == ("arxiv.org",)
    # Nothing hard to screen: the card keeps what Claude's search returned.
    await gate.results(allowed.search_id, SEARCH_LINKS)
    assert len(env.runtime.kb_web.get(allowed.search_id).links) == len(SEARCH_LINKS)


# -- the routes ----------------------------------------------------------------------------------


async def test_settings_search_round_trip_normalises_and_refuses_bad_sites(env: Env) -> None:
    assert (await env.client.get("/kb/settings/search")).json() == {
        "never": [], "only_on": False, "only": [], "prefer": []}
    saved = await set_settings(env, never=["https://www.Pinterest.com/x", "pinterest.com"],
                               prefer=["arxiv.org"])
    assert saved == {"never": ["pinterest.com"], "only_on": False, "only": [], "prefer": ["arxiv.org"]}
    bad = await env.client.put("/kb/settings/search", json={"never": ["not a site"]})
    assert bad.status_code == 422 and "not a site" in bad.json()["detail"]
    assert (await env.client.get("/kb/settings/search")).json()["never"] == ["pinterest.com"]


async def test_chat_rules_save_reset_and_save_as_global(env: Env) -> None:
    await set_settings(env, never=["pinterest.com"], prefer=["arxiv.org"])
    chat_id = await env.chat("codex")
    url = f"/kb/chats/{chat_id}/search-rules"
    fresh = (await env.client.get(url)).json()
    assert fresh["web"] is None and fresh["differs"] is False and fresh["label"] is None
    assert fresh["active"]["origin"] == "settings"

    web = {"never": ["pinterest.com", "habr.com"], "only_on": True, "only": ["arxiv.org", "acm.org"],
           "prefer": ["arxiv.org"]}
    saved = (await env.client.put(url, json={"web": web, "sources_only": True,
                                              "sources": ["mat-1", "page-2"]})).json()
    # A Settings Never site is not the chat's own; the chat can't lift it either.
    assert saved["web"]["never"] == ["habr.com"]
    assert saved["active"]["never"] == ["pinterest.com", "habr.com"]
    assert saved["active"]["only"] == ["arxiv.org", "acm.org"] and saved["active"]["origin"] == "chat"
    assert saved["label"] == "Only these · 4" and saved["differs"] is True
    assert [(item["id"], item["title"]) for item in saved["sources"]] == [("mat-1", None), ("page-2", None)]
    lifted = (await env.client.put(url, json={"web": {"never": [], "only_on": False}})).json()
    assert lifted["active"]["never"] == ["pinterest.com"]

    reset = (await env.client.delete(url)).json()
    assert reset["web"] is None and reset["sources"] == [] and reset["label"] is None

    excluded = (await env.client.put(url, json={"excluded": ["mat-1", "mat-2"]})).json()
    assert excluded["label"] == "2 excluded"

    glob = (await env.client.put(url, json={"web": web, "excluded": ["mat-1"], "as_global": True})).json()
    assert glob["web"] is None and glob["label"] == "1 excluded"  # library sources stay per chat
    assert (await env.client.get("/kb/settings/search")).json() == {
        "never": ["pinterest.com", "habr.com"], "only_on": True, "only": ["arxiv.org", "acm.org"],
        "prefer": ["arxiv.org"]}
    assert (await env.client.get("/kb/chats/chat-missing/search-rules")).status_code == 404


def test_tool_name_is_unchanged() -> None:
    assert WEB_TOOL == "skaz_web_search"
