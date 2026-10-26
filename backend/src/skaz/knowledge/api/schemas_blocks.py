"""Pydantic models of answer blocks in chat messages (P1); the block bodies live in ``answer_blocks``."""
from __future__ import annotations

import json
from collections.abc import Callable
from typing import Annotated, Literal

from pydantic import BaseModel, Field, TypeAdapter, ValidationError

from ..agents.web import site_of
from ..answer_blocks.part import BlockPart, MaterialSource, PageSource
from ..answer_blocks.registry import KbAnswerBlock
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
    holds the agent's data (for "Show the data" and "Ask agent to fix").
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
    return KbAnswerBlockPart(type="answer_block", id=part.block_id, state=state, block=block, sources=sources,
                             hidden=part.hidden, error=error, raw=part.raw)
