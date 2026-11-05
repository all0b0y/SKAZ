"""Shared search-rule request/response models; no dependency on chat route modules."""
from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

from ..permissions.search_rules import MAX_SITES, MAX_SOURCES, ChatRules, WebRules, chat_web_rules, sites
from .schemas_web import KbRulesInForce

_Site = Annotated[str, Field(min_length=1, max_length=300)]
_Id = Annotated[str, Field(min_length=1, max_length=160)]


class KbWebRules(BaseModel):
    """Web lists, global or a chat's own (never = that chat's additions)."""

    model_config = ConfigDict(extra="forbid")
    never: list[_Site] = Field(default_factory=list, max_length=MAX_SITES)
    only_on: bool = False
    only: list[_Site] = Field(default_factory=list, max_length=MAX_SITES)
    prefer: list[_Site] = Field(default_factory=list, max_length=MAX_SITES)


class KbSearchSettings(KbWebRules):
    """Global web rules and the feature flag for Only/Prefer (off by default)."""

    beta: bool = False


def web_rules(body: KbWebRules) -> WebRules:
    """Normalise input before any write; bad sites are refused, never silently dropped."""
    return WebRules(never=sites(body.never), only_on=body.only_on,
                    only=sites(body.only), prefer=sites(body.prefer))


class KbSourceRef(BaseModel):
    id: str
    kind: Literal["material", "page"]
    title: str | None


class KbChatSearchRules(BaseModel):
    settings: KbSearchSettings
    web: KbWebRules | None
    active: KbRulesInForce
    sources_only: bool
    sources: list[KbSourceRef]
    excluded: list[KbSourceRef]
    everywhere_once: bool
    differs: bool
    label: str | None
    sources_since: str | None = None


class KbChatSearchRulesUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    web: KbWebRules | None = None
    sources_only: bool = False
    sources: list[_Id] = Field(default_factory=list, max_length=MAX_SOURCES)
    excluded: list[_Id] = Field(default_factory=list, max_length=MAX_SOURCES)
    as_global: bool = False

    def initial(self, settings: WebRules) -> ChatRules:
        """A new chat's rules, before it or its first turn exists; globals never change here."""
        excluded = tuple(dict.fromkeys(self.excluded))
        chosen = tuple(item for item in dict.fromkeys(self.sources) if item not in excluded)
        own = web_rules(self.web) if self.web is not None else None
        return ChatRules(web=chat_web_rules(own, settings), sources_only=self.sources_only,
                         sources=chosen, excluded=excluded)
