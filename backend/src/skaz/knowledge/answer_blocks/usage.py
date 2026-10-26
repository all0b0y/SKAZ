"""A local counter of the blocks agents choose (decision 4: extend the catalog by real use).

Counts only — block type, drawn or broken, items hidden — in this profile's settings
(key ``answer_blocks.usage``). No conversation text, no ids, nothing leaves the device.
A type the catalog doesn't know is counted as ``unknown`` (never the agent's own string).
"""
from __future__ import annotations

from typing import Any, Protocol

from .part import BlockPart
from .registry import BLOCKS

USAGE_KEY = "answer_blocks.usage"
UNKNOWN = "unknown"


class _Settings(Protocol):
    def get(self, key: str, default: Any = None) -> Any: ...

    def set(self, key: str, value: Any) -> None: ...


def record(settings: _Settings, part: BlockPart) -> None:
    if part.state == "drawing":
        return
    kind = part.kind if part.kind in BLOCKS else UNKNOWN
    data = counts(settings)
    entry = data.setdefault(kind, {"drawn": 0, "broken": 0, "hidden_items": 0})
    entry["drawn" if part.state == "ready" else "broken"] += 1
    entry["hidden_items"] += part.hidden
    settings.set(USAGE_KEY, data)


def counts(settings: _Settings) -> dict[str, dict[str, int]]:
    raw = settings.get(USAGE_KEY) or {}
    out: dict[str, dict[str, int]] = {}
    if not isinstance(raw, dict):
        return out
    for kind, entry in raw.items():
        if (kind in BLOCKS or kind == UNKNOWN) and isinstance(entry, dict):
            out[kind] = {name: int(entry.get(name) or 0) for name in ("drawn", "broken", "hidden_items")}
    return out
