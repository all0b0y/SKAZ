"""``/kb/mentions``: the @-suggestions of the composer (groups Wiki · Materials · Chats)."""
from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Query

from .chats import ChatsDep
from .deps import kb_call
from .schemas import KbPageRef
from .schemas_chats import KbMentions, KbRef

router = APIRouter(prefix="/kb/mentions", tags=["kb"])


@router.get("")
async def mention_suggestions(chats: ChatsDep, q: Annotated[str, Query(max_length=200)] = "",
                              limit: Annotated[int, Query(ge=1, le=50)] = 8) -> KbMentions:
    """Titles (and aliases of pages) containing ``q``; an empty ``q`` lists the first of each group."""
    found = await kb_call(chats.mentions, q, limit)
    return KbMentions(
        pages=[KbPageRef.model_validate({"id": page_id, "kind": kind, "title": title})
               for page_id, kind, title in found.pages],
        materials=[KbRef(type="material", id=material_id, title=title)
                   for material_id, title in found.materials],
        chats=[KbRef(type="chat", id=chat_id, title=title) for chat_id, title in found.chats],
    )
