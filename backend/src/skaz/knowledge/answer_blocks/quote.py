"""``quote``: one striking passage, word for word, with who says it."""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from . import md
from .base import BlockIn, BlockSpec, ItemIn, Items, KbBlockItem, envelope, required


class QuoteIn(ItemIn):
    text: str = Field(min_length=1, max_length=1000,
                      description="The words exactly as in the source (cite the fragment with them).")
    who: str | None = Field(default=None, min_length=1, max_length=80,
                            description="Who says it (\"The lecturer\"), in the answer's language.")


class QuoteEnvelope(BlockIn):
    type: Literal["quote"]
    quote: Any


class QuoteBlockIn(QuoteEnvelope):
    quote: QuoteIn = Field(description="The passage and where it comes from.")


class KbQuoteItem(KbBlockItem):
    text: str
    who: str | None


class KbQuoteBlock(BaseModel):
    kind: Literal["quote"]
    title: str | None
    quote: KbQuoteItem


def build(data: dict[str, Any], items: Items) -> KbQuoteBlock:
    block = envelope(QuoteEnvelope, data)
    ids, quote = required(items.item(QuoteIn, block.quote, "q"), "The quote")
    return KbQuoteBlock(kind="quote", title=block.title,
                        quote=KbQuoteItem(**ids.out(), text=quote.text, who=quote.who))


def markdown(block: KbQuoteBlock, refs: md.Refs) -> list[str]:
    quote = block.quote
    if quote.who:
        return [*md.title(block.title), f"> {md.text(quote.text)}", ">",
                f"> \u2014 {md.text(quote.who)}{refs.of(quote)}"]
    return [*md.title(block.title), f"> {md.text(quote.text)}{refs.of(quote)}"]


SPEC = BlockSpec(
    name="quote",
    when="one striking passage word for word, when the exact words matter",
    schema=QuoteBlockIn,
    example={
        "type": "quote",
        "quote": {"text": "The random timeout is the whole trick.", "who": "The lecturer",
                  "cite": "m:mat-1a2b3c:52|The random timeout is the whole trick"},
    },
    build=build,
    markdown=markdown,
)
