"""W-2 ``/kb``: the user's answer to an agent's web search, and the chat's "Allow in this chat".

* ``POST /kb/web-searches/{id}/decide`` — Allow once / Allow in this chat / Deny; 409 when already
  decided (``ALREADY_DECIDED``) or nobody waits any more (``NOT_WAITING``). Returns the part as the
  chat shows it (the chat also gets a ``part_update`` event).
* ``GET /kb/chats/{id}/web-search`` — whether this chat allows web search without asking (the
  header chip) and since when.
* ``DELETE /kb/chats/{id}/web-search`` — revoke it: the next query asks again.
"""
from __future__ import annotations

from typing import Annotated, cast

from fastapi import APIRouter, Depends, Request

from ..chats.service import ChatService
from ..errors import NotFound
from ..permissions.web_search import WebSearchBroker
from .chats import ChatRoute, web_search_part
from .deps import kb_call
from .schemas_web import KbChatWebSearch, KbWebSearchDecide, KbWebSearchPart

router = APIRouter(prefix="/kb", tags=["kb"], route_class=ChatRoute)


def get_web(request: Request) -> WebSearchBroker:
    return cast(WebSearchBroker, request.app.state.runtime.kb_web)


def get_chats(request: Request) -> ChatService:
    return cast(ChatService, request.app.state.runtime.kb_chats)


WebDep = Annotated[WebSearchBroker, Depends(get_web)]
ChatsDep = Annotated[ChatService, Depends(get_chats)]


@router.post("/web-searches/{search_id}/decide")
async def decide_web_search(search_id: str, body: KbWebSearchDecide, web: WebDep) -> KbWebSearchPart:
    """The agent waits for this; an allowed query is sent exactly as shown, a denied one never."""
    record = await web.decide(search_id, body.decision)
    return await kb_call(web_search_part, record)


def _grant(chats: ChatService, web: WebSearchBroker, chat_id: str) -> KbChatWebSearch:
    if chats.repo.get(chat_id) is None:
        raise NotFound("Chat not found.")
    granted = web.store.granted_at(chat_id)
    return KbChatWebSearch(allowed=granted is not None, granted_at=granted)


@router.get("/chats/{chat_id}/web-search")
async def chat_web_search(chat_id: str, chats: ChatsDep, web: WebDep) -> KbChatWebSearch:
    return await kb_call(_grant, chats, web, chat_id)


@router.delete("/chats/{chat_id}/web-search")
async def revoke_chat_web_search(chat_id: str, chats: ChatsDep, web: WebDep) -> KbChatWebSearch:
    def revoke() -> KbChatWebSearch:
        _grant(chats, web, chat_id)
        web.store.revoke(chat_id)
        return _grant(chats, web, chat_id)

    return await kb_call(revoke)
