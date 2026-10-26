"""``disagreement``: sources disagree — what each side says, and what they agree on.

The wording follows the wiki's own discrepancies (``wiki.discrepancy``): \u201cSources disagree\u201d, both
statements on equal terms, each with its source.
"""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from . import md
from .base import BlockError, BlockIn, BlockSpec, ItemIn, Items, KbBlockItem, envelope

MAX_SIDES = 4
NOT_TWO = ("A disagreement needs at least two sides that can be shown: each needs valid data and a source "
           "that exists (cite) or basis \"agent\".")


class SideIn(ItemIn):
    text: str = Field(min_length=1, max_length=400, description="What this source says.")


class AgreeIn(ItemIn):
    text: str = Field(min_length=1, max_length=400, description="What the sides agree on.")


class DisagreementEnvelope(BlockIn):
    type: Literal["disagreement"]
    sides: list[Any] = Field(min_length=2, max_length=MAX_SIDES)
    agree: Any = None


class DisagreementIn(DisagreementEnvelope):
    title: str | None = Field(default=None, min_length=1, max_length=200,
                              description="The question they disagree on, in the answer's language.")
    sides: list[SideIn] = Field(min_length=2, max_length=MAX_SIDES,
                                description="One per source, each citing that source.")
    agree: AgreeIn | None = Field(default=None, description="Optional: what they agree on.")


class KbDisagreementSide(KbBlockItem):
    text: str


class KbDisagreementBlock(BaseModel):
    kind: Literal["disagreement"]
    title: str | None
    sides: list[KbDisagreementSide]
    agree: KbDisagreementSide | None


def build(data: dict[str, Any], items: Items) -> KbDisagreementBlock:
    block = envelope(DisagreementEnvelope, data)
    sides = [KbDisagreementSide(**ids.out(), text=side.text)
             for ids, side in items.many(SideIn, block.sides, "d")]
    if len(sides) < 2:
        raise BlockError(NOT_TWO)
    agree = None
    if block.agree is not None:
        found = items.item(AgreeIn, block.agree, "agree")
        agree = KbDisagreementSide(**found[0].out(), text=found[1].text) if found else None
    return KbDisagreementBlock(kind="disagreement", title=block.title, sides=sides, agree=agree)


def markdown(block: KbDisagreementBlock, refs: md.Refs) -> list[str]:
    heading = f"Sources disagree: {md.text(block.title)}" if block.title else "Sources disagree"
    lines = [f"**{heading}**", "", *(f"- {md.text(side.text)}{refs.of(side)}" for side in block.sides)]
    if block.agree:
        lines += ["", f"*They agree:* {md.text(block.agree.text)}{refs.of(block.agree)}"]
    return lines


SPEC = BlockSpec(
    name="disagreement",
    when="sources disagree on something: what each says, and what they agree on",
    schema=DisagreementIn,
    example={
        "type": "disagreement",
        "title": "Does Paxos need a leader?",
        "sides": [
            {"text": "Paxos has no leader at all — that is its main difference", "cite": "m:mat-1a2b3c:38"},
            {"text": "A distinguished proposer is needed for progress", "cite": "m:mat-4d5e6f:9"},
        ],
        "agree": {"text": "Safety needs no leader; only progress does.", "basis": "agent"},
    },
    build=build,
    markdown=markdown,
)
