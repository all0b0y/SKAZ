"""``cause_chain``: why something happened — causes and effects in order, joined by arrows."""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from . import md
from .base import BlockIn, BlockSpec, ItemIn, Items, KbBlockItem, envelope

MAX_NODES = 8


class ChainNodeIn(ItemIn):
    label: str | None = Field(default=None, min_length=1, max_length=40,
                              description=("Optional role of this link (\"Cause\", \"Effect\", "
                                           "\"Response\"), in the answer's language."))
    text: str = Field(min_length=1, max_length=300, description="What happens, in a few words.")


class CauseChainEnvelope(BlockIn):
    type: Literal["cause_chain"]
    nodes: list[Any] = Field(min_length=2, max_length=MAX_NODES)


class CauseChainIn(CauseChainEnvelope):
    nodes: list[ChainNodeIn] = Field(min_length=2, max_length=MAX_NODES,
                                     description="The links of the chain, each leading to the next.")


class KbChainNode(KbBlockItem):
    label: str | None
    text: str


class KbCauseChainBlock(BaseModel):
    kind: Literal["cause_chain"]
    title: str | None
    nodes: list[KbChainNode]


def build(data: dict[str, Any], items: Items) -> KbCauseChainBlock:
    block = envelope(CauseChainEnvelope, data)
    nodes = [KbChainNode(**ids.out(), label=node.label, text=node.text)
             for ids, node in items.many(ChainNodeIn, block.nodes, "n")]
    return KbCauseChainBlock(kind="cause_chain", title=block.title, nodes=nodes)


def markdown(block: KbCauseChainBlock, refs: md.Refs) -> list[str]:
    return [*md.title(block.title),
            *(f"{n}. " + (f"**{md.text(node.label)}:** " if node.label else "") + md.text(node.text)
              + refs.of(node) for n, node in enumerate(block.nodes, start=1))]


SPEC = BlockSpec(
    name="cause_chain",
    when="why something happened: causes and effects in order, each leading to the next",
    schema=CauseChainIn,
    example={
        "type": "cause_chain",
        "nodes": [
            {"label": "Cause", "text": "Paxos is hard to understand", "cite": "m:mat-4d5e6f:3"},
            {"label": "Effect", "text": "Real implementations had bugs", "cite": "m:mat-4d5e6f:7"},
            {"label": "Response", "text": "Raft: understandability as the main goal",
             "cite": "m:mat-1a2b3c:41"},
        ],
    },
    build=build,
    markdown=markdown,
)
