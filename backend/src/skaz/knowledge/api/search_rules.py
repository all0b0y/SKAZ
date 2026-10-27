"""N7 ``/kb``: the user's search rules — Settings → Search and one chat's changes.

* ``GET/PUT /kb/settings/search`` — the global web rules every chat starts from: Never sites (always,
  everywhere), «only these sites» (switch + list), Prefer sites (a hint to the agent).
* ``GET /kb/chats/{id}/search-rules`` — what the chat uses now: Settings, its own web lists, its
  library sources (All / Only these / Excluded) and the label of the composer button.
* ``PUT /kb/chats/{id}/search-rules`` — Save (this chat) or Save as global (``as_global``: the web lists
  go into Settings; library sources stay per chat). A chat never lifts a global Never site.
* ``DELETE /kb/chats/{id}/search-rules`` — Reset to Settings.
* ``POST /kb/chats/{id}/search-rules/everywhere-once`` — «Search everywhere once», the user's click on
  a card: the chat's next search ignores «only these sites» (Never still applies).

A bad site is refused with 422 and the reason; sites are stored normalised (``example.com``).
"""
from __future__ import annotations

from dataclasses import replace
from typing import Annotated, Literal, cast

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, ConfigDict, Field

from ..chats.service import ChatService
from ..errors import NotFound
from ..permissions.search_rules import (
    MAX_SITES,
    MAX_SOURCES,
    ChatRules,
    SearchRulesStore,
    WebRules,
    active_rules,
    sites,
)
from ..service import KnowledgeService
from .chats import rules_in_force
from .deps import kb_call
from .schemas_web import KbRulesInForce

router = APIRouter(prefix="/kb", tags=["kb"])

_Site = Annotated[str, Field(min_length=1, max_length=300)]
_Id = Annotated[str, Field(min_length=1, max_length=160)]


class KbSearchSettings(BaseModel):
    """Web rules: Settings → Search, or one chat's own lists (``never`` = the chat's additions)."""

    model_config = ConfigDict(extra="forbid")

    never: list[_Site] = Field(default_factory=list, max_length=MAX_SITES)
    only_on: bool = False
    only: list[_Site] = Field(default_factory=list, max_length=MAX_SITES)
    prefer: list[_Site] = Field(default_factory=list, max_length=MAX_SITES)


class KbSourceRef(BaseModel):
    id: str
    kind: Literal["material", "page"]
    #: ``None``: the material or page is no longer in the library.
    title: str | None


class KbChatSearchRules(BaseModel):
    settings: KbSearchSettings
    #: The chat's own web lists; ``None``: as in Settings.
    web: KbSearchSettings | None
    active: KbRulesInForce
    sources_only: bool
    sources: list[KbSourceRef]
    excluded: list[KbSourceRef]
    everywhere_once: bool
    #: The chat differs from Settings (the composer button says how, ``label``).
    differs: bool
    label: str | None


class KbChatSearchRulesUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    web: KbSearchSettings | None = None
    sources_only: bool = False
    sources: list[_Id] = Field(default_factory=list, max_length=MAX_SOURCES)
    excluded: list[_Id] = Field(default_factory=list, max_length=MAX_SOURCES)
    #: «Save as global»: the web lists become Settings (and the chat follows Settings again).
    as_global: bool = False


def _store(request: Request) -> SearchRulesStore:
    return cast(SearchRulesStore, request.app.state.runtime.kb_search_rules)


def _chats(request: Request) -> ChatService:
    return cast(ChatService, request.app.state.runtime.kb_chats)


StoreDep = Annotated[SearchRulesStore, Depends(_store)]
KbDep = Annotated[ChatService, Depends(_chats)]


def _web(body: KbSearchSettings) -> WebRules:
    """Normalised; a bad entry is refused (422) with the reason."""
    return WebRules(never=sites(body.never), only_on=body.only_on, only=sites(body.only),
                    prefer=sites(body.prefer))


def _settings(rules: WebRules) -> KbSearchSettings:
    return KbSearchSettings(never=list(rules.never), only_on=rules.only_on, only=list(rules.only),
                            prefer=list(rules.prefer))


def _source(kb: KnowledgeService, item_id: str) -> KbSourceRef:
    material = kb.material_repo.get(item_id)
    if material is not None:
        return KbSourceRef(id=item_id, kind="material", title=material.title)
    page = kb.page_repo.get(item_id)
    if page is not None:
        return KbSourceRef(id=item_id, kind="page", title=page.title)
    return KbSourceRef(id=item_id, kind="page" if item_id.startswith("page") else "material", title=None)


def label(settings: WebRules, chat: ChatRules) -> str | None:
    """The composer button: «Only these · 4» (library sources + the chat's own only-sites), «2 excluded»,
    «Changed» (other web lists); ``None`` when the chat is as in Settings."""
    own_only = len(chat.web.only) if chat.web is not None and chat.web.only_on else 0
    if chat.sources_only or own_only:
        return f"Only these · {len(chat.sources) + own_only}"
    if chat.excluded:
        return f"{len(chat.excluded)} excluded"
    if chat.web is not None and chat.web != settings:
        return "Changed"
    return None


def chat_rules(chats: ChatService, store: SearchRulesStore, chat_id: str) -> KbChatSearchRules:
    if chats.repo.get(chat_id) is None:
        raise NotFound("Chat not found.")
    kb = chats.kb
    settings = store.global_rules()
    chat = store.chat(chat_id)
    text = label(settings, chat)
    return KbChatSearchRules(
        settings=_settings(settings), web=_settings(chat.web) if chat.web is not None else None,
        active=rules_in_force(active_rules(settings, chat)), sources_only=chat.sources_only,
        sources=[_source(kb, item) for item in chat.sources],
        excluded=[_source(kb, item) for item in chat.excluded], everywhere_once=chat.everywhere_once,
        differs=text is not None, label=text)


@router.get("/settings/search")
async def search_settings(store: StoreDep) -> KbSearchSettings:
    return _settings(await kb_call(store.global_rules))


@router.put("/settings/search")
async def update_search_settings(body: KbSearchSettings, store: StoreDep) -> KbSearchSettings:
    return _settings(await kb_call(lambda: store.set_global(_web(body))))


@router.get("/chats/{chat_id}/search-rules")
async def get_chat_search_rules(chat_id: str, kb: KbDep, store: StoreDep) -> KbChatSearchRules:
    return await kb_call(chat_rules, kb, store, chat_id)


@router.put("/chats/{chat_id}/search-rules")
async def update_chat_search_rules(chat_id: str, body: KbChatSearchRulesUpdate, kb: KbDep,
                                   store: StoreDep) -> KbChatSearchRules:
    def save() -> KbChatSearchRules:
        chat_rules(kb, store, chat_id)  # 404 first
        web = _web(body.web) if body.web is not None else None
        current = store.chat(chat_id)
        own = web
        if body.as_global and own is not None:
            settings = store.global_rules()
            store.set_global(replace(own, never=sites((*settings.never, *own.never), strict=False)))
            own = None
        elif own is not None:
            settings = store.global_rules()
            # Never sites already in Settings are not the chat's own (it can't lift them anyway).
            own = replace(own, never=tuple(site for site in own.never if site not in settings.never))
            if own == replace(settings, never=()):
                own = None  # nothing differs from Settings
        excluded = tuple(dict.fromkeys(body.excluded))
        chosen = tuple(item for item in dict.fromkeys(body.sources) if item not in excluded)
        store.set_chat(chat_id, ChatRules(web=own, sources_only=body.sources_only, sources=chosen,
                                          excluded=excluded, everywhere_once=current.everywhere_once))
        return chat_rules(kb, store, chat_id)

    return await kb_call(save)


@router.delete("/chats/{chat_id}/search-rules")
async def reset_chat_search_rules(chat_id: str, kb: KbDep, store: StoreDep) -> KbChatSearchRules:
    def reset() -> KbChatSearchRules:
        chat_rules(kb, store, chat_id)
        store.set_chat(chat_id, ChatRules())
        return chat_rules(kb, store, chat_id)

    return await kb_call(reset)


@router.post("/chats/{chat_id}/search-rules/everywhere-once")
async def search_everywhere_once(chat_id: str, kb: KbDep, store: StoreDep) -> KbChatSearchRules:
    """Only on the user's click: the next search of this chat is not limited to «only these sites»."""
    def lift() -> KbChatSearchRules:
        chat_rules(kb, store, chat_id)
        store.set_chat(chat_id, replace(store.chat(chat_id), everywhere_once=True))
        return chat_rules(kb, store, chat_id)

    return await kb_call(lift)
