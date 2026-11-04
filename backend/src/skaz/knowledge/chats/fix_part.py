"""The «Fix in wiki» card of an answer (P2 decision 4), stored as a message part.

The agent proposed it after the user said «That’s wrong»; the card shows the page block before → after
and changes the wiki only when the user clicks (``chats.wiki_fix``). Self-contained: what was
proposed stays readable even when the page changes or goes.
"""
from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Literal

#: ``proposed``: waits for the click; ``applied``: written as the user's edit; ``stale``: the block
#: changed (or went) since the proposal — nothing was written.
FixStatus = Literal["proposed", "applied", "stale"]


@dataclass(frozen=True)
class WikiFixPart:
    fix_id: str
    page_id: str
    block_id: str
    #: The page's title when proposed (shown if the page is gone later).
    page_title: str
    #: The block's readable text when proposed — the apply checks it is still the same.
    before: str
    after: str
    reason: str
    status: FixStatus = "proposed"


def fix_to_json(part: WikiFixPart) -> dict[str, Any]:
    return {"type": "wiki_fix", "id": part.fix_id, "page_id": part.page_id, "block_id": part.block_id,
            "page_title": part.page_title, "before": part.before, "after": part.after, "reason": part.reason,
            "status": part.status}


def fix_from_json(data: Mapping[str, Any]) -> WikiFixPart:
    status = data.get("status")
    return WikiFixPart(str(data["id"]), str(data.get("page_id", "")), str(data.get("block_id", "")),
                       str(data.get("page_title", "")), str(data.get("before", "")),
                       str(data.get("after", "")), str(data.get("reason", "")),
                       status if status in ("proposed", "applied", "stale") else "stale")
