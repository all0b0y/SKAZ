"""``steps``: an ordered procedure — how something is done or happens, step by step."""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from .base import BlockIn, BlockSpec, ItemIn, Items, KbBlockItem, envelope

MAX_STEPS = 20


class StepIn(ItemIn):
    title: str = Field(min_length=1, max_length=200, description="The step, in a few words.")
    text: str | None = Field(default=None, min_length=1, max_length=600, description="Optional detail.")


class StepsEnvelope(BlockIn):
    type: Literal["steps"]
    steps: list[Any] = Field(min_length=1, max_length=MAX_STEPS)


class StepsIn(StepsEnvelope):
    steps: list[StepIn] = Field(min_length=1, max_length=MAX_STEPS, description="The steps in order.")


class KbStep(KbBlockItem):
    title: str
    text: str | None


class KbStepsBlock(BaseModel):
    kind: Literal["steps"]
    title: str | None
    steps: list[KbStep]


def build(data: dict[str, Any], items: Items) -> KbStepsBlock:
    block = envelope(StepsEnvelope, data)
    steps: list[KbStep] = []
    for n, raw in enumerate(block.steps, start=1):
        checked = items.item(StepIn, raw, f"s{n}")
        if checked is not None:
            ids, step = checked
            steps.append(KbStep(**ids.out(), title=step.title, text=step.text))
    return KbStepsBlock(kind="steps", title=block.title, steps=steps)


SPEC = BlockSpec(
    name="steps",
    when="an ordered procedure: how something is done or happens, step by step",
    schema=StepsIn,
    example={
        "type": "steps",
        "title": "Leader election",
        "steps": [
            {"title": "Timeout", "text": "A follower hears no leader for 150–300 ms",
             "cite": "m:mat-1a2b3c:12"},
            {"title": "Becomes a candidate", "text": "Increments the term and votes for itself",
             "cite": "m:mat-1a2b3c:13"},
            {"title": "Majority → leader", "cite": "p:pg-7a8b9c#c-3f2e"},
        ],
    },
    build=build,
)
