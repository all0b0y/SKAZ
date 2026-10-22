"""W-2: the web search card in chats — query-only, asked before it is sent, kept per chat.

The agent is a scripted engine at the agent seam: it calls the turn's web gate as the Claude Code
adapter does on a ``can_use_tool`` prompt (``test_w2_web_claude.py``), so this proves SKAZ's side:
the card, Allow once / Allow in this chat / Deny, the chat's grant (restart-proof, revocable, only
that chat), Stop, the agents list, and that agents SKAZ can't hold get no gate at all.
"""
from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Callable, Sequence
from dataclasses import dataclass, field
from typing import Any

import httpx
import pytest

from skaz.knowledge.agents.engine import (
    AgentEvent,
    AgentTurn,
    Completed,
    EngineId,
    EngineStatus,
    Failed,
    ModelOption,
    TextDelta,
)
from skaz.knowledge.agents.registry import EngineRegistry
from skaz.knowledge.agents.web import WebLink, WebQuery
from skaz.knowledge.permissions.web_search import WebSearchBroker, WebSearchStore

from .chat_support import connect, finished

LINKS = (WebLink("Second law — Wikipedia", "https://en.wikipedia.org/wiki/Second_law"),
         WebLink("Bad", "javascript:alert(1)"))


@dataclass
class WebEngine:
    """Asks the gate for each query of ``queries``, records the verdicts, then answers."""

    engine_id: EngineId = "claude_code"
    queries: Callable[[AgentTurn], Sequence[str]] = field(default=lambda _turn: ["entropy definition"])
    verdicts: list[tuple[str, bool, str]] = field(default_factory=list)
    turns: list[AgentTurn] = field(default_factory=list)
    _cancels: dict[str, asyncio.Event] = field(default_factory=dict)

    @property
    def id(self) -> EngineId:
        return self.engine_id

    async def status(self) -> EngineStatus:
        return EngineStatus(self.engine_id, installed=True, version="0.0-fake", signed_in=True)

    async def models(self) -> Sequence[ModelOption]:
        return (ModelOption("fake-model", "Fake model"),)

    def active_runs(self) -> set[str]:
        return set(self._cancels)

    def run(self, turn: AgentTurn) -> AsyncIterator[AgentEvent]:
        self._cancels[turn.run_id] = asyncio.Event()
        self.turns.append(turn)
        return self._events(turn)

    async def _events(self, turn: AgentTurn) -> AsyncIterator[AgentEvent]:
        try:
            for number, query in enumerate(self.queries(turn)):
                assert turn.web is not None
                verdict = await turn.web.approve(WebQuery(f"toolu_{number}", query))
                self.verdicts.append((query, verdict.allowed, verdict.message))
                if self._cancels[turn.run_id].is_set():
                    yield Failed(turn.run_id, "cancelled", "The answer was stopped.")
                    return
                if verdict.allowed and verdict.search_id:
                    await turn.web.results(verdict.search_id, LINKS)
            yield TextDelta(turn.run_id, "Готово.")
            yield Completed(turn.run_id)
        finally:
            self._cancels.pop(turn.run_id, None)

    async def interrupt(self, run_id: str) -> None:
        cancel = self._cancels.get(run_id)
        if cancel is not None:
            cancel.set()


@dataclass
class Env:
    client: httpx.AsyncClient
    runtime: Any
    claude: WebEngine
    codex: WebEngine

    async def chat(self, engine: str = "claude_code") -> str:
        response = await self.client.post("/kb/chats", json={"engine": engine})
        assert response.status_code == 201, response.text
        return str(response.json()["id"])

    async def send(self, chat_id: str, text: str = "Найди в интернете") -> None:
        response = await self.client.post(f"/kb/chats/{chat_id}/messages", json={"text": text})
        assert response.status_code == 202, response.text

    async def parts(self, chat_id: str, kind: str = "web_search") -> list[dict[str, Any]]:
        chat = (await self.client.get(f"/kb/chats/{chat_id}")).json()
        return [part for message in chat["messages"] for part in message["parts"] if part["type"] == kind]

    async def pending(self, chat_id: str, count: int = 1) -> dict[str, Any]:
        for _ in range(500):
            found = [part for part in await self.parts(chat_id) if part["status"] == "pending"]
            if len(found) >= 1 and len(await self.parts(chat_id)) >= count:
                return found[-1]
            await asyncio.sleep(0.01)
        raise AssertionError("no pending web search")

    async def decide(self, search_id: str, decision: str) -> httpx.Response:
        return await self.client.post(f"/kb/web-searches/{search_id}/decide", json={"decision": decision})

    async def grant(self, chat_id: str) -> dict[str, Any]:
        return dict((await self.client.get(f"/kb/chats/{chat_id}/web-search")).json())


@pytest.fixture
async def env(kb_app: Any, kb_client: httpx.AsyncClient) -> AsyncIterator[Env]:
    runtime = kb_app.state.runtime
    claude, codex = WebEngine(), WebEngine("codex")
    engines: dict[str, Any] = {"claude_code": claude, "codex": codex, "hermes": WebEngine("hermes"),
                               "opencode": WebEngine("opencode")}
    runtime.kb_agents.registry = EngineRegistry(engines, runtime.kb.settings, cache_s=0.0)  # type: ignore[arg-type]
    await connect(kb_client, runtime)
    yield Env(kb_client, runtime, claude, codex)
    await runtime.kb_chats.close()


async def test_allow_once_shows_the_exact_query_first_then_the_links(env: Env) -> None:
    chat_id = await env.chat()
    await env.send(chat_id)
    part = await env.pending(chat_id)
    assert (part["engine"], part["query"], part["status"], part["auto"]) == (
        "claude_code", "entropy definition", "pending", False)
    assert part["links"] == []
    listed = (await env.client.get("/kb/chats")).json()
    assert next(c for c in listed if c["id"] == chat_id)["waiting_for_user"] is True

    decided = await env.decide(part["id"], "allow")
    assert decided.status_code == 200 and decided.json()["status"] == "allowed"
    await finished(env.runtime.kb_chats)
    (done,) = await env.parts(chat_id)
    # Only http(s) links are kept; each shows its site.
    assert done["links"] == [{"title": "Second law — Wikipedia", "url": "https://en.wikipedia.org/wiki/Second_law",
                              "site": "en.wikipedia.org"}]
    assert env.claude.verdicts == [("entropy definition", True, "")]
    assert (await env.grant(chat_id))["allowed"] is False  # once means once
    assert (await env.decide(part["id"], "allow")).status_code == 409


async def test_deny_tells_the_agent_and_sends_nothing(env: Env) -> None:
    chat_id = await env.chat()
    await env.send(chat_id)
    part = await env.pending(chat_id)
    assert (await env.decide(part["id"], "deny")).json()["status"] == "denied"
    await finished(env.runtime.kb_chats)
    ((_query, allowed, message),) = env.claude.verdicts
    assert allowed is False and "didn't allow" in message
    assert (await env.parts(chat_id))[0]["links"] == []


async def test_allow_in_this_chat_covers_this_chat_only_and_survives_a_restart(env: Env) -> None:
    env.claude.queries = lambda _turn: ["first query", "second query"]
    chat_id = await env.chat()
    await env.send(chat_id)
    first = await env.pending(chat_id)
    assert (await env.decide(first["id"], "allow_chat")).status_code == 200
    await finished(env.runtime.kb_chats)
    _first, second = await env.parts(chat_id)
    # Every query is still held and shown: the second one went without a question, marked as such.
    assert (second["query"], second["status"], second["auto"]) == ("second query", "allowed", True)
    grant = await env.grant(chat_id)
    assert grant["allowed"] is True and grant["granted_at"]

    # Another chat is not covered.
    other = await env.chat()
    env.claude.queries = lambda _turn: ["other chat query"]
    await env.send(other)
    assert (await env.pending(other))["status"] == "pending"
    last = (await env.client.get(f"/kb/chats/{other}")).json()["messages"][-1]["id"]
    await env.runtime.kb_chats.stop(other, last)
    await finished(env.runtime.kb_chats)

    # A restart: a new broker over the same database still knows the chat's grant.
    restarted = WebSearchBroker(WebSearchStore(env.runtime.kb.db), env.runtime.kb_waits)
    assert restarted.store.granted_at(chat_id) is not None and restarted.store.granted_at(other) is None

    # Revoked: the next query asks again.
    revoked = await env.client.delete(f"/kb/chats/{chat_id}/web-search")
    assert revoked.status_code == 200 and revoked.json() == {"allowed": False, "granted_at": None}
    env.claude.queries = lambda _turn: ["third query"]
    await env.send(chat_id)
    third = await env.pending(chat_id, count=3)
    assert (third["query"], third["status"]) == ("third query", "pending")
    await env.decide(third["id"], "deny")
    await finished(env.runtime.kb_chats)


async def test_stop_cancels_a_waiting_query(env: Env) -> None:
    chat_id = await env.chat()
    await env.send(chat_id)
    part = await env.pending(chat_id)
    message_id = (await env.client.get(f"/kb/chats/{chat_id}")).json()["messages"][-1]["id"]
    await env.client.post(f"/kb/chats/{chat_id}/messages/{message_id}/stop")
    await finished(env.runtime.kb_chats)
    (done,) = await env.parts(chat_id)
    assert done["id"] == part["id"] and done["status"] == "cancelled"
    assert env.claude.verdicts[0][1] is False


async def test_agents_skaz_cannot_hold_get_no_web_gate_and_say_why(env: Env) -> None:
    """Their own search gets no gate (stays off); W-3b gives them ``skaz_web_search`` instead
    (``test_w3b_web_tool.py``), so the card says web search runs through a connected searcher."""
    env.codex.queries = lambda _turn: []
    chat_id = await env.chat("codex")
    await env.send(chat_id, "Привет")
    await finished(env.runtime.kb_chats)
    (codex_turn,) = env.codex.turns
    assert codex_turn.web is None
    assert "skaz_web_search" in codex_turn.instructions

    agents = {agent["id"]: agent for agent in (await env.client.get("/kb/agents")).json()["agents"]}
    assert agents["claude_code"]["web_search"] == {"available": True, "reason": None, "through": None}
    for engine in ("codex", "hermes", "opencode"):
        assert agents[engine]["web_search"] == {"available": True, "reason": None, "through": "codex"}


async def test_a_chat_turn_with_web_tells_the_agent_to_keep_queries_free_of_private_data(env: Env) -> None:
    env.claude.queries = lambda _turn: []
    chat_id = await env.chat()
    await env.send(chat_id, "Привет")
    await finished(env.runtime.kb_chats)
    (claude_turn,) = env.claude.turns
    assert claude_turn.web is not None
    assert "never" in claude_turn.instructions and "query" in claude_turn.instructions


async def test_unknown_search_and_bad_decision(env: Env) -> None:
    assert (await env.decide("web-missing", "allow")).status_code == 404
    response = await env.client.post("/kb/web-searches/web-missing/decide", json={"decision": "always"})
    assert response.status_code == 422
    assert (await env.client.get("/kb/chats/chat-missing/web-search")).status_code == 404
