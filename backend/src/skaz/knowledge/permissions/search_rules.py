"""N7: the user's search rules — kept by SKAZ's code, not by the model.

Three kinds of web rules (N7 decision 1):

* **Never** sites — hard. Sent to an engine that can filter (Claude Code's WebSearch
  ``blocked_domains``, honoured by Anthropic) *and* removed by SKAZ from every result before the
  chat agent gets it.
* **Only these sites** (a switch + a list) — hard the same way: links outside the list are removed.
* **Prefer** sites — soft: a hint in the agent's instructions, shown on the search card.

Levels (decision 2, revised): global rules in Settings → Search, and changes for one chat from the
composer panel. A chat starts from Settings; it may add its own Never sites but never lifts a global
one. A domain covers its subdomains (``example.com`` → ``*.example.com``). The user's own «Add
link» is not a search and is never restricted here.

The chat part also holds the chat's library sources (N7-4: All / Only these / Excluded) and the
one-shot «Search everywhere once» the user clicked on a card (lifts «only these sites» for the next
search of that chat; Never still applies).

Logs carry chat ids only — never sites or queries.
"""
from __future__ import annotations

import contextlib
import json
import re
import sqlite3
import unicodedata
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from typing import Any, Literal, Protocol
from urllib.parse import urlsplit

from ..agents.web import WebLink, link_host
from ..errors import KnowledgeError
from ..ids import utc_now, utc_now_ms
from ..store.database import KnowledgeDatabase

#: Settings key of the global web rules (``settings`` table of ``knowledge.sqlite3``).
SETTINGS_KEY = "search_rules"
#: Most sites in one list (a longer list is refused, never cut silently).
MAX_SITES = 100
#: Most library sources a chat may pin or exclude.
MAX_SOURCES = 200

RulesOrigin = Literal["settings", "chat"]

_DOTS = str.maketrans({"\u3002": ".", "\uff0e": ".", "\uff61": "."})
_LABEL = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")


class BadSite(KnowledgeError):
    """A list entry that is no site (shown to the user as is)."""

    status_code = 422


def normalize_site(text: object) -> str | None:
    """``https://www.Example.com/path`` → ``example.com``; ``None`` when it is no site.

    Accepts a bare domain, a ``*.`` prefix, a URL; keeps subdomains other than ``www``.
    Non-ASCII names are stored in their IDNA (punycode) form, as links carry them."""
    if not isinstance(text, str):
        return None
    raw = text.strip().lower()
    if not raw or len(raw) > 300 or any(char.isspace() for char in raw):
        return None
    raw = (urlsplit(raw).hostname or "") if "://" in raw else raw.split("/", 1)[0].split(":", 1)[0]
    raw = unicodedata.normalize("NFKC", raw).translate(_DOTS).lower()
    raw = raw.removeprefix("*.").removeprefix(".").rstrip(".").removeprefix("www.")
    try:
        raw = raw.encode("idna").decode("ascii")
    except (UnicodeError, ValueError):
        return None
    labels = raw.split(".")
    if len(labels) < 2 or len(raw) > 253 or not all(_LABEL.match(label) for label in labels):
        return None
    if labels[-1].isdigit():
        return None  # an IP address is no site name
    return raw


def sites(items: Iterable[object], *, strict: bool = True) -> tuple[str, ...]:
    """Normalised, each once, in the given order. ``strict``: a bad entry is refused (``BadSite``)."""
    out: list[str] = []
    for item in items:
        site = normalize_site(item)
        if site is None:
            if strict:
                raise BadSite(f"«{str(item)[:80]}» is not a site. Write it like example.com.")
            continue
        if site not in out:
            out.append(site)
    if len(out) > MAX_SITES:
        raise BadSite(f"At most {MAX_SITES} sites in one list.")
    return tuple(out)


def host_of(url: str) -> str:
    """The link's host as a browser opens it, in the lists' IDNA form (``""``: unclear — never kept
    under «only these sites», and hidden whenever a hard rule is in force)."""
    return link_host(url)


def covers(site: str, host: str) -> bool:
    """``site`` covers ``host`` and its subdomains."""
    return bool(host) and (host == site or host.endswith("." + site))


def covered(host: str, listed: Sequence[str]) -> bool:
    return any(covers(site, host) for site in listed)


@dataclass(frozen=True)
class WebRules:
    """Global rules (Settings → Search), or a chat's own web lists (``never`` = the chat's additions)."""

    never: tuple[str, ...] = ()
    only_on: bool = False
    only: tuple[str, ...] = ()
    prefer: tuple[str, ...] = ()

    def to_json(self) -> dict[str, Any]:
        return {"never": list(self.never), "only_on": self.only_on, "only": list(self.only),
                "prefer": list(self.prefer)}

    @classmethod
    def from_json(cls, data: object) -> WebRules:
        if not isinstance(data, Mapping):
            return cls()
        return cls(never=sites(_list(data.get("never")), strict=False), only_on=data.get("only_on") is True,
                   only=sites(_list(data.get("only")), strict=False),
                   prefer=sites(_list(data.get("prefer")), strict=False))


def _list(value: object) -> list[object]:
    return list(value) if isinstance(value, list | tuple) else []


def _ids(value: object) -> tuple[str, ...]:
    out: list[str] = []
    for item in _list(value):
        if isinstance(item, str) and 0 < len(item) <= 160 and item not in out:
            out.append(item)
    return tuple(out[:MAX_SOURCES])


@dataclass(frozen=True)
class ChatRules:
    """One chat's changes. ``web`` ``None``: the web lists are as in Settings."""

    web: WebRules | None = None
    #: N7-4 «Use only these sources»: the library tools give the agent only ``sources``.
    sources_only: bool = False
    #: Material and wiki page ids («only these»).
    sources: tuple[str, ...] = ()
    #: «Exclude from this chat»: material and page ids the agent no longer gets in this chat.
    excluded: tuple[str, ...] = ()
    #: «Search everywhere once», clicked on a card: the next search ignores «only these sites».
    everywhere_once: bool = False
    #: Q1 n78 M-7: when the library sources (only / sources / excluded) last changed (``None``: unknown) —
    #: the citation check counts only answers written since.
    sources_since: str | None = None

    @property
    def library_sources(self) -> tuple[bool, tuple[str, ...], tuple[str, ...]]:
        return self.sources_only, self.sources, self.excluded

    @property
    def is_default(self) -> bool:
        return (self.web is None and not self.sources_only and not self.sources and not self.excluded
                and not self.everywhere_once)

    def to_json(self) -> dict[str, Any]:
        return {"web": self.web.to_json() if self.web is not None else None,
                "sources_only": self.sources_only, "sources": list(self.sources),
                "excluded": list(self.excluded), "everywhere_once": self.everywhere_once,
                "sources_since": self.sources_since}

    @classmethod
    def from_json(cls, data: object) -> ChatRules:
        if not isinstance(data, Mapping):
            return cls()
        web = data.get("web")
        return cls(web=WebRules.from_json(web) if isinstance(web, Mapping) else None,
                   sources_only=data.get("sources_only") is True, sources=_ids(data.get("sources")),
                   excluded=_ids(data.get("excluded")), everywhere_once=data.get("everywhere_once") is True,
                   sources_since=since if isinstance(since := data.get("sources_since"), str) else None)


@dataclass(frozen=True)
class ActiveRules:
    """The web rules in force for one search (a snapshot is kept on its card)."""

    never: tuple[str, ...] = ()
    #: Only these sites; empty when the mode is off (or lifted once).
    only: tuple[str, ...] = ()
    prefer: tuple[str, ...] = ()
    #: Where the lists come from: Settings, or this chat's changes.
    origin: RulesOrigin = "settings"
    #: «Search everywhere once» lifted «only these sites» for this search.
    everywhere_once: bool = False
    #: Never sites that came from Settings (a chat can't lift them; the card marks them).
    settings_never: tuple[str, ...] = field(default=(), compare=False)

    @property
    def empty(self) -> bool:
        return not (self.never or self.only or self.prefer or self.everywhere_once)

    @property
    def hard(self) -> bool:
        """A Never site or «only these sites» is in force (Prefer is only a hint)."""
        return bool(self.never or self.only)

    def to_json(self) -> dict[str, Any]:
        return {"never": list(self.never), "only": list(self.only), "prefer": list(self.prefer),
                "origin": self.origin, "everywhere_once": self.everywhere_once,
                "settings_never": list(self.settings_never)}

    @classmethod
    def from_json(cls, data: object) -> ActiveRules | None:
        if not isinstance(data, Mapping):
            return None
        origin = data.get("origin")
        return cls(never=sites(_list(data.get("never")), strict=False),
                   only=sites(_list(data.get("only")), strict=False),
                   prefer=sites(_list(data.get("prefer")), strict=False),
                   origin="chat" if origin == "chat" else "settings",
                   everywhere_once=data.get("everywhere_once") is True,
                   settings_never=sites(_list(data.get("settings_never")), strict=False))


def active_rules(settings: WebRules, chat: ChatRules | None) -> ActiveRules:
    """What applies in a chat: its own lists if it changed them, else Settings'. Never = Settings'
    plus the chat's own — a chat can only add to it."""
    own = chat.web if chat is not None else None
    lists = own if own is not None else settings
    never = sites((*settings.never, *(own.never if own is not None else ())), strict=False)
    only = lists.only if lists.only_on else ()
    once = bool(chat is not None and chat.everywhere_once and only)
    return ActiveRules(never=never, only=() if once else only, prefer=lists.prefer,
                       origin="chat" if own is not None else "settings", everywhere_once=once,
                       settings_never=settings.never)


@dataclass(frozen=True)
class Screened:
    kept: tuple[WebLink, ...]
    #: Hidden links per site, in first-seen order.
    hidden: tuple[tuple[str, int], ...]

    @property
    def hidden_count(self) -> int:
        return sum(count for _, count in self.hidden)


def screen(links: Sequence[WebLink], rules: ActiveRules | None) -> Screened:
    """Drop links to Never sites and, with «only these sites», links outside the list."""
    if rules is None:
        return Screened(tuple(links), ())
    kept: list[WebLink] = []
    hidden: dict[str, int] = {}
    for link in links:
        host = host_of(link.url)
        if ((not host and rules.hard) or covered(host, rules.never)
                or (rules.only and not covered(host, rules.only))):
            site = host.removeprefix("www.") or "?"
            hidden[site] = hidden.get(site, 0) + 1
            continue
        kept.append(link)
    return Screened(tuple(kept), tuple(hidden.items()))


@dataclass(frozen=True)
class EngineDomains:
    """Domain filters to send with a Claude Code WebSearch (it takes one kind per search)."""

    allowed: tuple[str, ...] = ()
    blocked: tuple[str, ...] = ()
    #: Nothing may be searched: every site the agent asked for is outside the rules.
    refused: bool = False


def engine_domains(rules: ActiveRules, asked_allowed: Sequence[str],
                   asked_blocked: Sequence[str]) -> EngineDomains:
    """``allowed_domains`` / ``blocked_domains`` for an engine that filters by domain.

    Claude Code refuses both lists in one search, so: «only these sites» → ``allowed`` (the agent's
    own narrowing kept where it is inside the list); an agent's own ``allowed`` → kept minus Never
    sites; otherwise ``blocked`` = Never + the agent's own. A Never site *inside* an allowed one can't
    be sent; SKAZ's own screening of the results still removes it from the card."""
    allowed = sites(asked_allowed, strict=False)
    blocked = sites(asked_blocked, strict=False)
    if rules.only:
        chosen = tuple(site for site in allowed if covered(site, rules.only)) if allowed else rules.only
        chosen = tuple(site for site in chosen if not covered(site, rules.never))
        return EngineDomains(allowed=chosen, refused=not chosen)
    if allowed:
        chosen = tuple(site for site in allowed if not covered(site, rules.never))
        return EngineDomains(allowed=chosen, refused=not chosen)
    return EngineDomains(blocked=sites((*rules.never, *blocked), strict=False))


#: The agent's instructions on the chat's rules (part of the web instruction text: a change reaches a
#: live session as a note, ``chats.live.context_note``).
def rules_instructions(rules: ActiveRules) -> str:
    if not (rules.never or rules.only or rules.prefer):
        return ""
    lines = ["Search rules the user set (SKAZ keeps them in code: links outside them are removed from "
             "search results before you see them; never try to get around them):"]
    if rules.never:
        lines.append("- Never search these sites: " + ", ".join(rules.never) + ".")
    if rules.only:
        lines.append("- Search only these sites: " + ", ".join(rules.only) + ". If nothing is found on "
                     "them, say so plainly — the user may search everywhere once from the search card.")
    if rules.prefer:
        lines.append("- Prefer these sites (a hint; you may still search elsewhere): "
                     + ", ".join(rules.prefer) + ".")
    return "\n".join(lines)


#: N7-5: questions about «what is current / modern approaches» — the agent's part (library dates and
#: scientific bases are not filtered here). Told in every chat, with or without web search (Q1 n78 M-9).
TIME_WINDOW_RULES = (
    "Questions about what is current (\"what now\", \"modern approaches\", \"latest\"): start the answer "
    "with one line \"Looking at YYYY–YYYY\" (by default the last three years up to now) — the user can "
    "change it with one click. Split the answer: first \"From YYYY–YYYY sources\" (only sources whose date "
    "you know is inside the window), then the rest, marked as older or undated. If little is recent, say "
    "so plainly."
)
#: N7-5, the web part: told only where SKAZ holds web searches.
TIME_WINDOW_WEB = (
    "For such a question, put the years into the web search query. Web links carry no date: call them "
    "\"date unknown\" and never present one as recent unless its title or the source itself states the date."
)


class SettingsStore(Protocol):
    def get(self, key: str, default: Any = None) -> Any: ...

    def set(self, key: str, value: Any) -> None: ...


class SearchRulesStore:
    """Plain repository; callers run it off the event loop (``disk_call``)."""

    def __init__(self, db: KnowledgeDatabase, settings: SettingsStore) -> None:
        self.db = db
        self.settings = settings

    def global_rules(self) -> WebRules:
        return WebRules.from_json(self.settings.get(SETTINGS_KEY))

    def set_global(self, rules: WebRules) -> WebRules:
        self.settings.set(SETTINGS_KEY, rules.to_json())
        return self.global_rules()

    def chat(self, chat_id: str) -> ChatRules:
        with self.db.read() as connection:
            row = connection.execute("SELECT rules FROM chat_search_rules WHERE chat_id = ?",
                                     (chat_id,)).fetchone()
        return ChatRules.from_json(json.loads(row[0])) if row else ChatRules()

    def set_chat(self, chat_id: str, rules: ChatRules) -> ChatRules:
        before = self.chat(chat_id)
        rules = replace(rules, sources_since=before.sources_since
                        if before.library_sources == rules.library_sources else utc_now_ms())
        with self.db.write() as connection:
            if rules.is_default:
                connection.execute("DELETE FROM chat_search_rules WHERE chat_id = ?", (chat_id,))
            else:
                with contextlib.suppress(sqlite3.IntegrityError):  # the chat is gone: nothing to keep
                    connection.execute(
                        "INSERT INTO chat_search_rules(chat_id, rules, updated_at) VALUES (?, ?, ?) "
                        "ON CONFLICT(chat_id) DO UPDATE SET rules = excluded.rules, "
                        "updated_at = excluded.updated_at",
                        (chat_id, json.dumps(rules.to_json(), ensure_ascii=False), utc_now()))
        return self.chat(chat_id)

    def active(self, chat_id: str) -> ActiveRules:
        return active_rules(self.global_rules(), self.chat(chat_id))

    def take_active(self, chat_id: str) -> ActiveRules:
        """The rules for a search about to be asked; spends the chat's «Search everywhere once»."""
        chat = self.chat(chat_id)
        rules = active_rules(self.global_rules(), chat)
        if chat.everywhere_once:
            self.set_chat(chat_id, replace(chat, everywhere_once=False))
        return rules
