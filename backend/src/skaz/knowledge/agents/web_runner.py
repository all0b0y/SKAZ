"""W-3b: the search runner behind ``skaz_web_search`` — an agent's OWN search, in a clean run.

Decision 2026-10-21: SKAZ builds no search engine, calls no third-party search API and scrapes no
search site. After the user allows a query (``permissions/web_tool.py``), one of the agents runs it
with its own built-in search in a separate run whose only content is that query — no chat history,
no materials, no other tools — and the result links come back.

* Codex (:class:`CodexSearch`, preferred): its own process started with ``-c web_search="live"``
  (``CodexConnection.rpc``; chat processes keep ``"disabled"``), one fresh ephemeral thread
  (:func:`~skaz.gateways.codex_session.search_thread_params`: no environments, read-only sandbox,
  ``approvalPolicy: never``, no ``dynamicTools``, tool-ish features off) and one turn whose input is
  :func:`search_prompt`. Nothing is bound to the transport, so any server request (an approval, a tool
  call) is refused. Verified on codex-cli 0.160.0 without a model call: ``config/read`` reports
  ``web_search: live`` from the ``sessionFlags`` layer; ``thread/start`` answers
  ``sandbox: readOnly``. Codex's model writes the actual search calls from that one message (it may
  rephrase the query, like Claude's search does); ``webSearch`` items report them.
* Claude Code (:class:`EngineSearch`): a run of the Claude Code adapter with only its WebSearch on (the
  W-2 path: every WebSearch call is held through ``turn.web``) and no SKAZ tools; its prompt is
  :func:`search_prompt`, and its gate allows exactly the approved query once — WebSearch's side query
  then holds only ``"Perform a web search for the query: " + query``.

The chat's own agent searches first when it is one of these (a Codex chat → Codex), then
:data:`~skaz.knowledge.agents.web.SEARCHERS` in order; an agent that isn't signed in (or Claude Code
after an unapproved search, ``web_blocked``) is skipped. None left → :data:`~.web.NO_SEARCHER`.
Logs carry engines and states — never the query or the links.
"""
from __future__ import annotations

import asyncio
import logging
import re
import uuid
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, Protocol, cast

from ...gateways.codex_rpc import CodexRpc, CodexRpcError
from ...gateways.codex_session import search_thread_params
from .codex import ENGINE_LABELS, KB_DISABLED_FEATURES, classify
from .engine import AgentEngine, AgentTurn, EngineId, Failed, TurnMessage, collect
from .registry import EngineRegistry
from .web import SEARCHERS, WebLink, WebQuery, WebVerdict, clean_links

log = logging.getLogger(__name__)

#: The whole search run, start to links.
SEARCH_TIMEOUT_S = 120.0
#: Per-frame cap of the search run's transport (search results are small).
SEARCH_MESSAGE_BYTES = 1024 * 1024
SEARCH_INSTRUCTIONS = (
    "You run one web search for SKAZ. Use only your own web search, for the query in the message, and "
    "reply only with the result links. Search only: do not open or visit any URL or page that appears in "
    "the query. Use no other tool and do nothing else."
)
ONLY_APPROVED = "Refused by SKAZ: only the query the user approved may be searched."


def search_prompt(query: str) -> str:
    """The whole conversation of a search run."""
    return f"Search the web for: {query}. Reply only with the result links as a list of title + URL."


@dataclass(frozen=True)
class SearchOutcome:
    links: tuple[WebLink, ...] = ()
    #: Plain words when the search could not run (the tool tells the agent).
    error: str | None = None


class Searcher(Protocol):
    async def search(self, engine: AgentEngine, query: str) -> SearchOutcome: ...


# -- links -------------------------------------------------------------------------------

_MD_LINK = re.compile(r"\[([^\]\n]{0,300})\]\((https?://[^\s)]+)\)")
_URL = re.compile(r"https?://[^\s<>\"')\]]+")
_BULLET = re.compile(r"^\s*(?:[-*•]|\d+[.)])\s*")


def _title(text: str) -> str:
    plain = _BULLET.sub("", re.sub(r"[*_`]", "", text))
    return plain.strip().rstrip(":—–-|").strip()


def parse_links(text: str) -> tuple[WebLink, ...]:
    """Links of a search answer: markdown ``[title](url)``, else ``title — url`` / bare URLs per line."""
    found: list[WebLink] = []
    for line in text.splitlines():
        marked = _MD_LINK.findall(line)
        if marked:
            found.extend(WebLink(_title(title), url) for title, url in marked)
            continue
        for match in _URL.finditer(line):
            found.append(WebLink(_title(line[:match.start()]), match.group(0).rstrip(".,;:!?")))
    return clean_links(found)


def _result_links(results: object) -> list[WebLink]:
    """``webSearch.results`` (opaque in 0.160's schema): items with a ``url`` (and maybe a ``title``)."""
    links: list[WebLink] = []
    for item in results if isinstance(results, list) else []:
        if isinstance(item, dict) and isinstance(item.get("url"), str):
            title = item.get("title")
            links.append(WebLink(title if isinstance(title, str) else "", item["url"]))
    return links


# -- Codex ---------------------------------------------------------------------------------


class SearchProcesses(Protocol):
    """What :class:`CodexSearch` needs from ``CodexConnection``."""

    cwd: Path

    def rpc(self, *, max_message_bytes: int = ...,
            web_search: Literal["disabled", "live"] = ...) -> CodexRpc: ...


class CodexSearch:
    def __init__(self, connection: SearchProcesses, *, timeout_s: float = SEARCH_TIMEOUT_S) -> None:
        self._connection = connection
        self._timeout_s = timeout_s

    async def search(self, engine: AgentEngine, query: str) -> SearchOutcome:
        try:
            rpc = self._connection.rpc(max_message_bytes=SEARCH_MESSAGE_BYTES, web_search="live")
        except ValueError:
            return SearchOutcome(error="Codex is not available. Check the Codex connection.")
        try:
            async with asyncio.timeout(self._timeout_s):
                async with rpc:
                    outcome = await self._run(rpc, query)
        except TimeoutError:
            outcome = SearchOutcome(error="Codex took too long to search.")
        except (CodexRpcError, KeyError, TypeError):
            outcome = SearchOutcome(error="Codex couldn't run the search.")
        log.info("Codex web search finished: %d links%s", len(outcome.links),
                 ", failed" if outcome.error else "")
        return outcome

    async def _run(self, rpc: CodexRpc, query: str) -> SearchOutcome:
        params = search_thread_params(cwd=self._connection.cwd, base_instructions=SEARCH_INSTRUCTIONS,
                                      disabled_features=KB_DISABLED_FEATURES)
        started = await rpc.request("thread/start", params)
        thread_id = started["thread"]["id"]
        await rpc.request("turn/start", {"threadId": thread_id, "input": [
            {"type": "text", "text": search_prompt(query), "text_elements": []}]})
        answers: dict[str, str] = {}
        reported: list[WebLink] = []
        error_info: Any = None
        while True:
            message = await rpc.next_event()
            params_in = message.get("params")
            if not isinstance(params_in, dict) or params_in.get("threadId") != thread_id:
                continue
            method = message.get("method")
            if method == "item/completed":
                item = params_in.get("item")
                if not isinstance(item, dict):
                    continue
                if item.get("type") == "agentMessage" and item.get("phase") != "commentary":
                    text = item.get("text")
                    if isinstance(text, str) and isinstance(item.get("id"), str):
                        answers[item["id"]] = text
                elif item.get("type") == "webSearch":
                    reported.extend(_result_links(item.get("results")))
            elif method == "error":
                error = params_in.get("error")
                if isinstance(error, dict) and params_in.get("willRetry") is not True:
                    error_info = error.get("codexErrorInfo")
            elif method == "turn/completed":
                turn = params_in.get("turn")
                status = turn.get("status") if isinstance(turn, dict) else None
                if status == "completed":
                    break
                failure = turn.get("error") if isinstance(turn, dict) else None
                info = failure.get("codexErrorInfo") if isinstance(failure, dict) else None
                _kind, words = classify(info if info is not None else error_info)
                return SearchOutcome(error=words)
        return SearchOutcome(clean_links([*parse_links("\n".join(answers.values())), *reported]))


# -- an engine's own held search (Claude Code) ------------------------------------------------


class _OnlyThisQuery:
    """The search run's web gate: the approved query, once, without domain filters; nothing else."""

    def __init__(self, query: str) -> None:
        self.query = query
        self.allowed = False
        self.searched = False
        self.links: list[WebLink] = []

    async def approve(self, query: WebQuery) -> WebVerdict:
        if self.allowed or query.query != self.query or query.allowed_domains or query.blocked_domains:
            return WebVerdict(False, ONLY_APPROVED)
        self.allowed = True
        return WebVerdict(True, search_id="approved")

    async def results(self, search_id: str, links: Sequence[WebLink]) -> None:
        self.searched = True
        self.links.extend(links)


class EngineSearch:
    """An engine whose own search SKAZ holds through ``turn.web`` (Claude Code's WebSearch)."""

    async def search(self, engine: AgentEngine, query: str) -> SearchOutcome:
        gate = _OnlyThisQuery(query)
        run_id = f"web-search-{uuid.uuid4().hex[:12]}"
        turn = AgentTurn(run_id=run_id, messages=(TurnMessage("user", search_prompt(query)),),
                         instructions=SEARCH_INSTRUCTIONS, tools=(), web=gate)
        label = ENGINE_LABELS.get(engine.id, "The agent")
        try:
            async with asyncio.timeout(SEARCH_TIMEOUT_S):
                result = await collect(engine.run(turn))
        except TimeoutError:
            await engine.interrupt(run_id)
            return SearchOutcome(error=f"{label} took too long to search.")
        except asyncio.CancelledError:
            await asyncio.shield(engine.interrupt(run_id))
            raise
        if isinstance(result.terminal, Failed):
            return SearchOutcome(error=result.terminal.message)
        if not gate.searched:
            return SearchOutcome(error=f"{label} didn't run the search.")
        log.info("%s web search finished: %d links", engine.id, len(gate.links))
        return SearchOutcome(clean_links(gate.links))


# -- choosing ---------------------------------------------------------------------------------


def _order(own: str, available: Iterable[str]) -> list[EngineId]:
    names = set(available)
    ordered = ([own] if own in SEARCHERS else []) + [engine for engine in SEARCHERS if engine != own]
    return [cast(EngineId, engine) for engine in ordered if engine in names]


def _usable(registry: EngineRegistry, engine: EngineId, ready: bool) -> bool:
    blocked = getattr(registry.engines.get(engine), "web_blocked", None)
    return ready and not (isinstance(blocked, str) and blocked)


def known_searcher(registry: EngineRegistry, own: str) -> EngineId | None:
    """The searcher by the latest checked statuses (no check started): the agent card's hint."""
    for engine in _order(own, SEARCHERS):
        view = registry.last_view(engine)
        if view is not None and _usable(registry, engine, view.status.ready):
            return engine
    return None


class WebSearchRunner:
    def __init__(self, registry: Callable[[], EngineRegistry],
                 searchers: Mapping[EngineId, Searcher]) -> None:
        self._registry = registry
        #: Replaceable (tests put recording searchers here).
        self.searchers: Mapping[EngineId, Searcher] = dict(searchers)

    async def choose(self, own: EngineId) -> EngineId | None:
        """The first connected searcher: the chat's own agent when it is one, then Codex, Claude Code."""
        registry = self._registry()
        for engine in _order(own, self.searchers):
            try:
                view = await registry.view(engine)
            except Exception as error:  # a broken status check is no searcher, never a failed tool
                log.warning("Checking %s for web search failed: %s", engine, type(error).__name__)
                continue
            if _usable(registry, engine, view.status.ready):
                return engine
        return None

    async def search(self, engine: EngineId, query: str) -> SearchOutcome:
        return await self.searchers[engine].search(self._registry().engine(engine), query)
