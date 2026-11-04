"""``key_numbers``: a few numbers that matter, large, each with what it measures."""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from . import md
from .base import BlockIn, BlockSpec, ItemIn, Items, KbBlockItem, envelope

MAX_NUMBERS = 6


class KeyNumberIn(ItemIn):
    value: str = Field(min_length=1, max_length=24,
                       description="The number as written (\"150–300\", \"2f+1\", \"40%\").")
    unit: str | None = Field(default=None, min_length=1, max_length=16, description="Optional unit (\"ms\").")
    label: str = Field(min_length=1, max_length=200, description="What the number measures, in a few words.")


class KeyNumbersEnvelope(BlockIn):
    type: Literal["key_numbers"]
    numbers: list[Any] = Field(min_length=1, max_length=MAX_NUMBERS)


class KeyNumbersIn(KeyNumbersEnvelope):
    numbers: list[KeyNumberIn] = Field(min_length=1, max_length=MAX_NUMBERS, description="The numbers.")


class KbKeyNumber(KbBlockItem):
    value: str
    unit: str | None
    label: str


class KbKeyNumbersBlock(BaseModel):
    kind: Literal["key_numbers"]
    title: str | None
    numbers: list[KbKeyNumber]


def build(data: dict[str, Any], items: Items) -> KbKeyNumbersBlock:
    block = envelope(KeyNumbersEnvelope, data)
    numbers = [KbKeyNumber(**ids.out(), value=number.value, unit=number.unit, label=number.label)
               for ids, number in items.many(KeyNumberIn, block.numbers, "k")]
    return KbKeyNumbersBlock(kind="key_numbers", title=block.title, numbers=numbers)


def markdown(block: KbKeyNumbersBlock, refs: md.Refs) -> list[str]:
    return [*md.title(block.title),
            *(f"- **{md.text(number.value)}" + (f" {md.text(number.unit)}" if number.unit else "")
              + f"**: {md.text(number.label)}{refs.of(number)}" for number in block.numbers)]


SPEC = BlockSpec(
    name="key_numbers",
    when="one to six numbers that matter, shown large with what each measures",
    schema=KeyNumbersIn,
    example={
        "type": "key_numbers",
        "numbers": [
            {"value": "150–300", "unit": "ms", "label": "Raft's election timeout", "cite": "m:mat-1a2b3c:12"},
            {"value": "2f+1", "label": "nodes to survive f failures", "cite": "p:pg-7a8b9c"},
        ],
    },
    build=build,
    markdown=markdown,
)
