"""Q1 n78 M-7 (backend part): the chat's rules say since when its library sources are as they are, so
the «N statements not from your sources» check is not stamped on answers written under other sources.
Only a change of the sources moves it — not a web list change or a spent «Search everywhere once»."""
from __future__ import annotations

import pytest

from .test_chats_api import Env
from .test_chats_api import env as env_fixture  # noqa: F401  (the ``env`` fixture)


@pytest.fixture
def env(env_fixture: Env) -> Env:  # noqa: F811
    return env_fixture


async def test_sources_since_moves_only_when_the_sources_change(env: Env) -> None:
    lib = env.library
    chat = await env.chat()
    url = f"/kb/chats/{chat['id']}/search-rules"
    assert (await env.client.get(url)).json()["sources_since"] is None
    first = (await env.client.put(url, json={"sources_only": True, "sources": [lib.lecture]})).json()
    since = first["sources_since"]
    assert isinstance(since, str) and since
    web = {"never": ["habr.com"], "only_on": False, "only": [], "prefer": []}
    body = {"sources_only": True, "sources": [lib.lecture], "web": web}
    same = (await env.client.put(url, json=body)).json()
    assert same["sources_since"] == since
    await env.client.post(f"{url}/everywhere-once")
    assert (await env.client.get(url)).json()["sources_since"] == since
    moved = (await env.client.put(url, json={**body, "sources": [lib.textbook]})).json()
    assert moved["sources_since"] is not None and moved["sources_since"] > since
