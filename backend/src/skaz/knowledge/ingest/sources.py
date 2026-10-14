"""Reading a material for ingest: fragments, exclusions, corrections layer, and parts.

``excluded.json`` belongs to area S1 (poisoning layer 3). It is read
tolerantly: a list of entries, or an object with ``fragments``/``excluded``,
each entry carrying ``seg`` (``12`` or ``"seg-12"``); entries marked
``restored`` are not excluded. An unreadable file excludes nothing it cannot
name, but is reported to the caller so the job journal shows it.
"""
from __future__ import annotations

import json
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..library.layout import SERVICE_DIR
from ..library.library import Library, MaterialFiles
from ..markdown.source import Fragment
from .protocols import TextLayer

EXCLUDED_FILE = "excluded.json"
#: Characters of fragment text per part sent to the model in one go.
DEFAULT_PART_BUDGET = 24_000


class ExclusionsUnreadable(ValueError):
    pass


@dataclass(frozen=True)
class IngestSource:
    files: MaterialFiles
    #: Fragments the wiki may use, in source order (excluded ones removed, corrections applied).
    fragments: tuple[Fragment, ...]
    excluded: frozenset[int]

    @property
    def material_id(self) -> str:
        return self.files.manifest.id

    @property
    def title(self) -> str:
        return self.files.title

    @property
    def folder_name(self) -> str:
        return self.files.directory.parent.name

    def by_seg(self) -> dict[int, Fragment]:
        return {fragment.seg: fragment for fragment in self.fragments}


def _seg_of(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value >= 1 else None
    if isinstance(value, str):
        digits = value.removeprefix("seg-")
        if digits.isdigit() and int(digits) >= 1:
            return int(digits)
    return None


def read_exclusions(material_dir: Path) -> frozenset[int]:
    path = material_dir / SERVICE_DIR / EXCLUDED_FILE
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return frozenset()
    except (OSError, ValueError, UnicodeDecodeError) as error:
        raise ExclusionsUnreadable(str(error)) from error
    entries = data
    if isinstance(data, dict):
        entries = data.get("fragments", data.get("excluded", []))
    if not isinstance(entries, list):
        raise ExclusionsUnreadable("excluded.json has no list of fragments.")
    found = set()
    for entry in entries:
        if isinstance(entry, dict):
            if entry.get("restored"):
                continue
            seg = _seg_of(entry.get("seg", entry.get("id")))
        else:
            seg = _seg_of(entry)
        if seg is None:
            raise ExclusionsUnreadable("excluded.json names a fragment SKAZ can't read.")
        found.add(seg)
    return frozenset(found)


def load_source(library: Library, material_id: str, hint: str | None, layer: TextLayer) -> IngestSource:
    files = library.read_material(material_id, hint=hint)
    excluded = read_exclusions(files.directory)
    allowed = [fragment for fragment in files.fragments if fragment.seg not in excluded]
    corrected = layer.apply(material_id, allowed)
    if [fragment.seg for fragment in corrected] != [fragment.seg for fragment in allowed]:
        raise ValueError("The corrections layer must keep every fragment and its id.")
    return IngestSource(files, tuple(corrected), excluded)


def split_parts(fragments: Sequence[Fragment], budget: int = DEFAULT_PART_BUDGET) -> list[list[Fragment]]:
    """Consecutive parts of at most ``budget`` characters; a fragment is never cut.

    A single fragment longer than the budget forms its own part. Every fragment
    lands in exactly one part, in source order.
    """
    parts: list[list[Fragment]] = []
    current: list[Fragment] = []
    size = 0
    for fragment in fragments:
        length = len(fragment.text)
        if current and size + length > budget:
            parts.append(current)
            current, size = [], 0
        current.append(fragment)
        size += length
    if current:
        parts.append(current)
    return parts
