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
from typing import Annotated, cast

from fastapi import APIRouter, Depends, Request

from ..chats.service import ChatService
from ..errors import NotFound
from ..permissions.search_rules import (
    ChatRules,
    SearchRulesStore,
    WebRules,
    active_rules,
    chat_web_rules,
    sites,
)
from ..service import KnowledgeService
from .chats import rules_in_force
from .deps import kb_call
from .schemas_search import (
    KbChatSearchRules,
    KbChatSearchRulesUpdate,
    KbSearchSettings,
    KbSourceRef,
    KbWebRules,
    web_rules,
)

router = APIRouter(prefix="/kb", tags=["kb"])


def _store(request: Request) -> SearchRulesStore:
    return cast(SearchRulesStore, request.app.state.runtime.kb_search_rules)


def _chats(request: Request) -> ChatService:
    return cast(ChatService, request.app.state.runtime.kb_chats)


StoreDep = Annotated[SearchRulesStore, Depends(_store)]
KbDep = Annotated[ChatService, Depends(_chats)]


def _web(body: KbWebRules) -> WebRules:
    """Normalised; a bad entry is refused (422) with the reason."""
    return web_rules(body)


def _web_view(rules: WebRules) -> KbWebRules:
    return KbWebRules(never=list(rules.never), only_on=rules.only_on, only=list(rules.only),
                      prefer=list(rules.prefer))


def _settings(rules: WebRules, beta: bool) -> KbSearchSettings:
    return KbSearchSettings(never=list(rules.never), only_on=rules.only_on, only=list(rules.only),
                            prefer=list(rules.prefer), beta=beta)


def _source(kb: KnowledgeService, item_id: str) -> KbSourceRef:
    material = kb.material_repo.get(item_id)
    if material is not None:
        return KbSourceRef(id=item_id, kind="material", title=material.title)
    page = kb.page_repo.get(item_id)
    if page is not None:
        return KbSourceRef(id=item_id, kind="page", title=page.title)
    return KbSourceRef(id=item_id, kind="page" if item_id.startswith("page") else "material", title=None)


def label(settings: WebRules, chat: ChatRules, beta: bool) -> str | None:
    """The composer button counts Only/Prefer only while their Beta features are active."""
    own_only = len(chat.web.only) if beta and chat.web is not None and chat.web.only_on else 0
    if chat.sources_only or own_only:
        return f"Only these · {len(chat.sources) + own_only}"
    if chat.excluded:
        return f"{len(chat.excluded)} excluded"
    if chat.web is not None and ((beta and chat.web != settings) or (not beta and chat.web.never)):
        return "Changed"
    return None


def chat_rules(chats: ChatService, store: SearchRulesStore, chat_id: str) -> KbChatSearchRules:
    if chats.repo.get(chat_id) is None:
        raise NotFound("Chat not found.")
    kb = chats.kb
    settings = store.global_rules()
    beta = store.beta()
    chat = store.chat(chat_id)
    text = label(settings, chat, beta)
    return KbChatSearchRules(
        settings=_settings(settings, beta), web=_web_view(chat.web) if chat.web is not None else None,
        active=rules_in_force(active_rules(settings, chat, beta=beta)), sources_only=chat.sources_only,
        sources=[_source(kb, item) for item in chat.sources],
        excluded=[_source(kb, item) for item in chat.excluded], everywhere_once=chat.everywhere_once,
        differs=text is not None, label=text, sources_since=chat.sources_since)


@router.get("/settings/search")
async def search_settings(store: StoreDep) -> KbSearchSettings:
    def read() -> KbSearchSettings:
        return _settings(store.global_rules(), store.beta())

    return await kb_call(read)


@router.put("/settings/search")
async def update_search_settings(body: KbSearchSettings, store: StoreDep) -> KbSearchSettings:
    def save() -> KbSearchSettings:
        current = store.global_rules()
        fields = body.model_fields_set
        beta = body.beta if "beta" in fields else store.beta()
        rules = WebRules(
            never=sites(body.never) if "never" in fields else current.never,
            only_on=body.only_on if "only_on" in fields else current.only_on,
            only=sites(body.only) if "only" in fields else current.only,
            prefer=sites(body.prefer) if "prefer" in fields else current.prefer,
        )
        if not beta:
            rules = replace(rules, only_on=current.only_on, only=current.only, prefer=current.prefer)
        store.set_global(rules)
        if "beta" in fields:
            store.set_beta(body.beta)
        return _settings(store.global_rules(), store.beta())

    return await kb_call(save)


@router.get("/chats/{chat_id}/search-rules")
async def get_chat_search_rules(chat_id: str, kb: KbDep, store: StoreDep) -> KbChatSearchRules:
    return await kb_call(chat_rules, kb, store, chat_id)


@router.put("/chats/{chat_id}/search-rules")
async def update_chat_search_rules(chat_id: str, body: KbChatSearchRulesUpdate, kb: KbDep,
                                   store: StoreDep) -> KbChatSearchRules:
    def save() -> KbChatSearchRules:
        chat_rules(kb, store, chat_id)  # 404 first
        current = store.chat(chat_id)
        settings = store.global_rules()
        web = _web(body.web) if body.web is not None else None
        beta = store.beta()
        if not beta:
            hidden = current.web or settings
            web = replace(hidden, never=web.never if web is not None else ())
        own = web
        if body.as_global and own is not None:
            never = sites((*settings.never, *own.never), strict=False)
            store.set_global(replace(own if beta else settings, never=never))
            own = None if beta else replace(current.web or settings, never=())
        else:
            own = chat_web_rules(own, settings)
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
        current = store.chat(chat_id)
        if store.beta():
            store.set_chat(chat_id, ChatRules())
        else:
            hidden = replace(current.web, never=()) if current.web is not None else None
            own = chat_web_rules(hidden, store.global_rules())
            store.set_chat(chat_id, ChatRules(web=own, everywhere_once=current.everywhere_once))
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
