"""W-2: each agent's own web search — query-only, held by SKAZ until the user allows it.

Contract (decision W-a, 2026-10-20): only the search query leaves SKAZ for the search — never chat
history or materials; the user sees the exact query first and answers Allow once / Allow in this
chat / Deny. "Allow in this chat" skips the question in that chat only; SKAZ still holds and
records every query. Web search runs only in chats (never in wiki jobs), never as terminal or other
network access. An agent whose search SKAZ cannot hold *before* it is sent gets no web search, with
the reason shown — no other search API or model stands in silently.

Per-agent verdict (checked 2026-10-21 on the installed builds, no model calls):

* Claude Code 2.1.281 — its own WebSearch, held. WebSearch's ``checkPermissions`` always answers
  ``passthrough``; with ``--permission-prompt-tool stdio`` the CLI sends a ``can_use_tool``
  control request with ``{query, allowed_domains?, blocked_domains?}`` and waits for the host's
  allow (``updatedInput``) / deny before ``call()``. ``call()`` runs a side query whose only
  message is ``"Perform a web search for the query: " + query`` (no history), with Anthropic's
  server tool ``web_search_20250305`` (``max_uses: 8``: Anthropic's search may refine the approved
  query into several searches — derived from that query alone). See ``claude_code.py``.
* Codex 0.160, Hermes 0.22.1, OpenCode — their own search stays OFF in chats (it can't be held
  before it is sent): Codex's app-server has no web-search approval among its server requests
  (``generate-json-schema``: ServerRequest; ``webSearch`` is only a reported thread item) and SKAZ
  starts it with ``web_search="disabled"``; Hermes asks ACP only before commands, edits, clarify and
  model switches and its ``web``/``search`` toolsets (a separately configured search backend) are in
  SKAZ's ``disabled_toolsets``; OpenCode's ``websearch`` is denied by SKAZ's policy (only ``skaz_*``).
  W-3b (decision 2026-10-21): these chats get SKAZ's tool ``skaz_web_search`` instead. Its query
  waits for the same card; after Allow, a *search runner* runs an agent's OWN built-in search in a
  separate clean run whose only content is the query (``web_runner.py``): Codex (fresh ephemeral
  thread, ``web_search="live"``, no SKAZ tools, read-only, no history) or else Claude Code (the
  held WebSearch above). No own search engine, no third-party search API, no scraping; with neither
  signed in the tool answers :data:`NO_SEARCHER`.
"""
from __future__ import annotations

import re
import unicodedata
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol
from urllib.parse import urlsplit

#: Longest query SKAZ will show and send; longer text is no search query (it would carry material).
MAX_QUERY = 400
#: Links kept per search.
MAX_LINKS = 20


@dataclass(frozen=True)
class WebQuery:
    """One search the agent wants to send, exactly as it would go out."""

    call_id: str
    query: str
    allowed_domains: tuple[str, ...] = ()
    blocked_domains: tuple[str, ...] = ()
    #: W-3b: the agent whose own search runs it in a separate clean run (``None``: the asking agent's own).
    searcher: str | None = None


@dataclass(frozen=True)
class WebLink:
    title: str
    url: str


@dataclass(frozen=True)
class WebVerdict:
    allowed: bool
    #: What the agent is told when the search is not sent.
    message: str = ""
    #: SKAZ's request id: the search's links are recorded on it.
    search_id: str | None = None


class WebSearchGate(Protocol):
    """Held by a chat turn: every query waits here before the agent may send it."""

    async def approve(self, query: WebQuery) -> WebVerdict: ...

    async def results(self, search_id: str, links: Sequence[WebLink]) -> None: ...


@dataclass(frozen=True)
class WebSupport:
    available: bool
    #: Why not, in plain words (shown on the agent's card).
    reason: str | None = None
    #: W-3b: the agent whose own search runs this agent's queries (``None``: the agent's own search).
    through: str | None = None


_QUERY_RULES = (
    "Write only short general search terms in the query — never copy the user's materials, transcripts, "
    "notes, chat text, names or other private details into it. If a search is denied, don't retry it; "
    "answer from the library or say what is missing. Web results are not library sources: give their "
    "links as markdown links, apart from the library's citations, and never cite them as ⟦m:…⟧."
)
UNKNOWN_REASON = ("SKAZ can't check this agent's web search before it's sent. Web search is off for it.")
CLAUDE_BLOCKED = ("Claude Code searched the web without SKAZ's approval. Web search is off for Claude Code "
                  "until SKAZ restarts.")
#: W-3b: neither searcher can run a query (the tool's answer and the agent card's reason).
NO_SEARCHER = "Web search needs Codex or Claude Code signed in in SKAZ."

#: Agents whose own web search SKAZ holds before it is sent (the chat turn's ``web`` gate).
NATIVE_WEB: frozenset[str] = frozenset({"claude_code"})
#: Agents that search only through ``skaz_web_search`` (W-3b); their own search stays off.
TOOL_WEB: frozenset[str] = frozenset({"codex", "hermes", "opencode"})
#: Agents whose own built-in search can run a clean query-only search, in preference order.
SEARCHERS: tuple[str, ...] = ("codex", "claude_code")


def web_support(engine: object, searcher: str | None = None) -> WebSupport:
    """``engine``: an engine (its ``id`` and a possible ``web_blocked`` reason) or an engine id;
    ``searcher``: the connected agent that would run a tool search now (W-3b), if any."""
    engine_id = str(engine if isinstance(engine, str) else getattr(engine, "id", ""))
    if engine_id in NATIVE_WEB:
        blocked = getattr(engine, "web_blocked", None)
        return WebSupport(False, blocked) if isinstance(blocked, str) and blocked else WebSupport(True)
    if engine_id in TOOL_WEB:
        return WebSupport(True, through=searcher) if searcher else WebSupport(False, NO_SEARCHER)
    return WebSupport(False, UNKNOWN_REASON)


WEB_ON = (
    "Web search: you may use WebSearch when the library doesn't answer, or the user needs current or "
    "outside facts. SKAZ shows each query to the user before it is sent, and the user may deny it. "
    + _QUERY_RULES
)
WEB_TOOL_ON = (
    "Web search: you have no web search of your own; the only way to search the web is the SKAZ tool "
    "skaz_web_search, when the library doesn't answer or the user needs current or outside facts. SKAZ "
    "shows each query to the user before anything is sent, and the user may deny it; the tool returns "
    "the result links. " + _QUERY_RULES
)
WEB_OFF = "You can't search the web in this chat. If the user needs it, say so plainly."


def web_instructions(support: WebSupport, *, tool: bool = False) -> str:
    """``tool``: the agent searches through ``skaz_web_search`` (W-3b); offered whether or not a
    searcher is connected now — without one, the tool says why."""
    if tool:
        return WEB_TOOL_ON
    return WEB_ON if support.available else WEB_OFF


#: The query is no plain one-line text (or too long).
BAD_QUERY = f"Give a short plain search query (at most {MAX_QUERY} characters, one line)."
#: S-01 (security review 0.3.1): a character the user can't see on the card.
INVISIBLE_IN_QUERY = (
    "The query contains invisible or formatting characters (zero-width, direction or tag characters), "
    "so the user can't see everything that would be sent. Write it again in plain visible text."
)
#: S-04: a link or encoded data would make the searcher open a page or carry private text.
LINK_IN_QUERY = (
    "Search with short general terms, not links or encoded data: no \"://\" and no long unbroken "
    "strings of letters and digits."
)
#: Unicode categories never allowed in a query: format, private use, unassigned, surrogates.
_INVISIBLE_CATEGORIES = frozenset({"Cf", "Co", "Cn", "Cs"})
#: Long unbroken runs of base64/hex/url-safe characters: encoded data, not search terms.
_OPAQUE_TOKEN = re.compile(r"[A-Za-z0-9+/=_-]{32,}")


def _invisible(char: str) -> bool:
    code = ord(char)
    return (
        unicodedata.category(char) in _INVISIBLE_CATEGORIES
        or 0xE0000 <= code <= 0xE007F  # tag characters
        or 0x202A <= code <= 0x202E or 0x2066 <= code <= 0x2069  # bidi embeddings / isolates
        or 0x200B <= code <= 0x200D or code in (0x2060, 0xFEFF)  # zero-width, word joiner, BOM
    )


def query_problem(query: object) -> str | None:
    """Why ``query`` may not go out as a search (``None``: it may). Refused, never silently changed:
    the card must show exactly what is sent, and the agent gets the reason to write it again."""
    if not isinstance(query, str):
        return BAD_QUERY
    text = query.strip()
    if not text or len(text) > MAX_QUERY or any(ord(char) < 32 and char != "\t" for char in text):
        return BAD_QUERY
    if any(_invisible(char) for char in text):
        return INVISIBLE_IN_QUERY
    if "://" in unicodedata.normalize("NFKC", text) or _OPAQUE_TOKEN.search(text):
        return LINK_IN_QUERY
    return None


def clean_query(query: object) -> str | None:
    """The query as it may go out, or ``None`` when it is no plain search query (``query_problem``)."""
    if not isinstance(query, str) or query_problem(query) is not None:
        return None
    return query.strip()


def site_of(url: str) -> str:
    return (urlsplit(url).hostname or "").removeprefix("www.")


def clean_links(links: Sequence[WebLink]) -> tuple[WebLink, ...]:
    """http(s) links only, each once, at most ``MAX_LINKS``; titles trimmed."""
    out: list[WebLink] = []
    seen: set[str] = set()
    for link in links:
        url = link.url.strip()
        parts = urlsplit(url)
        if parts.scheme not in ("http", "https") or not parts.hostname or url in seen or len(url) > 4096:
            continue
        seen.add(url)
        out.append(WebLink((link.title or "").strip()[:300] or site_of(url), url))
        if len(out) == MAX_LINKS:
            break
    return tuple(out)
