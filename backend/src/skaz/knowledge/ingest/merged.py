"""Merged repeats and how they come apart again (N2 decision 3; Q1 n2 H1/H2/M2).

A confirmed repeat of material B is merged into material A's statement: A's wording gets B's
citation and B's paragraph leaves the page (``wiki.repeats.strengthen``). B's paragraph is not thrown
away — the statement's marker keeps it (``merged=…``: B's block id, kind, text and citations, plus
exactly the citations and links the merge added), so that

* when B goes (its re-ingest, delete, or a correction that breaks B's quote), exactly what the merge
  added comes off A's statement, links included even when B's folder is unknown;
* when A goes, A's wording goes with A and B's own paragraph comes back as it was written. B's
  citation never ends up under words B did not say (H2), and the statement is B's again under B's
  own block id, so B's later re-ingest replaces it like any of B's statements (H1) and the overlap
  line counts it as B's own (M2).

Pure functions on blocks; the value is base64url JSON (a marker value has no spaces).
"""

from __future__ import annotations

import base64
import binascii
import json
from collections.abc import Collection, Sequence
from dataclasses import dataclass
from typing import Any, cast

from ..markdown.page import BLOCK_KINDS, Block, BlockKind, Cite

KEY = "merged"


@dataclass(frozen=True)
class Merged:
    """One repeat merged into a statement: its own paragraph, and what the merge added."""

    block_id: str
    kind: BlockKind
    body: str
    cites: tuple[Cite, ...]
    added_cites: tuple[Cite, ...]
    added_links: tuple[str, ...]

    @property
    def material_ids(self) -> frozenset[str]:
        return frozenset(cite.material_id for cite in self.cites)

    def block(self) -> Block | None:
        """The repeat's own paragraph as it was written (``None`` when it can't be rebuilt)."""
        try:
            return Block.create(self.block_id, self.kind, self.body, cites=self.cites, owner="agent")
        except ValueError:
            return None


def _cites(raw: Any) -> tuple[Cite, ...]:
    return tuple(Cite(str(item[0]), int(item[1]), item[2] if isinstance(item[2], str) else None)
                 for item in raw)


def _item(raw: Any) -> Merged | None:
    try:
        kind = raw["kind"]
        if kind not in BLOCK_KINDS:
            return None
        return Merged(str(raw["id"]), cast(BlockKind, kind), str(raw["body"]), _cites(raw["cites"]),
                      _cites(raw["added_cites"]), tuple(str(link) for link in raw["added_links"]))
    except (KeyError, TypeError, ValueError, IndexError):
        return None


def merged_of(block: Block) -> tuple[Merged, ...]:
    """The repeats merged into ``block`` (none for a block without the key or with a damaged value)."""
    value = block.attr(KEY)
    if not value:
        return ()
    try:
        raw = json.loads(base64.urlsafe_b64decode(value + "=" * (-len(value) % 4)).decode("utf-8"))
    except (binascii.Error, ValueError, UnicodeDecodeError):
        return ()
    if not isinstance(raw, list):
        return ()
    items = [_item(entry) for entry in raw]
    return tuple(item for item in items if item is not None)


def _encode(items: Sequence[Merged]) -> str:
    raw = [{"id": item.block_id, "kind": item.kind, "body": item.body,
            "cites": [[cite.material_id, cite.seg, cite.quote] for cite in item.cites],
            "added_cites": [[cite.material_id, cite.seg, cite.quote] for cite in item.added_cites],
            "added_links": list(item.added_links)} for item in items]
    data = json.dumps(raw, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def with_merged(attrs: tuple[tuple[str, str], ...], items: Sequence[Merged]) -> tuple[tuple[str, str], ...]:
    """``attrs`` with the ``merged`` key set to ``items`` (dropped when there are none)."""
    rest = tuple((key, value) for key, value in attrs if key != KEY)
    return (*rest, (KEY, _encode(items))) if items else rest


def _without(body: str, links: Sequence[str]) -> str:
    for link in links:
        body = body.replace(f" {link}" if f" {link}" in body else link, "", 1)
    return body.strip()


def _rebuilt(block: Block, removed: Sequence[Merged], kept: Sequence[Merged], *, every_cite: bool) -> Block:
    """``block`` without what ``removed`` added; ``every_cite``: also any other citation of their
    materials (the statement's author goes, so nothing of the repeats may stay under its words)."""
    gone = {cite for item in removed for cite in item.added_cites}
    materials = {material for item in removed for material in item.material_ids} if every_cite else set()
    cites = tuple(cite for cite in block.cites if cite not in gone and cite.material_id not in materials)
    body = _without(block.body, [link for item in removed for link in item.added_links])
    return Block.create(block.id, block.kind, body or block.body, cites=cites, owner="agent",
                        attrs=with_merged(block.attrs, kept))


@dataclass(frozen=True)
class Unmerged:
    #: The statement without the merges that concerned the material.
    block: Block
    #: Repeats that come back as their own paragraphs (the statement's author is the one going).
    restored: tuple[Block, ...] = ()


def take_material(block: Block, material_id: str, *, author: bool,
                  present: Collection[str] = ()) -> Unmerged | None:
    """``material_id``'s share of the repeats merged into ``block``; ``None`` when there is none.

    ``author``: ``block`` is ``material_id``'s own statement (its wording goes with it). Then every
    merge comes off and each repeat of another material comes back as its own paragraph; otherwise
    only the material's merged repeats come off. The caller then applies its usual rule to the
    returned block (the material's own statement goes; a statement of others stays). ``present``:
    block ids already on the page — a repeat whose id is there again is not brought back twice.
    """
    items = merged_of(block)
    if not items:
        return None
    if author:
        restored = [item.block() for item in items
                    if material_id not in item.material_ids and item.block_id not in present]
        return Unmerged(_rebuilt(block, items, (), every_cite=True),
                        tuple(part for part in restored if part is not None))
    removed = [item for item in items if material_id in item.material_ids]
    if not removed:
        return None
    rest = [item for item in items if item not in removed]
    return Unmerged(_rebuilt(block, removed, rest, every_cite=False))
