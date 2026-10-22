"""The message field remembers each agent's last model and reasoning (models screen v2, 2026-10-20).

Over the public HTTP routes with fake engines at the agent seam: a choice made in a chat or in the
New chat field is kept per agent in SKAZ's settings, survives a restart (it is in the profile's
database), and an existing chat keeps its own model.
"""
from __future__ import annotations

from typing import Any

from skaz.knowledge.agents.engine import ModelOption
from tests.knowledge.test_chats_api import Env, env, with_models  # noqa: F401 - the chat API world


async def _last(world: Env, engine: str) -> Any:
    agents = (await world.client.get("/kb/agents")).json()["agents"]
    return next(agent for agent in agents if agent["id"] == engine)["last_choice"]


async def test_each_agent_keeps_its_last_chat_model_and_reasoning(env: Env) -> None:  # noqa: F811
    with_models(env, "codex", ModelOption("fast", "Fast", ("low", "high"), "low"),
                ModelOption("deep", "Deep", ("medium", "xhigh"), "medium"))
    with_models(env, "claude_code", ModelOption("opus", "Opus", ("low", "high"), "high"))
    assert await _last(env, "codex") is None  # nothing chosen yet: the field shows the agent's default
    first = await env.chat(engine="codex", model="deep", effort="xhigh")
    assert await _last(env, "codex") == {"model": "deep", "effort": "xhigh"}
    switched = await env.client.patch(f"/kb/chats/{first['id']}", json={
        "engine": "claude_code", "model": "opus", "effort": "low"})
    assert switched.status_code == 200, switched.text
    assert await _last(env, "claude_code") == {"model": "opus", "effort": "low"}
    assert await _last(env, "codex") == {"model": "deep", "effort": "xhigh"}
    # Another chat's choice doesn't touch a chat that exists: it keeps its own model.
    second = await env.chat(engine="codex", model="fast", effort="low")
    assert (await env.client.get(f"/kb/chats/{first['id']}")).json()["model"] == "opus"
    assert await _last(env, "codex") == {"model": "fast", "effort": "low"}
    assert second["model"] == "fast"


async def test_a_new_chat_choice_is_remembered_before_the_first_message(env: Env) -> None:  # noqa: F811
    with_models(env, "codex", ModelOption("fast", "Fast", ("low", "high"), "low"))
    saved = await env.client.put("/kb/chats/last-choice",
                                 json={"engine": "codex", "model": "fast", "effort": "high"})
    assert saved.status_code == 204, saved.text
    assert await _last(env, "codex") == {"model": "fast", "effort": "high"}
    # The same checks as a chat: no model or reasoning the agent doesn't offer, nothing replaced.
    bad = await env.client.put("/kb/chats/last-choice", json={"engine": "codex", "model": "imaginary"})
    assert bad.status_code == 422
    worse = await env.client.put("/kb/chats/last-choice",
                                 json={"engine": "codex", "model": "fast", "effort": "max"})
    assert worse.status_code == 422
    assert await _last(env, "codex") == {"model": "fast", "effort": "high"}
    # "As set in the agent" is a choice too.
    await env.client.put("/kb/chats/last-choice", json={"engine": "codex", "model": None, "effort": None})
    assert await _last(env, "codex") == {"model": None, "effort": None}


async def test_the_memory_is_in_the_profile_and_survives_a_restart(env: Env) -> None:  # noqa: F811
    with_models(env, "codex", ModelOption("fast", "Fast", ("low", "high"), "low"))
    await env.chat(engine="codex", model="fast", effort="high")
    from skaz.knowledge.agents.last_choice import LastChoice

    fresh = LastChoice(env.runtime.kb.settings)  # a new reader over the same profile database
    assert fresh.get("codex") == ("fast", "high")
