"""Pydantic models of answer blocks in chat messages (P1); the block bodies live in ``answer_blocks``."""
from __future__ import annotations

import json
from collections.abc import Callable
from typing import Annotated, Literal

from pydantic import BaseModel, Field, TypeAdapter, ValidationError

from ..agents.web import site_of
from ..answer_blocks import md
from ..answer_blocks.md import Refs
from ..answer_blocks.part import BlockPart, MaterialSource, PageSource
from ..answer_blocks.registry import KbAnswerBlock
from ..answer_blocks.text import markdown_of
from ..markdown.text import format_timestamp
from .schemas import KbCitation, KbPageRef


class KbBlockCiteSource(BaseModel):
    type: Literal["cite"]
    citation: KbCitation


class KbBlockPageSource(BaseModel):
    type: Literal["page"]
    page: KbPageRef
    block_id: str | None
    #: ``False`` once the page is gone from the wiki.
    available: bool


class KbBlockWebSource(BaseModel):
    """A result link of a web search in this chat."""

    type: Literal["web"]
    url: str
    title: str
    site: str


KbBlockSource = Annotated[KbBlockCiteSource | KbBlockPageSource | KbBlockWebSource,
                          Field(discriminator="type")]


class KbAnswerBlockPart(BaseModel):
    """A ready-made block of an answer, drawn by SKAZ from the agent's checked data (never HTML).

    ``drawing``: its data is still streaming (a placeholder); ``ready``: ``block`` is set, its items
    point at ``sources`` by index; ``broken``: it couldn't be drawn — ``error`` says why and ``raw``
    holds the agent's data (for "Show the data" and "Ask the agent to fix").
    """

    type: Literal["answer_block"]
    #: Stable id of the block (P2 addresses blocks and their items).
    id: str
    state: Literal["drawing", "ready", "broken"]
    block: KbAnswerBlock | None
    sources: list[KbBlockSource]
    #: Items left out because their data was invalid or their source doesn't exist.
    hidden: int
    error: str | None
    raw: str | None
    #: Composition (decision 2): drawn beside the block right before it…
    beside: bool
    #: …or under it, with an arrow from it labelled so.
    link: str | None
    #: The block as plain Markdown with its source labels, for «Copy as Markdown» (decision 11).
    markdown: str | None


_BLOCK: TypeAdapter[KbAnswerBlock] = TypeAdapter(KbAnswerBlock)
#: A stored block this version can't read any more (its schema changed).
UNREADABLE = "This block was saved in a form SKAZ can no longer draw."


def answer_block_part(part: BlockPart, citation: Callable[[str, int, str | None], KbCitation],
                      page: Callable[[str, str, str], KbPageRef],
                      page_exists: Callable[[str], bool]) -> KbAnswerBlockPart:
    """The part as the chat shows it: titles, times and availability looked up now."""
    block = None
    state, error = part.state, part.error
    if state == "ready":
        try:
            block = _BLOCK.validate_python(json.loads(part.data or ""))
        except (ValueError, ValidationError):
            state, error = "broken", UNREADABLE
    sources: list[KbBlockCiteSource | KbBlockPageSource | KbBlockWebSource] = []
    for source in part.sources:
        if isinstance(source, MaterialSource):
            sources.append(KbBlockCiteSource(type="cite", citation=citation(source.material_id, source.seg,
                                                                            source.quote)))
        elif isinstance(source, PageSource):
            ref = page(source.page_id, source.title, source.kind)
            sources.append(KbBlockPageSource(type="page", page=ref, block_id=source.block_id,
                                             available=page_exists(source.page_id)))
        else:
            sources.append(KbBlockWebSource(type="web", url=source.url, title=source.title,
                                            site=site_of(source.url)))
    markdown = markdown_of(block, copy_refs(sources)) if block is not None else ""
    return KbAnswerBlockPart(type="answer_block", id=part.block_id, state=state, block=block, sources=sources,
                             hidden=part.hidden, error=error, raw=part.raw, beside=part.beside,
                             link=part.link, markdown=markdown or None)


def copy_refs(sources: list[KbBlockCiteSource | KbBlockPageSource | KbBlockWebSource]) -> Refs:
    """In-app Copy keeps the sources (decision 11): “[Lecture 8 · 43:20]”, “[Page]”, web results as links."""
    labels: list[str] = []
    times: list[str | None] = []
    for source in sources:
        time = None
        if isinstance(source, KbBlockCiteSource):
            cite = source.citation
            if cite.start_ms is not None:
                time = format_timestamp(cite.start_ms)
            where = f" · {time}" if time else f" · p. {cite.page}" if cite.page is not None else ""
            labels.append(f"[{md.label(cite.material_title or 'Source')}{where}]" if cite.available
                          else "[source no longer in the library]")
        elif isinstance(source, KbBlockPageSource):
            labels.append(f"[{md.label(source.page.title)}]")
        else:
            labels.append(md.link(source.title or source.site or source.url, source.url))
        times.append(time)
    return Refs(labels, times)
