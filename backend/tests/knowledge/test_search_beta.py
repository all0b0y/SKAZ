"""Search Beta pauses Only/Prefer without deleting them; Never and library rules stay active."""
from __future__ import annotations

from typing import Any

import pytest

from skaz.knowledge.agents.web import WebLink

from .chat_support import finished
from .test_w3b_web_tool import Env, payload
from .test_w3b_web_tool import env as env_fixture  # noqa: F401  (the ``env`` fixture)


@pytest.fixture
def env(env_fixture: Env) -> Env:  # noqa: F811
    return env_fixture


async def put_settings(env: Env, **rules: Any) -> dict[str, Any]:
    response = await env.client.put("/kb/settings/search", json=rules)
    assert response.status_code == 200, response.text
    data: dict[str, Any] = response.json()
    return data


async def test_beta_defaults_off_and_toggling_it_preserves_the_hidden_lists(env: Env) -> None:
    assert (await env.client.get("/kb/settings/search")).json() == {
        "never": [], "only_on": False, "only": [], "prefer": [], "beta": False,
    }
    enabled = await put_settings(
        env, beta=True, never=["pinterest.com"], only_on=True, only=["arxiv.org"], prefer=["acm.org"],
    )
    assert enabled["beta"] is True
    disabled = await put_settings(env, beta=False)
    assert disabled == {
        "never": ["pinterest.com"], "only_on": True, "only": ["arxiv.org"], "prefer": ["acm.org"],
        "beta": False,
    }
    assert (await env.client.get("/kb/settings/search")).json() == disabled
    restored = await put_settings(env, beta=True)
    assert restored == {**disabled, "beta": True}


async def test_beta_off_removes_only_and_prefer_from_new_searches_but_not_never(env: Env) -> None:
    await put_settings(
        env, beta=True, never=["pinterest.com"], only_on=True, only=["arxiv.org"], prefer=["acm.org"],
    )
    await put_settings(env, beta=False)
    env.codex_search.links = (
        WebLink("Allowed before", "https://medium.com/article"),
        WebLink("Blocked always", "https://pinterest.com/pin/1"),
    )
    chat_id = await env.chat("codex")
    await env.send(chat_id)
    part = await env.pending(chat_id)
    assert part["rules"] == {
        "never": ["pinterest.com"], "settings_never": ["pinterest.com"], "only": [], "prefer": [],
        "origin": "settings", "everywhere_once": False,
    }
    assert "site:arxiv.org" not in part["query"]
    assert "-site:pinterest.com" in part["query"]
    await env.decide(part["id"], "allow")
    await finished(env.runtime.kb_chats)
    data = payload(env.agents["codex"].outputs[0])
    assert [link["url"] for link in data["links"]] == ["https://medium.com/article"]
    instructions = env.agents["codex"].turns[0].instructions
    assert "Never search these sites: pinterest.com." in instructions
    assert "Search only these sites" not in instructions
    assert "Prefer these sites" not in instructions

    await put_settings(env, beta=True)
    await env.send(chat_id, "Search with beta again")
    restored = await env.pending(chat_id)
    assert restored["rules"]["only"] == ["arxiv.org"]
    assert restored["rules"]["prefer"] == ["acm.org"]


async def test_chat_save_and_reset_at_beta_off_preserve_hidden_chat_rules(env: Env) -> None:
    await put_settings(env, beta=True, only_on=True, only=["arxiv.org"], prefer=["acm.org"])
    chat_id = await env.chat("codex")
    url = f"/kb/chats/{chat_id}/search-rules"
    own = {"never": ["habr.com"], "only_on": True, "only": ["semanticscholar.org"], "prefer": ["ieee.org"]}
    await env.client.put(url, json={"web": own, "sources_only": True, "sources": ["mat-1"]})
    await put_settings(env, beta=False)

    saved = (await env.client.put(url, json={
        "web": {"never": ["quora.com"]}, "sources_only": False, "sources": [], "excluded": ["mat-2"],
    })).json()
    assert saved["web"] == own | {"never": ["quora.com"]}
    assert saved["active"]["only"] == [] and saved["active"]["prefer"] == []
    assert saved["excluded"][0]["id"] == "mat-2"
    assert saved["label"] == "1 excluded"

    reset = (await env.client.delete(url)).json()
    assert reset["web"] == own | {"never": []}
    assert reset["sources"] == [] and reset["excluded"] == []
    assert reset["active"]["only"] == [] and reset["active"]["prefer"] == []
    assert reset["label"] is None

    await put_settings(env, beta=True)
    restored = (await env.client.get(url)).json()
    assert restored["active"]["only"] == ["semanticscholar.org"]
    assert restored["active"]["prefer"] == ["ieee.org"]


async def test_save_as_global_at_beta_off_changes_only_never_and_keeps_both_hidden_scopes(env: Env) -> None:
    await put_settings(env, beta=True, only_on=True, only=["arxiv.org"], prefer=["acm.org"])
    chat_id = await env.chat("codex")
    url = f"/kb/chats/{chat_id}/search-rules"
    own = {"never": ["habr.com"], "only_on": True, "only": ["semanticscholar.org"], "prefer": ["ieee.org"]}
    await env.client.put(url, json={"web": own})
    await put_settings(env, beta=False)

    result = (await env.client.put(url, json={
        "web": {"never": ["quora.com"], "only_on": False, "only": [], "prefer": []}, "as_global": True,
    })).json()
    assert result["web"] == own | {"never": []}
    assert result["active"]["only"] == [] and result["active"]["prefer"] == []
    settings = (await env.client.get("/kb/settings/search")).json()
    assert settings["never"] == ["quora.com"]
    assert settings["only_on"] is True and settings["only"] == ["arxiv.org"]
    assert settings["prefer"] == ["acm.org"] and settings["beta"] is False
