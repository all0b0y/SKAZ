"""Q1 n78 M-4: the implicit context of a question — the page or material open beside the chat, the
chat's own recording and recordings in progress — follows the chat's sources: what they don't allow
is not sent, only a SKAZ line says it is open but outside them. What the user adds on purpose
(attachments, @mentions) is «added by you» and stays."""
from __future__ import annotations

import pytest

from tests.knowledge.chat_support import finished

from .test_chats_api import Env
from .test_chats_api import env as env_fixture  # noqa: F401  (the ``env`` fixture)

LECTURE_TEXT = "Энтропия — мера беспорядка системы"
LIVE_TEXT = "Плавление льда поглощает теплоту"


@pytest.fixture
def env(env_fixture: Env) -> Env:  # noqa: F811
    return env_fixture


async def _rules(env: Env, chat_id: str, rules: dict[str, object]) -> None:
    response = await env.client.put(f"/kb/chats/{chat_id}/search-rules", json=rules)
    assert response.status_code == 200, response.text


def _request(env: Env) -> str:
    return str(env.agents.engines["codex"].turns[-1].messages[-1].content)


async def test_an_open_material_or_page_outside_the_sources_is_not_sent(env: Env) -> None:
    lib = env.library
    chat = await env.chat()
    await _rules(env, chat["id"], {"excluded": [lib.lecture, lib.concept]})
    await env.answered(chat["id"], "Что тут?", context={"open_page_id": lib.concept,
                                                       "open_material_id": lib.lecture})
    request = _request(env)
    assert LECTURE_TEXT not in request and "Энтропия — мера беспорядка системы." not in request
    assert "open next to the chat, but the user excluded it from this chat" in request

    await _rules(env, chat["id"], {"sources_only": True, "sources": [lib.textbook]})
    await env.answered(chat["id"], "А теперь?", context={"open_material_id": lib.lecture},
                       mentions=[{"type": "material", "id": lib.lecture, "title": "Лекция 8"}])
    request = _request(env)
    assert "outside the sources chosen for this chat" in request
    assert request.count(LECTURE_TEXT) == 1  # only through the user's own @mention
    await finished(env.chats)


async def test_an_excluded_recording_gives_no_speech(env: Env) -> None:
    lib = env.library
    chat = await env.chat(recording_material_id=lib.live)
    await _rules(env, chat["id"], {"excluded": [lib.live]})
    await env.answered(chat["id"], "Что было?")
    request = _request(env)
    assert LIVE_TEXT not in request and "This chat belongs to a recording" not in request
    other = await env.chat()
    await _rules(env, other["id"], {"sources_only": True, "sources": [lib.textbook]})
    await env.answered(other["id"], "Что идёт?")
    assert "A recording is in progress" not in _request(env)  # one outside the set isn't listed
    await finished(env.chats)
