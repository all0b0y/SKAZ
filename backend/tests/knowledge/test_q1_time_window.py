"""Q1 n78 M-9 (window part only): the «Looking at YYYY–YYYY» behaviour (N7-5) is part of every chat's
instructions, not only of chats where SKAZ holds web searches; its web-only sentences ride with web."""
from __future__ import annotations

import pytest

from .test_chats_api import Env
from .test_chats_api import env as env_fixture  # noqa: F401  (the ``env`` fixture)

WINDOW = "start the answer with one line \"Looking at YYYY–YYYY\""


@pytest.fixture
def env(env_fixture: Env) -> Env:  # noqa: F811
    return env_fixture


async def test_the_window_rule_is_told_without_web_search_too(env: Env) -> None:
    env.chats.web = None  # no web search held by SKAZ at all
    chat = await env.chat()
    await env.answered(chat["id"], "Какие подходы сейчас современные?")
    told = env.agents.engines["codex"].turns[-1].instructions
    assert WINDOW in told and "From YYYY–YYYY sources" in told
    assert "web search query" not in told
