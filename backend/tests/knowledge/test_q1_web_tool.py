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
