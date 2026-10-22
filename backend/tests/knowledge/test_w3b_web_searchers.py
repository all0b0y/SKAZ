"""W-3b: the clean search run behind ``skaz_web_search`` — an agent's OWN built-in search, only the query.

* Codex (``CodexSearch``): a separate ``codex app-server`` process started with
  ``-c web_search="live"`` (verified on codex-cli 0.160.0 with ``config/read``: the ``sessionFlags``
  layer sets the effective ``web_search``; ``WebSearchMode`` = disabled | cached | indexed | live in
  ``generate-json-schema``), one fresh ephemeral thread with no environments, ``sandbox: read-only``,
  ``approvalPolicy: never``, no ``dynamicTools`` and the tool-ish features off; the only input is the
  search instruction with the query. Over the authored stand-in process (protocol, not model quality).
* Claude Code (``EngineSearch``): a run of the real adapter over the fake CLI with only WebSearch on,
  no SKAZ tools, the prompt = the search instruction; only the approved query may run.
* Chat turns keep Codex's own search off (``web_search="disabled"`` per process and per thread).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from skaz.gateways.codex_connection import CodexConnection
from skaz.gateways.codex_rpc import CodexRpc
from skaz.gateways.codex_session import DISABLED_FEATURES
from skaz.knowledge.agents.claude_code import ClaudeCodeEngine
from skaz.knowledge.agents.codex import KB_DISABLED_FEATURES
from skaz.knowledge.agents.web import WebLink
from skaz.knowledge.agents.web_runner import (
    SEARCH_INSTRUCTIONS,
    CodexSearch,
    EngineSearch,
    parse_links,
    search_prompt,
)
from skaz.knowledge.install.terminal import TerminalLauncher
from tests.knowledge.agent_fakes import FakeCli, RecordingMcp, RecordingOpener

FIXTURE = Path(__file__).parent / "fixtures" / "codex_kb_server.py"
MAIN = {"parent_tool_use_id": None, "session_id": "s-1"}


class SearchConnection:
    """``CodexConnection`` stand-in: spawns the authored fixture and records how it was asked to start."""

    def __init__(self, root: Path) -> None:
        self.cwd = root
        self.binary: str | None = sys.executable
        self.log = root / "codex-log.jsonl"
        self.started: list[dict[str, Any]] = []

    def rpc(self, *, max_message_bytes: int = 1024 * 1024, web_search: str = "disabled") -> CodexRpc:
        self.started.append({"web_search": web_search})
        return CodexRpc((sys.executable, str(FIXTURE), str(self.log)), cwd=self.cwd, env={},
                        max_message_bytes=max_message_bytes)

    def received(self, method: str) -> list[dict[str, Any]]:
        lines = self.log.read_text(encoding="utf-8").splitlines() if self.log.exists() else []
        return [message for message in map(json.loads, lines) if message.get("method") == method]


class NoEngine:
    id = "codex"


async def test_codex_searches_in_a_fresh_thread_that_holds_only_the_query(tmp_path: Path) -> None:
    connection = SearchConnection(tmp_path)
    query = "case:websearch entropy definition"
    outcome = await CodexSearch(connection).search(NoEngine(), query)  # type: ignore[arg-type]

    assert connection.started == [{"web_search": "live"}]  # its own process, web search on
    (started,) = connection.received("thread/start")
    params = started["params"]
    assert params["ephemeral"] is True and params["environments"] == [] and params["dynamicTools"] == []
    assert params["approvalPolicy"] == "never" and params["sandbox"] == "read-only"
    assert params["config"]["web_search"] == "live"
    assert all(params["config"][f"features.{name}"] is False for name in KB_DISABLED_FEATURES)
    assert params["baseInstructions"] == SEARCH_INSTRUCTIONS
    assert "model" not in params
    (turn,) = connection.received("turn/start")
    # The run's only content: the search instruction with the query — no history, no materials.
    assert turn["params"]["input"] == [{"type": "text", "text": search_prompt(query), "text_elements": []}]
    assert set(turn["params"]) == {"threadId", "input"}
    assert search_prompt(query) == (f"Search the web for: {query}. Reply only with the result links as a "
                                    "list of title + URL.")

    assert outcome.error is None
    assert outcome.links == (
        WebLink("Entropy — Wikipedia", "https://en.wikipedia.org/wiki/Entropy"),
        WebLink("Entropy (Stanford Encyclopedia)", "https://plato.stanford.edu/entries/entropy/"),
        WebLink("Entropy — Britannica", "https://www.britannica.com/science/entropy"),
    )


async def test_a_codex_search_that_fails_says_so(tmp_path: Path) -> None:
    connection = SearchConnection(tmp_path)
    outcome = await CodexSearch(connection).search(NoEngine(), "case:auth x")  # type: ignore[arg-type]
    assert outcome.links == () and outcome.error == "Codex needs you to sign in again."


async def test_a_codex_request_for_anything_else_is_refused(tmp_path: Path) -> None:
    """An approval (or any server request) in the search run is refused: no tools are bound."""
    connection = SearchConnection(tmp_path)
    outcome = await CodexSearch(connection).search(NoEngine(), "case:approval x")  # type: ignore[arg-type]
    assert outcome.error is None and outcome.links == ()
    reply = [json.loads(line) for line in connection.log.read_text(encoding="utf-8").splitlines()
             if json.loads(line).get("id") == "approval-1"]
    assert reply and "error" in reply[0]


def test_chat_processes_keep_codex_search_off_and_only_the_searcher_turns_it_on(tmp_path: Path) -> None:
    connection = CodexConnection(tmp_path / "codex")
    connection.binary = "/fixture/codex"
    chat = connection.rpc()._command
    search = connection.rpc(web_search="live")._command
    assert 'web_search="disabled"' in chat and 'web_search="live"' not in chat
    assert 'web_search="live"' in search and 'web_search="disabled"' not in search
    for command in (chat, search):
        assert all(f"features.{name}=false" in command for name in DISABLED_FEATURES)


def test_links_are_read_from_markdown_and_plain_lines() -> None:
    text = ("1. [A](https://a.example/x)\n"
            "2. **B** — https://b.example/y\n"
            "Plain https://c.example/z.\n"
            "[A again](https://a.example/x)\n"
            "not a link: ftp://d.example\n")
    assert parse_links(text) == (WebLink("A", "https://a.example/x"), WebLink("B", "https://b.example/y"),
                                 WebLink("Plain", "https://c.example/z"))


# -- Claude Code's own WebSearch -------------------------------------------------------------

LINKS = [{"title": "Entropy — Wikipedia", "url": "https://en.wikipedia.org/wiki/Entropy"}]
RESULT = {"type": "result", "subtype": "success", "is_error": False, "result": "Done.",
          "usage": {"input_tokens": 10, "output_tokens": 3}, "session_id": "s-1"}


def web_use(query: str, use_id: str = "toolu_web") -> dict[str, Any]:
    return {"type": "assistant", "message": {"id": "msg_1", "content": [
        {"type": "tool_use", "id": use_id, "name": "WebSearch", "input": {"query": query}}]}, **MAIN}


def can_use(query: str, use_id: str = "toolu_web", request_id: str = "req-1") -> dict[str, Any]:
    return {"type": "control_request", "request_id": request_id, "request": {
        "subtype": "can_use_tool", "tool_name": "WebSearch", "input": {"query": query},
        "tool_use_id": use_id}}


def claude(tmp_path: Path, stream: list[Any]) -> tuple[ClaudeCodeEngine, FakeCli]:
    fake = FakeCli(tmp_path / "bin", "claude", {"stream": stream, "web": True})
    engine = ClaudeCodeEngine(tmp_path / "data" / "claude-code", mcp=RecordingMcp(), locate_cli=fake.locate,
                              launcher=TerminalLauncher(tmp_path / "launch", opener=RecordingOpener()),
                              interrupt_grace_s=2.0)
    return engine, fake


async def test_claude_code_searches_the_approved_query_alone(tmp_path: Path) -> None:
    query = "entropy definition"
    engine, fake = claude(tmp_path, [web_use(query), {"__ask__": can_use(query), "__then__": LINKS}, RESULT])
    outcome = await EngineSearch().search(engine, query)
    assert outcome == type(outcome)((WebLink("Entropy — Wikipedia", "https://en.wikipedia.org/wiki/Entropy"),))

    argv = next(item for item in fake.records("start") if "-p" in item["argv"])["argv"]
    assert argv[argv.index("--tools") + 1] == "WebSearch"
    assert argv[argv.index("--disallowedTools") + 1] == "mcp__*" and "--mcp-config" not in argv
    (prompt,) = fake.records("system_prompt")
    assert prompt["text"] == SEARCH_INSTRUCTIONS
    (stdin,) = fake.records("stdin")
    sent = json.loads(stdin["line"])["message"]["content"]
    assert sent == search_prompt(query)  # the whole conversation of the search run
    (answer,) = [json.loads(item["line"]) for item in fake.records("control_response")]
    assert answer["response"]["response"] == {"behavior": "allow", "updatedInput": {"query": query}}


async def test_claude_code_may_not_search_anything_but_the_approved_query(tmp_path: Path) -> None:
    engine, fake = claude(tmp_path, [web_use("my lecture notes"),
                                     {"__ask__": can_use("my lecture notes"), "__then__": LINKS}, RESULT])
    outcome = await EngineSearch().search(engine, "entropy definition")
    (answer,) = [json.loads(item["line"]) for item in fake.records("control_response")]
    assert answer["response"]["response"]["behavior"] == "deny"
    assert outcome.links == () and outcome.error == "Claude Code didn't run the search."
