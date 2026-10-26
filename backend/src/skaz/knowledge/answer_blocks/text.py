"""Text views of an answer block: plain text (preview, chat search) and the agent's own view (history)."""
from __future__ import annotations

import json
from typing import Any

from .part import BlockPart, BlockSource, MaterialSource, PageSource
from .registry import FENCE

_ITEM_KEYS = frozenset({"id", "src", "agent"})


def _strings(node: Any, skip: frozenset[str] = frozenset({"id", "kind"})) -> list[str]:
    if isinstance(node, str):
        return [node]
    if isinstance(node, list):
        return [text for item in node for text in _strings(item, skip)]
    if isinstance(node, dict):
        return [text for key, value in node.items() if key not in skip for text in _strings(value, skip)]
    return []


def _data(part: BlockPart) -> Any:
    if part.state != "ready" or part.data is None:
        return None
    try:
        return json.loads(part.data)
    except ValueError:
        return None


def block_plain(part: BlockPart) -> str:
    """The words of a drawn block, for previews and chat search ('' for a broken or drawing one)."""
    data = _data(part)
    return "\n" + "\n".join(_strings(data)) + "\n" if data is not None else ""


def _cite(source: BlockSource) -> str:
    if isinstance(source, MaterialSource):
        return f"m:{source.material_id}:{source.seg}"
    if isinstance(source, PageSource):
        return f"p:{source.page_id}#{source.block_id}" if source.block_id else f"p:{source.page_id}"
    return source.url


def _as_input(node: Any, sources: tuple[BlockSource, ...]) -> Any:
    """The stored block back in the agent's format: ``src``/``agent`` become ``cite``/``basis``."""
    if isinstance(node, list):
        return [_as_input(item, sources) for item in node]
    if not isinstance(node, dict):
        return node
    out: dict[str, Any] = {}
    for key, value in node.items():
        if key == "kind":
            out["type"] = value
        elif key not in _ITEM_KEYS and value is not None:
            out[key] = _as_input(value, sources)
    if set(node) >= _ITEM_KEYS:
        cites = [_cite(sources[index]) for index in node["src"] if 0 <= index < len(sources)]
        if node["agent"]:
            out["basis"] = "agent"
        elif cites:
            out["cite"] = cites[0] if len(cites) == 1 else cites
    return out


def block_agent_text(part: BlockPart) -> str:
    """What the agent sees of its own block in the history (only checked ids survive)."""
    if part.state == "broken":
        return f"\n[A block you wrote couldn't be drawn: {part.error or 'invalid data'}]\n"
    data = _data(part)
    if data is None:
        return ""
    body = json.dumps(_as_input(data, part.sources), ensure_ascii=False)
    return f"\n```{FENCE}\n{body}\n```\n"
