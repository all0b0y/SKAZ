"""``hierarchy``: a tree — kinds and subkinds, parts of a whole — up to four levels deep."""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from . import md
from .base import BlockIn, BlockSpec, ItemIn, Items, KbBlockItem, envelope

MAX_DEPTH = 4
MAX_NODES = 40
MAX_CHILDREN = 12
MAX_ROOTS = 6


class HierarchyNodeFields(ItemIn):
    """One node checked on its own; its children are checked one by one after it."""

    text: str = Field(min_length=1, max_length=160, description="The node, in a few words.")
    note: str | None = Field(default=None, min_length=1, max_length=200, description="Optional short remark.")
    children: list[Any] = Field(default_factory=list, max_length=MAX_CHILDREN)


# The agent's schema spells out the four levels (tool schemas can't be recursive).
class HierarchyLevel4(HierarchyNodeFields):
    children: list[Any] = Field(default_factory=list, max_length=0, description="The deepest level: none.")


class HierarchyLevel3(HierarchyNodeFields):
    children: list[HierarchyLevel4] = Field(default_factory=list, max_length=MAX_CHILDREN,
                                            description="The nodes under this one.")


class HierarchyLevel2(HierarchyNodeFields):
    children: list[HierarchyLevel3] = Field(default_factory=list, max_length=MAX_CHILDREN,
                                            description="The nodes under this one.")


class HierarchyLevel1(HierarchyNodeFields):
    children: list[HierarchyLevel2] = Field(default_factory=list, max_length=MAX_CHILDREN,
                                            description="The nodes under this one.")


class HierarchyEnvelope(BlockIn):
    type: Literal["hierarchy"]
    nodes: list[Any] = Field(min_length=1, max_length=MAX_ROOTS)


class HierarchyIn(HierarchyEnvelope):
    nodes: list[HierarchyLevel1] = Field(min_length=1, max_length=MAX_ROOTS,
                                         description="The top of the tree (usually one node).")


class KbHierarchyNode(KbBlockItem):
    text: str
    note: str | None
    #: 0 for the top of the tree; nodes are listed in reading order (each under the last shallower one).
    depth: int


class KbHierarchyBlock(BaseModel):
    kind: Literal["hierarchy"]
    title: str | None
    nodes: list[KbHierarchyNode]


#: Counting a hidden subtree stops here: the agent's data may nest past any sane depth (FIX-1 F2.2).
MAX_COUNTED = 1_000


def _size(raw: Any) -> int:
    """How many nodes ``raw`` holds, itself included (all hidden when it is) — counted without
    recursion and capped at ``MAX_COUNTED``, however deep the agent nested its data."""
    count, stack = 0, [raw]
    while stack and count < MAX_COUNTED:
        node = stack.pop()
        count += 1
        children = node.get("children") if isinstance(node, dict) else None
        if isinstance(children, list):
            stack.extend(children)
    return count


def build(data: dict[str, Any], items: Items) -> KbHierarchyBlock:
    block = envelope(HierarchyEnvelope, data)
    nodes: list[KbHierarchyNode] = []

    def walk(raw: Any, path: str, depth: int) -> None:
        if depth >= MAX_DEPTH or len(nodes) >= MAX_NODES:
            items.hide(_size(raw))
            return
        checked = items.item(HierarchyNodeFields, raw, path)
        if checked is None:
            items.hide(_size(raw) - 1)  # the node itself was counted; its subtree goes with it
            return
        ids, node = checked
        nodes.append(KbHierarchyNode(**ids.out(), text=node.text, note=node.note, depth=depth))
        for n, child in enumerate(node.children, start=1):
            walk(child, f"{path}-{n}", depth + 1)

    for n, raw in enumerate(block.nodes, start=1):
        walk(raw, f"n{n}", 0)
    return KbHierarchyBlock(kind="hierarchy", title=block.title, nodes=nodes)


def markdown(block: KbHierarchyBlock, refs: md.Refs) -> list[str]:
    lines = md.title(block.title)
    for node in block.nodes:
        note = f" \u2014 {md.text(node.note)}" if node.note else ""
        lines.append("  " * node.depth + f"- {md.text(node.text)}{note}{refs.of(node)}")
    return lines


SPEC = BlockSpec(
    name="hierarchy",
    when="a tree: kinds and subkinds, or parts of a whole (not a flow — that is a diagram)",
    schema=HierarchyIn,
    example={
        "type": "hierarchy",
        "nodes": [{"text": "Consensus algorithms", "cite": "m:mat-4d5e6f:2", "children": [
            {"text": "With a leader", "basis": "agent", "children": [
                {"text": "Raft", "cite": "m:mat-1a2b3c:12"},
                {"text": "Multi-Paxos", "cite": "m:mat-4d5e6f:3"}]},
            {"text": "Leaderless", "basis": "agent", "children": [
                {"text": "EPaxos", "note": "mentioned in passing", "cite": "m:mat-1a2b3c:44"}]},
        ]}],
    },
    build=build,
    markdown=markdown,
)
