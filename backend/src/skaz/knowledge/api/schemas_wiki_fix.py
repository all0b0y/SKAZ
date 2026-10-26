"""Pydantic model of the «Fix in wiki» card of an answer (P2 decision 4); the logic is ``chats.wiki_fix``."""
from __future__ import annotations

from collections.abc import Callable
from typing import Literal

from pydantic import BaseModel

from ..chats.fix_part import WikiFixPart
from .schemas import KbPageRef


class KbWikiFixPart(BaseModel):
    """The agent's proposed correction of a wiki block after «That’s wrong»: before → after; the wiki
    changes only when the user presses «Fix in wiki» (``POST …/wiki-fixes/{id}/apply``), as their edit."""

    type: Literal["wiki_fix"]
    id: str
    page: KbPageRef
    block_id: str
    #: The block's text when proposed, and the agent's corrected paragraph (plain text).
    before: str
    after: str
    #: The agent's one sentence: what is wrong and which source says so.
    reason: str
    #: ``stale``: the block changed or went since the proposal; nothing was written.
    status: Literal["proposed", "applied", "stale"]
    #: ``False`` once the page is gone from the wiki.
    available: bool


def wiki_fix_part(part: WikiFixPart, page: Callable[[str, str, str], KbPageRef],
                  page_exists: Callable[[str], bool]) -> KbWikiFixPart:
    return KbWikiFixPart(type="wiki_fix", id=part.fix_id, page=page(part.page_id, part.page_title, "concept"),
                         block_id=part.block_id, before=part.before, after=part.after, reason=part.reason,
                         status=part.status, available=page_exists(part.page_id))
