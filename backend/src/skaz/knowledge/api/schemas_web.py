"""Pydantic models of W-2: an agent's web search held for the user, and the chat's web grant."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict

from .schemas_agents import KbEngineId

KbWebSearchStatus = Literal["pending", "allowed", "denied", "cancelled"]


class KbWebLink(BaseModel):
    title: str
    #: http(s) only.
    url: str
    #: The site, for the row ("en.wikipedia.org").
    site: str


class KbRulesInForce(BaseModel):
    """The web rules applied to a search (also on its card)."""

    never: list[str]
    #: Never sites from Settings (a chat can't remove them).
    settings_never: list[str]
    #: Only these sites; empty: the mode is off.
    only: list[str]
    prefer: list[str]
    origin: Literal["settings", "chat"]
    #: «Search everywhere once» lifted «only these sites» for this search.
    everywhere_once: bool


class KbHiddenSite(BaseModel):
    site: str
    #: Links of this site the rules removed from the result.
    count: int


class KbWebSearchPart(BaseModel):
    """An agent's web search: the exact query waits for Allow once / Allow in this chat / Deny; once
    sent, the links it found — shown apart from the material citations, never wiki sources by
    themselves ("Add to wiki" saves a page as a material, ``POST /kb/materials/web``)."""

    type: Literal["web_search"]
    id: str
    engine: KbEngineId
    #: Exactly what is (or would be) sent — nothing else from the chat goes with it.
    query: str
    #: Domain filters sent with the query (the agent's own, or the user's rules for an engine that
    #: filters by domain — N7); usually empty.
    allowed_domains: list[str]
    blocked_domains: list[str]
    status: KbWebSearchStatus
    #: Allowed by the chat's "Allow in this chat" (no question was asked).
    auto: bool
    #: Cancelled: why.
    reason: str | None
    links: list[KbWebLink]
    #: W-3b: the agent whose own search runs the query in a separate run that gets only the query
    #: (``skaz_web_search`` of Codex, Hermes, OpenCode); ``None``: the asking agent's own search.
    searcher: KbEngineId | None = None
    #: N7: the user's search rules in force for this query (``None``: none were set).
    rules: KbRulesInForce | None = None
    #: N7: links removed by the rules (only counted; never shown or given to the agent).
    hidden: list[KbHiddenSite] = []


class KbWebSearchDecide(BaseModel):
    model_config = ConfigDict(extra="forbid")

    decision: Literal["allow", "allow_chat", "deny"]


class KbChatWebSearch(BaseModel):
    """The chat's "Allow in this chat" for web search (the header chip; revoked with DELETE)."""

    allowed: bool
    granted_at: str | None
