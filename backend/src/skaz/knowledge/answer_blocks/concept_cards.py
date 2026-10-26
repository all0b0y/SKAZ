"""``concept_cards``: a few key concepts of a topic, each on a small card with one line about it."""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from . import md
from .base import BlockIn, BlockSpec, ItemIn, Items, KbBlockItem, envelope

MAX_CARDS = 12


class CardIn(ItemIn):
    name: str = Field(min_length=1, max_length=80, description="The concept.")
    text: str = Field(min_length=1, max_length=300, description="What it is, in one line.")


class ConceptCardsEnvelope(BlockIn):
    type: Literal["concept_cards"]
    cards: list[Any] = Field(min_length=1, max_length=MAX_CARDS)


class ConceptCardsIn(ConceptCardsEnvelope):
    cards: list[CardIn] = Field(min_length=1, max_length=MAX_CARDS, description="One card per concept.")


class KbConceptCard(KbBlockItem):
    name: str
    text: str


class KbConceptCardsBlock(BaseModel):
    kind: Literal["concept_cards"]
    title: str | None
    cards: list[KbConceptCard]


def build(data: dict[str, Any], items: Items) -> KbConceptCardsBlock:
    block = envelope(ConceptCardsEnvelope, data)
    cards = [KbConceptCard(**ids.out(), name=card.name, text=card.text)
             for ids, card in items.many(CardIn, block.cards, "k")]
    return KbConceptCardsBlock(kind="concept_cards", title=block.title, cards=cards)


def markdown(block: KbConceptCardsBlock, refs: md.Refs) -> list[str]:
    return [*md.title(block.title),
            *(f"- **{md.text(card.name)}**: {md.text(card.text)}{refs.of(card)}" for card in block.cards)]


SPEC = BlockSpec(
    name="concept_cards",
    when="the key concepts of a topic at a glance, each with one line (what to know for an exam)",
    schema=ConceptCardsIn,
    example={
        "type": "concept_cards",
        "cards": [
            {"name": "Quorum", "text": "A majority of nodes; any two quorums overlap", "cite": "p:pg-7a8b9c"},
            {"name": "Commit index", "text": "Up to which entry the log is safe to apply",
             "cite": "m:mat-1a2b3c:22"},
        ],
    },
    build=build,
    markdown=markdown,
)
