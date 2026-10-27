"""Q1 n78 M-2: ``skaz_web_search`` screens the links with the rules snapshot taken when the query was
asked — never «no rules» because recording them on the card failed (the chat deleted mid-search)."""
from __future__ import annotations

from typing import Any

import pytest

from .chat_support import finished
from .test_n7_search_rules import SEARCH_LINKS, set_settings
from .test_w3b_web_tool import Env, payload
from .test_w3b_web_tool import env as env_fixture  # noqa: F401  (the ``env`` fixture)


@pytest.fixture
def env(env_fixture: Env) -> Env:  # noqa: F811
    return env_fixture


async def test_links_are_screened_even_when_the_card_could_not_record_them(env: Env) -> None:
    await set_settings(env, never=["pinterest.com"])
    env.codex_search.links = SEARCH_LINKS

    async def lost(_search_id: str, _links: Any) -> None:
        return None  # the card's row is gone (e.g. the chat was deleted while searching)

    env.runtime.kb_web.record_links = lost
    chat_id = await env.chat("codex")
    await env.send(chat_id)
    await env.decide((await env.pending(chat_id))["id"], "allow")
    await finished(env.runtime.kb_chats)
    data = payload(env.agents["codex"].outputs[0])
    assert data["status"] == "ok" and data["links"]
    assert all("pinterest" not in link["url"] for link in data["links"]) and data["hidden_by_rules"] == 2


async def test_a_denied_search_does_not_spend_search_everywhere_once(env: Env) -> None:
    """Q1 n78 L-1: «Search everywhere once» is spent by the search the user allows, not by a Deny."""
    await set_settings(env, only_on=True, only=["arxiv.org"])
    env.codex_search.links = SEARCH_LINKS
    chat_id = await env.chat("codex")
    url = f"/kb/chats/{chat_id}/search-rules"
    assert (await env.client.post(f"{url}/everywhere-once")).json()["everywhere_once"] is True
    await env.send(chat_id)
    part = await env.pending(chat_id)
    assert part["rules"]["everywhere_once"] is True
    await env.decide(part["id"], "deny")
    await finished(env.runtime.kb_chats)
    assert (await env.client.get(url)).json()["everywhere_once"] is True  # still the user's to use
    await env.send(chat_id, "Ещё раз")
    part = await env.pending(chat_id)
    await env.decide(part["id"], "allow")
    await finished(env.runtime.kb_chats)
    assert (await env.client.get(url)).json()["everywhere_once"] is False
    assert any("medium.com" in link["url"] for link in payload(env.agents["codex"].outputs[-1])["links"])
