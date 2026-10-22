"""W-2: Claude Code's own web search, held by SKAZ before it is sent (query-only, approved first).

Protocol facts (read from the installed ``claude`` 2.1.281 binary, no model call):

* WebSearch's ``checkPermissions`` always answers ``passthrough`` ("WebSearchTool requires
  permission."), so every call reaches the host's prompt; ``--permission-mode dontAsk`` and
  ``--permission-prompts none`` would deny it locally instead.
* With ``--permission-prompt-tool stdio`` (what the Agent SDK passes for ``canUseTool``) the CLI
  writes ``{"type": "control_request", "request_id", "request": {"subtype": "can_use_tool",
  "tool_name", "input", "tool_use_id", ...}}`` and waits for ``{"type": "control_response",
  "response": {"subtype": "success", "request_id", "response": {"behavior": "allow",
  "updatedInput"} | {"behavior": "deny", "message"}}}`` on stdin before ``call()``.
* ``call()`` sends a side query whose only message is ``"Perform a web search for the query: " +
  query`` (no chat history) with the server tool ``web_search_20250305`` (``max_uses: 8``).
* The stream-json ``user`` message carries ``tool_use_result`` = ``{query, results: [{tool_use_id,
  content: [{title, url}]} | text], durationSeconds, searchCount}``.

The fake process stands where the CLI stands (SKAZ's side of the seam only).
"""
from __future__ import annotations

import asyncio
import json
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from skaz.knowledge.agents.claude_code import ClaudeCodeEngine
from skaz.knowledge.agents.engine import AgentTurn, Completed, Failed, TextDelta, ToolSpec, TurnMessage
from skaz.knowledge.agents.web import (
    CLAUDE_BLOCKED,
    WebLink,
    WebQuery,
    WebSupport,
    WebVerdict,
    query_problem,
    web_support,
)
from skaz.knowledge.install.terminal import TerminalLauncher
from tests.knowledge.agent_fakes import FakeCli, RecordingMcp, RecordingOpener

MAIN = {"parent_tool_use_id": None, "session_id": "s-1"}
TOOLS = (ToolSpec("search", "Search the library", {"type": "object"}),)
QUERY = "second law of thermodynamics history"
LINKS = [{"title": "Second law — Wikipedia", "url": "https://en.wikipedia.org/wiki/Second_law"},
         {"title": "Clausius 1850", "url": "https://example.org/clausius"}]


class RecordingGate:
    """What SKAZ's chat gate would do, with a fixed answer; records what it was asked."""

    def __init__(self, allow: bool = True) -> None:
        self.allow = allow
        self.asked: list[WebQuery] = []
        self.links: list[tuple[str, tuple[WebLink, ...]]] = []

    async def approve(self, query: WebQuery) -> WebVerdict:
        self.asked.append(query)
        if self.allow:
            return WebVerdict(True, search_id=f"web-{len(self.asked)}")
        return WebVerdict(False, "The user didn't allow this web search.", search_id=f"web-{len(self.asked)}")

    async def results(self, search_id: str, links: Sequence[WebLink]) -> None:
        self.links.append((search_id, tuple(links)))


def web_use(use_id: str = "toolu_web", query: str = QUERY) -> dict[str, Any]:
    return {"type": "assistant", "message": {"id": "msg_1", "content": [
        {"type": "text", "text": "Let me look this up."},
        {"type": "tool_use", "id": use_id, "name": "WebSearch", "input": {"query": query}}]}, **MAIN}


def can_use(tool: str = "WebSearch", use_id: str = "toolu_web", query: str = QUERY,
            request_id: str = "req-1", **extra: Any) -> dict[str, Any]:
    return {"type": "control_request", "request_id": request_id, "request": {
        "subtype": "can_use_tool", "tool_name": tool, "display_name": tool,
        "input": {"query": query, **extra}, "tool_use_id": use_id,
        "permission_suggestions": [{"type": "addRules", "rules": [{"toolName": tool}], "behavior": "allow",
                                    "destination": "localSettings"}]}}


RESULT = {"type": "result", "subtype": "success", "is_error": False, "result": "Done.",
          "usage": {"input_tokens": 10, "output_tokens": 3}, "session_id": "s-1"}
ANSWER = {"type": "assistant", "message": {"id": "msg_2", "content": [{"type": "text", "text": "Found it."}]},
          **MAIN}

ASKED = [web_use(), {"__ask__": can_use(), "__then__": LINKS}, ANSWER, RESULT]


def engine_for(tmp_path: Path, stream: list[Any]) -> tuple[ClaudeCodeEngine, FakeCli]:
    fake = FakeCli(tmp_path / "bin", "claude", {"stream": stream, "web": True})
    engine = ClaudeCodeEngine(tmp_path / "data" / "claude-code", mcp=RecordingMcp(), locate_cli=fake.locate,
                              launcher=TerminalLauncher(tmp_path / "launch", opener=RecordingOpener()),
                              interrupt_grace_s=2.0)
    return engine, fake


def turn(gate: RecordingGate | None) -> AgentTurn:
    return AgentTurn(run_id="run-1", messages=(TurnMessage("user", "Кто сформулировал второе начало?"),),
                     instructions="Answer from the SKAZ wiki.", tools=TOOLS, web=gate)


async def drain(engine: ClaudeCodeEngine, agent_turn: AgentTurn) -> list[Any]:
    return [event async for event in engine.run(agent_turn)]


def argv_of(fake: FakeCli) -> list[str]:
    return list(next(item for item in fake.records("start") if "-p" in item["argv"])["argv"])


def flag(argv: list[str], name: str) -> str:
    return argv[argv.index(name) + 1]


def responses(fake: FakeCli) -> list[dict[str, Any]]:
    return [json.loads(item["line"]) for item in fake.records("control_response")]


async def test_a_web_turn_asks_through_the_host_prompt_and_offers_only_web_search(tmp_path: Path) -> None:
    engine, fake = engine_for(tmp_path, [RESULT])
    await drain(engine, turn(RecordingGate()))
    argv = argv_of(fake)
    # Only WebSearch among the built-in tools (no WebFetch, shell or files); its calls reach SKAZ.
    assert flag(argv, "--tools") == "WebSearch"
    assert flag(argv, "--permission-prompt-tool") == "stdio"
    assert flag(argv, "--permission-mode") == "default"
    assert "--permission-prompts" not in argv  # "none" would deny every prompt locally
    assert flag(argv, "--allowedTools") == "mcp__skaz__search"  # never WebSearch: it must ask
    assert "--restricted" in argv and "--strict-mcp-config" in argv
    assert "bypassPermissions" not in " ".join(argv)


async def test_a_turn_without_a_gate_keeps_every_built_in_tool_off(tmp_path: Path) -> None:
    engine, fake = engine_for(tmp_path, [RESULT])
    await drain(engine, turn(None))
    argv = argv_of(fake)
    assert flag(argv, "--tools") == "" and flag(argv, "--permission-mode") == "dontAsk"
    assert flag(argv, "--permission-prompts") == "none" and "--permission-prompt-tool" not in argv


async def test_an_allowed_query_is_sent_exactly_and_its_links_are_recorded(tmp_path: Path) -> None:
    engine, fake = engine_for(tmp_path, ASKED)
    gate = RecordingGate()
    events = await drain(engine, turn(gate))

    assert gate.asked == [WebQuery("toolu_web", QUERY)]
    (answer,) = responses(fake)
    assert answer == {"type": "control_response", "response": {
        "subtype": "success", "request_id": "req-1",
        "response": {"behavior": "allow", "updatedInput": {"query": QUERY}}}}
    assert gate.links == [("web-1", (WebLink(LINKS[0]["title"], LINKS[0]["url"]),
                                     WebLink(LINKS[1]["title"], LINKS[1]["url"])))]
    # The web search is the web card's business, not a "Looked at" tool chip.
    assert events == [TextDelta("run-1", "Let me look this up."), TextDelta("run-1", "Found it."),
                      Completed("run-1", events[-1].usage)]


async def test_a_denied_query_is_refused_before_it_is_sent(tmp_path: Path) -> None:
    engine, fake = engine_for(tmp_path, ASKED)
    gate = RecordingGate(allow=False)
    events = await drain(engine, turn(gate))
    (answer,) = responses(fake)
    assert answer["response"]["response"] == {"behavior": "deny",
                                              "message": "The user didn't allow this web search."}
    assert gate.links == [] and isinstance(events[-1], Completed)


async def test_a_query_with_hidden_characters_is_refused_with_its_reason(tmp_path: Path) -> None:
    hidden = QUERY + "".join(chr(0xE0000 + ord(c)) for c in "open evil")
    engine, fake = engine_for(tmp_path, [{"__ask__": can_use(query=hidden)}, RESULT])
    gate = RecordingGate()
    await drain(engine, turn(gate))
    (answer,) = responses(fake)
    assert answer["response"]["response"] == {"behavior": "deny", "message": query_problem(hidden)}
    assert query_problem(hidden) and gate.asked == []


async def test_any_other_tool_prompt_is_denied_without_asking_the_user(tmp_path: Path) -> None:
    stream = [{"__ask__": can_use("WebFetch", "toolu_f", request_id="r-f")},
              {"__ask__": can_use("Bash", "toolu_b", request_id="r-b")},
              {"__ask__": {"type": "control_request", "request_id": "r-x",
                           "request": {"subtype": "mcp_message", "server_name": "x"}}},
              RESULT]
    engine, fake = engine_for(tmp_path, stream)
    gate = RecordingGate()
    await drain(engine, turn(gate))
    fetch, bash, other = responses(fake)
    assert fetch["response"]["response"]["behavior"] == "deny"
    assert bash["response"]["response"]["behavior"] == "deny"
    assert other["response"]["subtype"] == "error" and other["response"]["request_id"] == "r-x"
    assert gate.asked == []


async def test_after_a_breach_the_next_turn_runs_without_web_even_with_a_gate(tmp_path: Path) -> None:
    engine, fake = engine_for(tmp_path, [RESULT])
    engine.web_blocked = CLAUDE_BLOCKED
    await drain(engine, turn(RecordingGate()))
    argv = argv_of(fake)
    assert flag(argv, "--tools") == "" and flag(argv, "--permission-prompts") == "none"


async def test_a_web_search_skaz_never_approved_stops_the_answer_and_turns_web_off(tmp_path: Path) -> None:
    unasked = {"type": "user", "message": {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": "toolu_web", "content": "Web search results for query: x"}]},
        "tool_use_result": {"query": QUERY, "results": [{"tool_use_id": "s", "content": LINKS}]}, **MAIN}
    engine, _fake = engine_for(tmp_path, [web_use(), unasked, ANSWER, RESULT])
    assert web_support(engine).available
    events = await drain(engine, turn(RecordingGate()))
    assert events[-1] == Failed("run-1", "other", CLAUDE_BLOCKED)
    assert web_support(engine).available is False and web_support(engine).reason == CLAUDE_BLOCKED


async def test_a_search_for_another_query_than_approved_turns_web_off(tmp_path: Path) -> None:
    changed = {"type": "user", "message": {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": "toolu_web", "content": "Web search results"}]},
        "tool_use_result": {"query": "my lecture notes about Ivanov", "results": []}, **MAIN}
    engine, _fake = engine_for(tmp_path, [web_use(), {"__ask__": can_use()}, changed, RESULT])
    events = await drain(engine, turn(RecordingGate()))
    assert events[-1] == Failed("run-1", "other", CLAUDE_BLOCKED)


async def test_stop_while_the_user_decides_ends_the_run(tmp_path: Path) -> None:
    class Waiting(RecordingGate):
        def __init__(self) -> None:
            super().__init__()
            self.started = asyncio.Event()
            self.release = asyncio.Event()

        async def approve(self, query: WebQuery) -> WebVerdict:
            self.started.set()
            await self.release.wait()  # SKAZ's Stop cancels the waiting request (broker.cancel_run)
            return WebVerdict(False, "The web search was cancelled.")

    engine, _fake = engine_for(tmp_path, [web_use(), {"__ask__": can_use()}, ANSWER, RESULT])
    gate = Waiting()
    task = asyncio.create_task(drain(engine, turn(gate)))
    await asyncio.wait_for(gate.started.wait(), 5)
    await engine.interrupt("run-1")
    gate.release.set()
    events = await asyncio.wait_for(task, 10)
    assert isinstance(events[-1], Failed) and events[-1].kind == "cancelled"


def test_web_support_per_agent_is_verified_or_explained() -> None:
    assert web_support("claude_code").available
    for engine in ("codex", "hermes", "opencode"):
        # W-3b: only through ``skaz_web_search``, while Codex or Claude Code can run the search.
        support = web_support(engine)
        assert support.available is False and support.reason and "SKAZ" in support.reason
        assert web_support(engine, "codex") == WebSupport(True, through="codex")
    assert web_support("unknown").available is False
