"""The catalog of answer blocks: one line per block type, and turning the agent's data into a block.

Adding a block = one schema module (envelope, input model, output model, ``build``, ``SPEC``),
one line in ``BLOCKS`` and one in ``KbAnswerBlock`` here, and one renderer on the frontend.
"""
from __future__ import annotations

import json
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Annotated

from pydantic import Field

from . import compare, steps, timeline
from .base import BlockError, BlockSpec, Checker, Items, clean

BLOCKS: dict[str, BlockSpec] = {spec.name: spec for spec in (
    compare.SPEC,
    timeline.SPEC,
    steps.SPEC,
)}

#: A validated block as stored and drawn (the API part's ``block``).
KbAnswerBlock = Annotated[
    compare.KbCompareBlock
    | timeline.KbTimelineBlock
    | steps.KbStepsBlock,
    Field(discriminator="kind"),
]

#: The name of the fenced block in an answer.
FENCE = "skaz-block"
ERROR_CHARS = 300


@dataclass(frozen=True)
class Built:
    kind: str
    #: The output model as canonical JSON.
    data: str
    hidden: int


class Broken(Exception):
    """The block can't be drawn; ``kind`` is its type when it was readable (for the usage counter)."""

    def __init__(self, message: str, kind: str | None = None) -> None:
        super().__init__(message[:ERROR_CHARS])
        self.kind = kind


def build_block(payload: str, checker: Checker) -> Built:
    """The agent's fenced JSON as a validated block; raises ``Broken`` with a plain-English reason."""
    try:
        data = json.loads(payload)
    except ValueError as error:
        line = getattr(error, "lineno", None)
        raise Broken("The block data is not valid JSON" + (f" (line {line})." if line else ".")) from error
    if not isinstance(data, dict):
        raise Broken("The block data must be one JSON object.")
    kind = data.get("type")
    spec = BLOCKS.get(kind) if isinstance(kind, str) else None
    if spec is None:
        named = f" “{clean(kind)[:40]}”" if isinstance(kind, str) and clean(kind) else ""
        raise Broken(f"Unknown block type{named}. Use one of: {', '.join(BLOCKS)}.")
    items = Items(checker)
    try:
        block = spec.build(data, items)
    except BlockError as error:
        raise Broken(str(error), spec.name) from error
    if items.shown == 0:
        raise Broken("None of the block's items could be shown: each needs a source that exists "
                     "(cite) or basis \"agent\".", spec.name)
    return Built(spec.name, json.dumps(block.model_dump(mode="json"), ensure_ascii=False, sort_keys=True),
                 items.hidden)


def block_index() -> str:
    """The short list for the chat instructions: name and when to use it (decision 3)."""
    return "\n".join(f"- {spec.name}: {spec.when}" for spec in BLOCKS.values())


def known(names: Sequence[str]) -> tuple[list[BlockSpec], list[str]]:
    """The specs asked for (in catalog order) and the names that are no block."""
    wanted = {name.strip() for name in names}
    return [spec for spec in BLOCKS.values() if spec.name in wanted], sorted(wanted - set(BLOCKS))


def example_fence(spec: BlockSpec) -> str:
    return f"```{FENCE}\n{json.dumps(spec.example, ensure_ascii=False)}\n```"
