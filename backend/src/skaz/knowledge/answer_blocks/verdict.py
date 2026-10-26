"""``verdict``: the conclusion of an answer — one clear recommendation or answer, and why."""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from . import md
from .base import BlockIn, BlockSpec, ItemIn, Items, KbBlockItem, envelope, required


class VerdictIn(ItemIn):
    text: str = Field(min_length=1, max_length=400, description="The conclusion, in one or two sentences.")
    reason: str | None = Field(default=None, min_length=1, max_length=600,
                               description="Optional: why, in one sentence.")


class VerdictEnvelope(BlockIn):
    type: Literal["verdict"]
    verdict: Any


class VerdictBlockIn(VerdictEnvelope):
    verdict: VerdictIn = Field(description="The conclusion and where it comes from.")


class KbVerdict(KbBlockItem):
    text: str
    reason: str | None


class KbVerdictBlock(BaseModel):
    kind: Literal["verdict"]
    title: str | None
    verdict: KbVerdict


def build(data: dict[str, Any], items: Items) -> KbVerdictBlock:
    block = envelope(VerdictEnvelope, data)
    ids, verdict = required(items.item(VerdictIn, block.verdict, "v"), "The verdict")
    return KbVerdictBlock(kind="verdict", title=block.title,
                          verdict=KbVerdict(**ids.out(), text=verdict.text, reason=verdict.reason))


def markdown(block: KbVerdictBlock, refs: md.Refs) -> list[str]:
    verdict = block.verdict
    reason = f" \u2014 {md.text(verdict.reason)}" if verdict.reason else ""
    return [*md.title(block.title), f"**Verdict:** {md.text(verdict.text)}{reason}{refs.of(verdict)}"]


SPEC = BlockSpec(
    name="verdict",
    when="the conclusion: one clear recommendation or answer after weighing things, and why",
    schema=VerdictBlockIn,
    example={
        "type": "verdict",
        "verdict": {"text": "For a course project, choose Raft: it can be built and tested in a term.",
                    "reason": "The lecturer calls it the more understandable of the two.",
                    "cite": ["m:mat-1a2b3c:12", "https://raft.github.io/"]},
    },
    build=build,
    markdown=markdown,
)
