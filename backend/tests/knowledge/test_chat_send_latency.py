"""Bug 7 (2026-10-26): sending a message never waits for a fresh agent check.

The chat answers ``POST …/messages`` from the agent's last known state; a check that has gone stale
is not repeated before the answer starts. An agent never seen ready is still checked (and refused
with its reason, as before). Over the public HTTP route with a fake engine whose check is slow.
"""
from __future__ import annotations

import asyncio
import time
from typing import Any

from skaz.knowledge.agents.engine import EngineStatus
from skaz.knowledge.agents.fake import FakeEngine
from tests.knowledge.chat_support import install, text
from tests.knowledge.test_chats_api import Env, env, finished  # noqa: F401 - the chat API world


class SlowCheck(FakeEngine):
    """A Codex whose status and model list take a second, like a cold app-server."""

    def __init__(self, **kwargs: Any) -> None:
        super().__init__("codex", **kwargs)
        self.checks = 0

    async def status(self) -> EngineStatus:
        self.checks += 1
        await asyncio.sleep(1.0)
        return await super().status()


async def test_a_message_is_accepted_without_waiting_for_a_fresh_agent_check(env: Env) -> None:  # noqa: F811
    slow = SlowCheck(script=lambda turn: text("Ответ"))
    env.agents.engines["codex"] = slow
    registry = install(env.runtime, env.agents)  # the test registry's checks go stale at once (cache_s=0)
    chat = await env.chat(engine="codex")
    await registry.view("codex")  # the agent is seen ready once (the agents screen, an earlier answer…)
    checked = slow.checks
    assert checked >= 1
    started = time.monotonic()
    sent = await env.ask(chat["id"], "Вопрос")
    elapsed = time.monotonic() - started
    assert elapsed < 0.2, f"POST …/messages took {elapsed:.3f} s"
    assert slow.checks == checked  # no new check before the answer started
    assert sent["assistant"]["state"] == "streaming"
    await finished(env.chats)
    assert slow.turns, "the answer was written by the agent"


async def test_an_agent_never_seen_ready_is_still_checked_and_refused(env: Env) -> None:  # noqa: F811
    env.agents.missing("hermes", "Hermes Agent is not installed.")
    install(env.runtime, env.agents)
    chat = await env.chat(engine="hermes")
    sent = await env.client.post(f"/kb/chats/{chat['id']}/messages", json={"text": "Привет"})
    assert sent.status_code == 409 and sent.json()["code"] == "AGENT_UNAVAILABLE"
