"""``definition``: what one term means — the term, other names, the definition and an example."""
from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field

from . import md
from .base import BlockError, BlockIn, BlockSpec, ItemIn, Items, KbBlockItem, clean, envelope, required

MAX_ALSO = 6


class DefinitionTextIn(ItemIn):
    text: str = Field(min_length=1, max_length=800, description="The text, in the answer's language.")


class DefinitionEnvelope(BlockIn):
    type: Literal["definition"]
    term: str = Field(min_length=1, max_length=120, description="The term defined.")
    also: list[Annotated[str, Field(min_length=1, max_length=60)]] = Field(
        default_factory=list, max_length=MAX_ALSO, description="Other names or translations of the term.")
    definition: Any
    example: Any = None


class DefinitionIn(DefinitionEnvelope):
    definition: DefinitionTextIn = Field(description="What the term means.")
    example: DefinitionTextIn | None = Field(default=None, description="Optional example of the term in use.")


class KbDefinitionText(KbBlockItem):
    text: str


class KbDefinitionBlock(BaseModel):
    kind: Literal["definition"]
    title: str | None
    term: str
    also: list[str]
    definition: KbDefinitionText
    example: KbDefinitionText | None


def build(data: dict[str, Any], items: Items) -> KbDefinitionBlock:
    block = envelope(DefinitionEnvelope, data)
    term = clean(block.term)
    if not term:
        raise BlockError("Invalid block data: term: the term can't be empty.")
    also = [name for name in (clean(value) for value in block.also) if name]
    ids, definition = required(items.item(DefinitionTextIn, block.definition, "def"), "The definition")
    example = None
    if block.example is not None:
        found = items.item(DefinitionTextIn, block.example, "ex")
        example = KbDefinitionText(**found[0].out(), text=found[1].text) if found else None
    return KbDefinitionBlock(kind="definition", title=block.title, term=term, also=also,
                             definition=KbDefinitionText(**ids.out(), text=definition.text), example=example)


def markdown(block: KbDefinitionBlock, refs: md.Refs) -> list[str]:
    also = f" ({', '.join(md.text(name) for name in block.also)})" if block.also else ""
    lines = [*md.title(block.title),
             f"**{md.text(block.term)}**{also}: {md.text(block.definition.text)}{refs.of(block.definition)}"]
    if block.example:
        lines += ["", f"*Example:* {md.text(block.example.text)}{refs.of(block.example)}"]
    return lines


SPEC = BlockSpec(
    name="definition",
    when="what one term means: the term, other names, its definition and an example",
    schema=DefinitionIn,
    example={
        "type": "definition",
        "term": "Term",
        "also": ["epoch"],
        "definition": {"text": "The cluster's logical clock: a number that grows with every election; "
                               "each term has at most one leader.", "cite": "m:mat-1a2b3c:14"},
        "example": {"text": "A node in term 5 ignores messages from the leader of term 4.",
                    "cite": "m:mat-1a2b3c:15"},
    },
    build=build,
    markdown=markdown,
)
