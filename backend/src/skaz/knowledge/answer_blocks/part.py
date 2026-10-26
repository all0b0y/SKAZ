"""The answer block as a chat message part (stored as plain JSON with the message).

A block is stored *validated*: ``data`` is the block's output model (``registry.OUT``) as JSON,
its items point at ``sources`` by index. Source ids were checked when the answer was written;
titles, times and availability are looked up again whenever the message is shown.
"""
from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Literal

BlockState = Literal["drawing", "ready", "broken"]
#: The raw data kept with a broken block (shown under "Show the data", sent with "Ask agent to fix").
MAX_RAW_CHARS = 20_000
#: The answer ended (stopped, failed, restarted) before the block's closing fence arrived.
UNFINISHED = "The answer stopped before this block was finished."
#: The block's data ran past the parser's limit without a closing fence.
TOO_LONG = "The block's data is too long to draw."


@dataclass(frozen=True)
class MaterialSource:
    material_id: str
    seg: int
    #: Verbatim words of the fragment (checked), ``None`` = the whole fragment.
    quote: str | None = None


@dataclass(frozen=True)
class PageSource:
    page_id: str
    block_id: str | None
    #: Title/kind when the answer was written (shown if the page is gone later).
    title: str
    kind: str


@dataclass(frozen=True)
class WebSource:
    """A result link of a web search made in this chat (only those can be cited)."""

    url: str
    title: str


BlockSource = MaterialSource | PageSource | WebSource


@dataclass(frozen=True)
class BlockPart:
    """One block of an answer. ``block_id`` is stable (P2 addresses blocks and their items by id)."""

    block_id: str
    state: BlockState
    #: The block type (``compare``…); ``None`` while drawing or when the type was not readable.
    kind: str | None = None
    #: The validated block as canonical JSON (hashable, unlike a dict); ``None`` unless ``ready``.
    data: str | None = None
    sources: tuple[BlockSource, ...] = ()
    #: Items left out: invalid, or their source does not exist.
    hidden: int = 0
    #: Why a broken block couldn't be drawn (plain English, for the user and the fix request).
    error: str | None = None
    #: The agent's data of a broken block, clipped.
    raw: str | None = None


def source_to_json(source: BlockSource) -> dict[str, Any]:
    if isinstance(source, MaterialSource):
        return {"type": "cite", "material_id": source.material_id, "seg": source.seg, "quote": source.quote}
    if isinstance(source, PageSource):
        return {"type": "page", "page_id": source.page_id, "block_id": source.block_id, "title": source.title,
                "kind": source.kind}
    return {"type": "web", "url": source.url, "title": source.title}


def source_from_json(data: Mapping[str, Any]) -> BlockSource | None:
    kind = data.get("type")
    if kind == "cite":
        quote = data.get("quote")
        return MaterialSource(str(data["material_id"]), int(data["seg"]), _optional(quote))
    if kind == "page":
        block_id = data.get("block_id")
        return PageSource(str(data["page_id"]), None if block_id is None else str(block_id),
                          str(data.get("title", "")), str(data.get("kind", "concept")))
    if kind == "web":
        return WebSource(str(data["url"]), str(data.get("title", "")))
    return None


def block_to_json(part: BlockPart) -> dict[str, Any]:
    return {"type": "answer_block", "id": part.block_id, "state": part.state, "kind": part.kind,
            "data": part.data, "sources": [source_to_json(source) for source in part.sources],
            "hidden": part.hidden, "error": part.error, "raw": part.raw}


def block_from_json(data: Mapping[str, Any]) -> BlockPart:
    state = data.get("state")
    sources = tuple(source for source in (source_from_json(item) for item in data.get("sources") or []
                                          if isinstance(item, Mapping)) if source is not None)
    return BlockPart(
        block_id=str(data["id"]),
        state=state if state in ("drawing", "ready", "broken") else "broken",
        kind=_optional(data.get("kind")), data=_optional(data.get("data")), sources=sources,
        hidden=int(data.get("hidden") or 0), error=_optional(data.get("error")),
        raw=_optional(data.get("raw")),
    )


def drawing(block_id: str) -> BlockPart:
    """The placeholder shown while the block's fence is still being written."""
    return BlockPart(block_id, "drawing")


def unfinished(part: BlockPart) -> BlockPart:
    """A block whose answer ended while it was drawing: broken, nothing to fix it from."""
    return BlockPart(part.block_id, "broken", error=UNFINISHED)


def _optional(value: Any) -> str | None:
    return None if value is None else str(value)
