"""W-3b: ``skaz_web_search`` — Codex, Hermes and OpenCode chats search the web only through SKAZ.

The chat agent is a scripted engine at the agent seam: it calls the SKAZ tool the way Codex's
``dynamicTools`` call or an MCP ``tools/call`` would (``ToolRegistry.call`` with the run's context).
The searcher is a recording stand-in for the clean search run (``test_w3b_web_searchers.py`` covers
the real Codex / Claude Code runs over their fakes): this file proves SKAZ's side — the tool is offered
only in chats of agents without a held search of their own, the query waits for the same card as
Claude Code's (Allow once / Allow in this chat / Deny), nothing is searched before Allow or after
Deny, only the query reaches the searcher, the links come back and are recorded, and with no
searcher connected the agent gets a plain reason and no card.
"""
from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass, field
from typing import Any

import httpx
import pytest

from skaz.knowledge.agents.engine import (
    AgentEngine,
    AgentEvent,
    AgentTurn,
    Completed,
    EngineId,
    EngineStatus,
    ModelOption,
    TextDelta,
)
from skaz.knowledge.agents.registry import EngineRegistry
from skaz.knowledge.agents.tools import ToolContext
from skaz.knowledge.agents.web import NO_SEARCHER, WebLink
from skaz.knowledge.agents.web_runner import SearchOutcome
from skaz.knowledge.permissions.web_search import DENIED
from skaz.knowledge.permissions.web_tool import WEB_TOOL

from .chat_support import connect, finished

LINKS = (WebLink("Entropy — Wikipedia", "https://en.wikipedia.org/wiki/Entropy"),
         WebLink("Bad", "javascript:alert(1)"))


@dataclass
class ChatAgent:
    """A chat agent that calls ``skaz_web_search`` once per query, keeping each tool output."""

    engine_id: EngineId
    runtime: Any
    signed_in: bool = True
    queries: list[str] = field(default_factory=lambda: ["entropy definition"])
    turns: list[AgentTurn] = field(default_factory=list)
    outputs: list[tuple[str, bool]] = field(default_factory=list)
    web_blocked: str | None = None

    @property
    def id(self) -> EngineId:
        return self.engine_id

    async def status(self) -> EngineStatus:
        return EngineStatus(self.engine_id, installed=True, version="0.0-fake", signed_in=self.signed_in,
                            reason=None if self.signed_in else "Sign in.")

    async def models(self) -> Sequence[ModelOption]:
        return (ModelOption("fake-model", "Fake model"),)

    def run(self, turn: AgentTurn) -> AsyncIterator[AgentEvent]:
        self.turns.append(turn)
        return self._events(turn)

    async def _events(self, turn: AgentTurn) -> AsyncIterator[AgentEvent]:
        offered = {spec.name for spec in turn.tools or ()}
        for query in self.queries if WEB_TOOL in offered else []:
            outcome = await self.runtime.kb_tools.call(WEB_TOOL, {"query": query},
                                                       ToolContext(turn.run_id, self.engine_id))
            self.outputs.append((outcome.text, outcome.is_error))
        yield TextDelta(turn.run_id, "Готово.")
        yield Completed(turn.run_id)

    async def interrupt(self, run_id: str) -> None:
        return None


@dataclass
class RecordingSearcher:
    """The clean search run's stand-in: what it was given, and fixed links."""

    calls: list[tuple[str, str]] = field(default_factory=list)
    links: tuple[WebLink, ...] = LINKS
    error: str | None = None

    async def search(self, engine: AgentEngine, query: str) -> SearchOutcome:
        self.calls.append((engine.id, query))
        return SearchOutcome(self.links, self.error)


@dataclass
class Env:
    client: httpx.AsyncClient
    runtime: Any
    agents: dict[str, ChatAgent]
    codex_search: RecordingSearcher
    claude_search: RecordingSearcher

    async def chat(self, engine: str) -> str:
        response = await self.client.post("/kb/chats", json={"engine": engine})
        assert response.status_code == 201, response.text
        return str(response.json()["id"])

    async def send(self, chat_id: str, text: str = "Найди в интернете") -> None:
        response = await self.client.post(f"/kb/chats/{chat_id}/messages", json={"text": text})
        assert response.status_code == 202, response.text

    async def parts(self, chat_id: str) -> list[dict[str, Any]]:
        chat = (await self.client.get(f"/kb/chats/{chat_id}")).json()
        return [part for message in chat["messages"] for part in message["parts"]
                if part["type"] == "web_search"]

    async def pending(self, chat_id: str) -> dict[str, Any]:
        for _ in range(500):
            found = [part for part in await self.parts(chat_id) if part["status"] == "pending"]
            if found:
                return found[-1]
            await asyncio.sleep(0.01)
        raise AssertionError("no pending web search")

    async def decide(self, search_id: str, decision: str) -> httpx.Response:
        return await self.client.post(f"/kb/web-searches/{search_id}/decide", json={"decision": decision})

    async def agents_view(self) -> dict[str, dict[str, Any]]:
        return {agent["id"]: agent for agent in (await self.client.get("/kb/agents")).json()["agents"]}


@pytest.fixture
async def env(kb_app: Any, kb_client: httpx.AsyncClient) -> AsyncIterator[Env]:
    runtime = kb_app.state.runtime
    agents = {engine: ChatAgent(engine, runtime) for engine in ("codex", "claude_code", "hermes", "opencode")}
    runtime.kb_agents.registry = EngineRegistry(agents, runtime.kb.settings, cache_s=0.0)  # type: ignore[arg-type]
    codex_search, claude_search = RecordingSearcher(), RecordingSearcher()
    runtime.kb_web_search.searchers = {"codex": codex_search, "claude_code": claude_search}
    await connect(kb_client, runtime)
    yield Env(kb_client, runtime, agents, codex_search, claude_search)
    await runtime.kb_chats.close()


def payload(output: tuple[str, bool]) -> dict[str, Any]:
    text, _error = output
    data: dict[str, Any] = json.loads(text)
    return data


@pytest.mark.parametrize("engine", ["codex", "hermes", "opencode"])
async def test_offered_in_chats_of_agents_without_a_held_search_of_their_own(env: Env, engine: str) -> None:
    env.agents[engine].queries = []
    chat_id = await env.chat(engine)
    await env.send(chat_id, "Привет")
    await finished(env.runtime.kb_chats)
    (turn,) = env.agents[engine].turns
    assert WEB_TOOL in {spec.name for spec in turn.tools or ()}
    # The agent's own built-in search is never given a gate: it stays off (W-2 rules stand).
    assert turn.web is None
    # The agent is told that web search exists only through this tool, and that the user sees each query.
    assert WEB_TOOL in turn.instructions and "shows each query to the user" in turn.instructions
    assert "can't search the web" not in turn.instructions


async def test_claude_code_chats_keep_their_own_held_websearch_and_get_no_tool(env: Env) -> None:
    env.agents["claude_code"].queries = []
    chat_id = await env.chat("claude_code")
    await env.send(chat_id, "Привет")
    await finished(env.runtime.kb_chats)
    (turn,) = env.agents["claude_code"].turns
    assert WEB_TOOL not in {spec.name for spec in turn.tools or ()}
    assert turn.web is not None and WEB_TOOL not in turn.instructions


async def test_the_query_waits_for_allow_then_only_it_is_searched_and_the_links_return(env: Env) -> None:
    chat_id = await env.chat("codex")
    await env.send(chat_id)
    part = await env.pending(chat_id)
    assert (part["engine"], part["query"], part["searcher"], part["status"]) == (
        "codex", "entropy definition", "codex", "pending")
    await asyncio.sleep(0.05)
    assert env.codex_search.calls == [] and env.claude_search.calls == []  # held until the user answers

    assert (await env.decide(part["id"], "allow")).status_code == 200
    await finished(env.runtime.kb_chats)
    # The search run got the approved query and nothing else.
    assert env.codex_search.calls == [("codex", "entropy definition")]
    assert env.claude_search.calls == []
    (output,) = env.agents["codex"].outputs
    data = payload(output)
    assert output[1] is False and data["status"] == "ok" and data["searched_with"] == "Codex"
    assert data["links"] == [{"title": "Entropy — Wikipedia", "url": "https://en.wikipedia.org/wiki/Entropy"}]
    (done,) = await env.parts(chat_id)
    assert done["status"] == "allowed" and done["links"] == [
        {"title": "Entropy — Wikipedia", "url": "https://en.wikipedia.org/wiki/Entropy",
         "site": "en.wikipedia.org"}]


async def test_deny_sends_nothing_and_tells_the_agent(env: Env) -> None:
    chat_id = await env.chat("hermes")
    await env.send(chat_id)
    part = await env.pending(chat_id)
    assert (await env.decide(part["id"], "deny")).status_code == 200
    await finished(env.runtime.kb_chats)
    assert env.codex_search.calls == [] and env.claude_search.calls == []
    (output,) = env.agents["hermes"].outputs
    assert payload(output) == {"status": "denied", "message": DENIED}
    assert (await env.parts(chat_id))[0]["links"] == []


async def test_allow_in_this_chat_still_shows_each_query_and_searches_each(env: Env) -> None:
    env.agents["opencode"].queries = ["first query", "second query"]
    chat_id = await env.chat("opencode")
    await env.send(chat_id)
    first = await env.pending(chat_id)
    assert (await env.decide(first["id"], "allow_chat")).status_code == 200
    await finished(env.runtime.kb_chats)
    _first, second = await env.parts(chat_id)
    assert (second["query"], second["status"], second["auto"]) == ("second query", "allowed", True)
    assert env.codex_search.calls == [("codex", "first query"), ("codex", "second query")]


async def test_claude_code_searches_when_codex_is_not_signed_in(env: Env) -> None:
    env.agents["codex"].signed_in = False
    chat_id = await env.chat("hermes")
    await env.send(chat_id)
    part = await env.pending(chat_id)
    assert part["searcher"] == "claude_code"
    await env.decide(part["id"], "allow")
    await finished(env.runtime.kb_chats)
    assert env.claude_search.calls == [("claude_code", "entropy definition")] and env.codex_search.calls == []
    assert payload(env.agents["hermes"].outputs[0])["searched_with"] == "Claude Code"


async def test_a_claude_code_that_searched_unasked_is_no_searcher(env: Env) -> None:
    env.agents["codex"].signed_in = False
    env.agents["claude_code"].web_blocked = "Claude Code searched the web without SKAZ's approval."
    chat_id = await env.chat("opencode")
    await env.send(chat_id)
    await finished(env.runtime.kb_chats)
    (output,) = env.agents["opencode"].outputs
    assert output[1] is True and payload(output) == {"status": "error", "reason": NO_SEARCHER}


async def test_no_searcher_connected_gives_the_reason_and_no_card(env: Env) -> None:
    env.agents["codex"].signed_in = False
    env.agents["claude_code"].signed_in = False
    chat_id = await env.chat("hermes")
    await env.send(chat_id)
    await finished(env.runtime.kb_chats)
    (output,) = env.agents["hermes"].outputs
    assert output[1] is True and payload(output) == {"status": "error", "reason": NO_SEARCHER}
    assert NO_SEARCHER == "Web search needs Codex or Claude Code signed in in SKAZ."
    assert await env.parts(chat_id) == []  # nothing could be sent, so nothing is asked
    assert env.codex_search.calls == [] and env.claude_search.calls == []


async def test_a_failed_search_says_so_and_records_no_links(env: Env) -> None:
    env.codex_search.error = "Codex couldn't run the search."
    env.codex_search.links = ()
    chat_id = await env.chat("codex")
    await env.send(chat_id)
    part = await env.pending(chat_id)
    await env.decide(part["id"], "allow")
    await finished(env.runtime.kb_chats)
    (output,) = env.agents["codex"].outputs
    assert output[1] is True
    assert payload(output) == {"status": "error", "reason": "Codex couldn't run the search."}


async def test_outside_a_chat_and_overlong_queries_are_refused(env: Env) -> None:
    context = ToolContext("run-unknown", "codex")
    outside = await env.runtime.kb_tools.call(WEB_TOOL, {"query": "x"}, context)
    assert outside.is_error and "only possible in a chat" in outside.text
    too_long = await env.runtime.kb_tools.call(WEB_TOOL, {"query": "x" * 401}, context)
    assert too_long.is_error and "query" in too_long.text
    assert env.codex_search.calls == []


async def test_agent_cards_say_web_search_is_available_with_approval_through_a_searcher(env: Env) -> None:
    agents = await env.agents_view()
    assert agents["claude_code"]["web_search"] == {"available": True, "reason": None, "through": None}
    for engine in ("codex", "hermes", "opencode"):
        assert agents[engine]["web_search"] == {"available": True, "reason": None, "through": "codex"}

    env.agents["codex"].signed_in = False
    agents = await env.agents_view()
    assert agents["hermes"]["web_search"]["through"] == "claude_code"

    env.agents["claude_code"].signed_in = False
    agents = await env.agents_view()
    for engine in ("codex", "hermes", "opencode"):
        assert agents[engine]["web_search"] == {"available": False, "reason": NO_SEARCHER, "through": None}


async def test_wiki_jobs_and_ingest_never_get_the_tool(env: Env) -> None:
    """Wiki jobs, ingest and the test judge build turns with ``tools=None`` (no tools of any kind)."""
    import inspect

    from skaz.knowledge.ingest import runner
    from skaz.knowledge.study import judge
    from skaz.knowledge.wiki import agent

    for module in (runner, judge, agent):
        source = inspect.getsource(module)
        assert "AgentTurn(" in source and "tools=None" in source and WEB_TOOL not in source


async def test_a_stopped_answer_cancels_the_waiting_query_and_searches_nothing(env: Env) -> None:
    chat_id = await env.chat("codex")
    await env.send(chat_id)
    part = await env.pending(chat_id)
    message_id = (await env.client.get(f"/kb/chats/{chat_id}")).json()["messages"][-1]["id"]
    await env.client.post(f"/kb/chats/{chat_id}/messages/{message_id}/stop")
    await finished(env.runtime.kb_chats)
    (done,) = await env.parts(chat_id)
    assert done["id"] == part["id"] and done["status"] == "cancelled"
    assert env.codex_search.calls == []


def test_a_database_of_w2_gains_the_searcher_column() -> None:
    import sqlite3
    from types import SimpleNamespace

    from skaz.knowledge.store.schema import apply_schemas, web_search

    old_sql = web_search.SQL.replace("    decided_at  TEXT,\n", "    decided_at  TEXT\n")
    old_sql = "\n".join(line for line in old_sql.splitlines()
                        if "searcher" not in line and "W-3b" not in line)
    connection = sqlite3.connect(":memory:")
    apply_schemas(connection, [SimpleNamespace(NAME="web_search", VERSION=1, SQL=old_sql)])
    assert "searcher" not in {row[1] for row in connection.execute("PRAGMA table_info(web_search_requests)")}
    apply_schemas(connection, [web_search])
    assert "searcher" in {row[1] for row in connection.execute("PRAGMA table_info(web_search_requests)")}
