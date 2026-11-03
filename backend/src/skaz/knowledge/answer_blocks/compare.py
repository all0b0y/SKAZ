"""``compare``: compared objects in rows and comparison criteria in columns."""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, ValidationError

from . import md
from .base import BlockError, BlockIn, BlockSpec, ItemIn, Items, KbBlockItem, Strict, clean, envelope

MAX_COLUMNS = 6
MAX_ROWS = 30


class CompareCellIn(ItemIn):
    text: str = Field(min_length=1, max_length=300, description="What this object is on this criterion.")


class CompareRowEnvelope(Strict):
    label: str = Field(min_length=1, max_length=120, description="The compared object named by this row.")
    cells: list[Any] = Field(min_length=2, max_length=MAX_COLUMNS)


class CompareRowIn(CompareRowEnvelope):
    cells: list[CompareCellIn] = Field(min_length=2, max_length=MAX_COLUMNS,
                                       description="One cell per criterion column, in the order of columns.")


class CompareEnvelope(BlockIn):
    type: Literal["compare"]
    columns: list[str] = Field(min_length=2, max_length=MAX_COLUMNS,
                               description="The comparison criteria (column headings).")
    rows: list[Any] = Field(min_length=1, max_length=MAX_ROWS)


class CompareIn(CompareEnvelope):
    rows: list[CompareRowIn] = Field(min_length=1, max_length=MAX_ROWS,
                                     description="One row per compared object.")


class KbCompareCell(KbBlockItem):
    text: str


class KbCompareRow(BaseModel):
    id: str
    label: str
    #: One per column; ``null`` = the cell is hidden (its data was invalid or its source not found).
    cells: list[KbCompareCell | None]


class KbCompareBlock(BaseModel):
    kind: Literal["compare"]
    title: str | None
    columns: list[str]
    rows: list[KbCompareRow]


def build(data: dict[str, Any], items: Items) -> KbCompareBlock:
    block = envelope(CompareEnvelope, data)
    columns = [clean(column) for column in block.columns]
    if any(not column or len(column) > 80 for column in columns):
        raise BlockError("Invalid block data: columns: every column needs a short name (1–80 characters).")
    rows: list[KbCompareRow] = []
    for r, raw in enumerate(block.rows, start=1):
        try:
            row = CompareRowEnvelope.model_validate(raw)
        except ValidationError:
            given = raw.get("cells") if isinstance(raw, dict) else None
            items.hide(len(given) if isinstance(given, list) else 1)
            continue
        label = clean(row.label)
        if len(row.cells) != len(columns) or not label:
            items.hide(len(row.cells))  # cells don't line up with the columns, or no compared object is left
            continue
        row_id = items.ident(f"r{r}")
        cells: list[KbCompareCell | None] = []
        for c, cell in enumerate(row.cells, start=1):
            checked = items.item(CompareCellIn, cell, f"{row_id}c{c}")
            cells.append(KbCompareCell(**checked[0].out(), text=checked[1].text) if checked else None)
        if any(cell is not None for cell in cells):
            rows.append(KbCompareRow(id=row_id, label=label, cells=cells))
    return KbCompareBlock(kind="compare", title=block.title, columns=columns, rows=rows)


def markdown(block: KbCompareBlock, refs: md.Refs) -> list[str]:
    """A table; a hidden cell is “—”. References sit in the cells, or after the row for wiki links."""
    rows: list[str] = []
    for row in block.rows:
        if refs.cells:
            rows.append(md.row([md.cell(row.label), *(md.cell(cell.text + refs.of(cell)) if cell else "—"
                                                      for cell in row.cells)]))
        else:
            after = "".join(refs.of(cell) for cell in row.cells if cell)
            rows.append(md.row([md.cell(row.label), *(md.cell(cell.text) if cell else "—"
                                                      for cell in row.cells)], after))
    return [*md.title(block.title), *md.table(["", *(md.cell(column) for column in block.columns)], rows)]


SPEC = BlockSpec(
    name="compare",
    when="two to six compared objects as rows, two to six criteria as columns (a comparison table)",
    schema=CompareIn,
    example={
        "type": "compare",
        "columns": ["Leader", "Used in"],
        "rows": [
            {"label": "Raft", "cells": [
                {"text": "Always one strong leader per term", "cite": "m:mat-1a2b3c:12"},
                {"text": "etcd, Consul", "basis": "agent"}]},
            {"label": "Paxos", "cells": [
                {"text": "Optional, an optimisation (Multi-Paxos)", "cite": "m:mat-4d5e6f:3"},
                {"text": "Chubby (Google)", "cite": "p:pg-7a8b9c"}]},
        ],
    },
    build=build,
    markdown=markdown,
)
