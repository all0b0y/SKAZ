"""``chart``: numbers compared as horizontal bars (SKAZ draws it; no chart library)."""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from . import md
from .base import BlockIn, BlockSpec, ItemIn, Items, KbBlockItem, clean, envelope

MAX_BARS = 20


class BarIn(ItemIn):
    label: str = Field(min_length=1, max_length=80, description="What the bar is.")
    value: float = Field(ge=0, allow_inf_nan=False, description="Its number (zero or more).")
    alt: bool = Field(default=False, description="true: a hatched bar, the variant alt_label names.")


class ChartEnvelope(BlockIn):
    type: Literal["chart"]
    unit: str | None = Field(default=None, min_length=1, max_length=16,
                             description="Optional unit of the values (\"ms\", \"%\").")
    alt_label: str | None = Field(default=None, min_length=1, max_length=120,
                                  description="What a hatched bar means, when some bars have alt.")
    order: Literal["value", "given"] = Field(
        default="value", description="\"value\": largest first (default); \"given\": as listed.")
    bars: list[Any] = Field(min_length=1, max_length=MAX_BARS)


class ChartIn(ChartEnvelope):
    bars: list[BarIn] = Field(min_length=1, max_length=MAX_BARS, description="One bar per thing measured.")


class KbChartBar(KbBlockItem):
    label: str
    value: float
    #: The value as shown and copied (the same text everywhere).
    display: str
    alt: bool


class KbChartBlock(BaseModel):
    kind: Literal["chart"]
    title: str | None
    unit: str | None
    alt_label: str | None
    bars: list[KbChartBar]


def number(value: float) -> str:
    """``8.4``, ``1200`` — at most four decimals, no exponent."""
    if value == int(value) and abs(value) < 1e15:
        return str(int(value))
    return f"{value:.4f}".rstrip("0").rstrip(".")


def build(data: dict[str, Any], items: Items) -> KbChartBlock:
    block = envelope(ChartEnvelope, data)
    bars = [KbChartBar(**ids.out(), label=bar.label, value=bar.value, display=number(bar.value), alt=bar.alt)
            for ids, bar in items.many(BarIn, block.bars, "b")]
    if block.order == "value":
        bars.sort(key=lambda bar: -bar.value)
    alt_label = (clean(block.alt_label) or None) if block.alt_label and any(bar.alt for bar in bars) else None
    unit = (clean(block.unit) or None) if block.unit else None
    return KbChartBlock(kind="chart", title=block.title, unit=unit, alt_label=alt_label, bars=bars)


def markdown(block: KbChartBlock, refs: md.Refs) -> list[str]:
    """A table of the numbers (decision 11); a hatched bar is marked \u2020 and explained under it."""
    value = f"Value, {md.cell(block.unit)}" if block.unit else "Value"
    sources = refs.cells and any(refs.of(bar) for bar in block.bars)
    rows: list[str] = []
    for bar in block.bars:
        label = md.cell(bar.label) + (" \u2020" if bar.alt and block.alt_label else "")
        if sources:
            rows.append(md.row([label, bar.display, md.cell(refs.of(bar).strip())]))
        else:
            rows.append(md.row([label, bar.display], "" if refs.cells else refs.of(bar)))
    lines = [*md.title(block.title), *md.table(["", value, *(["Source"] if sources else [])], rows)]
    if block.alt_label:
        lines += ["", f"\u2020 {md.text(block.alt_label)}"]
    return lines


SPEC = BlockSpec(
    name="chart",
    when="numbers compared across a few things, drawn as bars (a ranking, sizes, durations)",
    schema=ChartIn,
    example={
        "type": "chart",
        "title": "Write latency on the lecture's test bench",
        "unit": "ms",
        "alt_label": "No stable leader",
        "bars": [
            {"label": "Basic Paxos", "value": 8.4, "alt": True, "cite": "m:mat-4d5e6f:11"},
            {"label": "Multi-Paxos", "value": 4.4, "cite": "m:mat-4d5e6f:11"},
            {"label": "Raft", "value": 4.0, "cite": "m:mat-1a2b3c:33"},
        ],
    },
    build=build,
    markdown=markdown,
)
