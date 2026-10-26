"""``pros_cons``: the arguments for and against one option — two short lists, marked + and −."""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator

from . import md
from .base import BlockIn, BlockSpec, ItemIn, Items, KbBlockItem, envelope

MAX_POINTS = 12


class PointIn(ItemIn):
    text: str = Field(min_length=1, max_length=300, description="One argument, in a few words.")


class ProsConsEnvelope(BlockIn):
    type: Literal["pros_cons"]
    pros: list[Any] = Field(default_factory=list, max_length=MAX_POINTS)
    cons: list[Any] = Field(default_factory=list, max_length=MAX_POINTS)

    @model_validator(mode="after")
    def _some(self) -> ProsConsEnvelope:
        if not self.pros and not self.cons:
            raise ValueError("Give at least one pro or con.")
        return self


class ProsConsIn(ProsConsEnvelope):
    title: str | None = Field(default=None, min_length=1, max_length=200,
                              description="What is weighed (\"Raft\"), in the answer's language.")
    pros: list[PointIn] = Field(default_factory=list, max_length=MAX_POINTS, description="Arguments for.")
    cons: list[PointIn] = Field(default_factory=list, max_length=MAX_POINTS, description="Arguments against.")


class KbPoint(KbBlockItem):
    text: str


class KbProsConsBlock(BaseModel):
    kind: Literal["pros_cons"]
    title: str | None
    pros: list[KbPoint]
    cons: list[KbPoint]


def build(data: dict[str, Any], items: Items) -> KbProsConsBlock:
    block = envelope(ProsConsEnvelope, data)
    pros = [KbPoint(**ids.out(), text=point.text) for ids, point in items.many(PointIn, block.pros, "p")]
    cons = [KbPoint(**ids.out(), text=point.text) for ids, point in items.many(PointIn, block.cons, "c")]
    return KbProsConsBlock(kind="pros_cons", title=block.title, pros=pros, cons=cons)


def markdown(block: KbProsConsBlock, refs: md.Refs) -> list[str]:
    lines = md.title(block.title)
    for name, points in (("Pros", block.pros), ("Cons", block.cons)):
        if points:
            if lines and lines[-1]:
                lines.append("")
            lines += [f"{name}:", "", *(f"- {md.text(point.text)}{refs.of(point)}" for point in points)]
    return lines


SPEC = BlockSpec(
    name="pros_cons",
    when="the arguments for and against one option (for two options: two blocks side by side)",
    schema=ProsConsIn,
    example={
        "type": "pros_cons",
        "title": "Raft",
        "pros": [{"text": "Easier to implement and debug", "cite": "m:mat-1a2b3c:12"}],
        "cons": [{"text": "The leader limits write throughput", "cite": "m:mat-1a2b3c:30"},
                 {"text": "Few teaching implementations of the alternatives", "basis": "agent"}],
    },
    build=build,
    markdown=markdown,
)
