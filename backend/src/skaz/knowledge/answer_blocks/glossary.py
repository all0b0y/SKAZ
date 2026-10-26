"""``glossary``: several terms with a short meaning each (a word list)."""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from . import md
from .base import BlockIn, BlockSpec, ItemIn, Items, KbBlockItem, envelope

MAX_TERMS = 30


class GlossaryTermIn(ItemIn):
    term: str = Field(min_length=1, max_length=80, description="The term.")
    text: str = Field(min_length=1, max_length=300, description="Its meaning, in one line.")


class GlossaryEnvelope(BlockIn):
    type: Literal["glossary"]
    terms: list[Any] = Field(min_length=1, max_length=MAX_TERMS)


class GlossaryIn(GlossaryEnvelope):
    terms: list[GlossaryTermIn] = Field(min_length=1, max_length=MAX_TERMS, description="The terms in order.")


class KbGlossaryTerm(KbBlockItem):
    term: str
    text: str


class KbGlossaryBlock(BaseModel):
    kind: Literal["glossary"]
    title: str | None
    terms: list[KbGlossaryTerm]


def build(data: dict[str, Any], items: Items) -> KbGlossaryBlock:
    block = envelope(GlossaryEnvelope, data)
    terms = [KbGlossaryTerm(**ids.out(), term=term.term, text=term.text)
             for ids, term in items.many(GlossaryTermIn, block.terms, "g")]
    return KbGlossaryBlock(kind="glossary", title=block.title, terms=terms)


def markdown(block: KbGlossaryBlock, refs: md.Refs) -> list[str]:
    return [*md.title(block.title),
            *(f"- **{md.text(term.term)}**: {md.text(term.text)}{refs.of(term)}" for term in block.terms)]


SPEC = BlockSpec(
    name="glossary",
    when="several terms with a one-line meaning each (a word list)",
    schema=GlossaryIn,
    example={
        "type": "glossary",
        "terms": [
            {"term": "Follower", "text": "A passive node that answers the leader", "cite": "m:mat-1a2b3c:9"},
            {"term": "Liveness", "text": "The system eventually makes progress", "basis": "agent"},
        ],
    },
    build=build,
    markdown=markdown,
)
