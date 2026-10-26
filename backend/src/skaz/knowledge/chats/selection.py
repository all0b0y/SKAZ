"""P2: what the user picked in an earlier answer, checked against the stored answer and told to the agent.

A selection names one answer message, one block of it — an answer block (P1, by its id) or a
Mermaid diagram (``mmd-<FNV-1a of its trimmed lines>``, computed here and in the chat UI) — and items
of it by id: an answer block's item ids, or a flowchart's ``node:<id>`` / ``edge:<from>-><to>``.
Nothing is trusted from the client but the ids: the block, its items and their sources are read
from the stored answer. The agent gets the items' data with their sources as untrusted data inside
the normal context of the question; SKAZ's own note above it says what the user asked.
"""
from __future__ import annotations

import json
import re
import unicodedata
from collections.abc import Sequence
from typing import Any

from ..answer_blocks.part import BlockPart, BlockSource, MaterialSource, PageSource
from ..errors import KnowledgeError
from .model import Message, SelectedItem, Selection, TextPart

MAX_ITEMS = 20
LABEL_CHARS = 80
ITEM_CHARS = 1_500
_FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})[ \t]*mermaid[ \t]*\n(.*?)\n {0,3}\1[ \t]*$",
                    re.MULTILINE | re.DOTALL | re.IGNORECASE)
_NODE = re.compile(r"node:([\w]+)")
_EDGE = re.compile(r"edge:([\w]+)->([\w]+)")

GONE = "The answer you selected from is no longer in this chat."


class SelectionInvalid(KnowledgeError):
    status_code = 422


# -- addressing -----------------------------------------------------------------------


def diagram_id(source: str) -> str:
    """FNV-1a (32 bit) over the UTF-8 of the trimmed, non-empty lines (``chat/select/model.ts``)."""
    normal = "\n".join(line.strip() for line in source.split("\n") if line.strip())
    value = 0x811C9DC5
    for byte in normal.encode("utf-8"):
        value = ((value ^ byte) * 0x01000193) & 0xFFFFFFFF
    return f"mmd-{value:08x}"


def answer_text(message: Message) -> str:
    return "".join(part.text for part in message.parts if isinstance(part, TextPart))


def diagrams(message: Message) -> dict[str, str]:
    """The closed ```mermaid fences of an answer by their id."""
    return {diagram_id(match.group(2)): match.group(2) for match in _FENCE.finditer(answer_text(message))}


def block_part(message: Message, block_id: str) -> BlockPart | None:
    return next((part for part in message.parts if isinstance(part, BlockPart) and part.block_id == block_id
                 and part.state == "ready" and part.data), None)


def _find(node: Any, wanted: str, trail: tuple[dict[str, Any], ...] = ()
          ) -> tuple[dict[str, Any], tuple[dict[str, Any], ...], int | None] | None:
    """The item with id ``wanted`` anywhere in a block's data, the items around it, its list position."""
    if isinstance(node, list):
        for index, child in enumerate(node):
            found = _find(child, wanted, trail)
            if found is not None:
                item, parents, position = found
                return item, parents, index if position is None and item is child else position
        return None
    if not isinstance(node, dict):
        return None
    if trail and node.get("id") == wanted:
        return node, trail[1:], None
    for value in node.values():
        found = _find(value, wanted, (*trail, node))
        if found is not None:
            return found
    return None


def _has_token(source: str, token: str) -> bool:
    return re.search(rf"(?<!\w){re.escape(token)}(?!\w)", source) is not None


def _label(text: str) -> str:
    value = "".join(char for char in unicodedata.normalize("NFC", text)
                    if unicodedata.category(char)[0] != "C")
    value = " ".join(value.split())
    return value if len(value) <= LABEL_CHARS else value[: LABEL_CHARS - 1].rstrip() + "…"


def check_selection(messages: Sequence[Message], selection: Selection) -> Selection:
    """The selection as stored: ids that exist in the stored answer, labels cleaned, the block's own title."""
    message = next((m for m in messages if m.id == selection.message_id and m.role == "assistant"), None)
    if message is None:
        raise SelectionInvalid(GONE)
    ids = list(dict.fromkeys(item.id for item in selection.items))
    if not ids or len(ids) > MAX_ITEMS:
        raise SelectionInvalid(f"Select one to {MAX_ITEMS} items.")
    title: str | None = None
    if selection.kind == "block":
        part = block_part(message, selection.block_id)
        if part is None:
            raise SelectionInvalid("This block is no longer in the answer.")
        data = json.loads(part.data or "{}")
        if any(_find(data, item_id) is None for item_id in ids):
            raise SelectionInvalid("Some selected items are no longer in the block.")
        raw_title = data.get("title") if isinstance(data, dict) else None
        title = raw_title if isinstance(raw_title, str) else None
    else:
        source = diagrams(message).get(selection.block_id)
        if source is None:
            raise SelectionInvalid("This diagram is no longer in the answer.")
        for item_id in ids:
            node, edge = _NODE.fullmatch(item_id), _EDGE.fullmatch(item_id)
            ends = [node.group(1)] if node else [edge.group(1), edge.group(2)] if edge else []
            if not ends or not all(_has_token(source, end) for end in ends):
                raise SelectionInvalid("Some selected items are not in the diagram.")
    labels = {item.id: item.label for item in selection.items}
    items = tuple(SelectedItem(item_id, _label(labels.get(item_id, "")) or item_id) for item_id in ids)
    return Selection(message.id, selection.block_id, selection.kind, title, items, selection.intent)


# -- what the agent is told --------------------------------------------------------------


def _ref(source: BlockSource) -> dict[str, Any]:
    if isinstance(source, MaterialSource):
        out: dict[str, Any] = {"cite": f"m:{source.material_id}:{source.seg}"}
        if source.quote:
            out["quote"] = source.quote
        return out
    if isinstance(source, PageSource):
        return {"cite": f"p:{source.page_id}" + (f"#{source.block_id}" if source.block_id else ""),
                "wiki_page": source.title}
    return {"web": source.url, "title": source.title}


def _shown(node: Any, sources: Sequence[BlockSource]) -> Any:
    """An item as the agent reads it: its fields, and its sources as citable references."""
    if isinstance(node, list):
        return [_shown(child, sources) for child in node]
    if not isinstance(node, dict):
        return node
    out = {key: _shown(value, sources) for key, value in node.items() if key not in ("src", "agent")}
    if node.get("agent") is True:
        out["sources"] = "the agent's own knowledge, not from the user's materials"
    elif isinstance(node.get("src"), list):
        out["sources"] = [_ref(sources[index]) for index in node["src"]
                          if isinstance(index, int) and 0 <= index < len(sources)]
    return out


def _clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _block_body(message: Message, selection: Selection) -> str | None:
    part = block_part(message, selection.block_id)
    if part is None:
        return None
    data = json.loads(part.data or "{}")
    if not isinstance(data, dict):
        return None
    # The block's own fields that are not item lists (kind, title, compare's columns).
    head = {key: value for key, value in data.items()
            if not (isinstance(value, list)
                    and any(isinstance(child, (dict, type(None))) for child in value))}
    lines = [f"Answer block {selection.block_id} (message {message.id}): "
             + json.dumps(head, ensure_ascii=False, sort_keys=True)]
    for item in selection.items:
        found = _find(data, item.id)
        if found is None:
            continue
        node, parents, position = found
        shown: dict[str, Any] = {"id": item.id, **_shown(node, part.sources)}
        if parents:
            shown["inside"] = [{key: value for key, value in parent.items() if isinstance(value, (str, int))}
                               for parent in parents]
        if position is not None:
            shown["position"] = position + 1
        lines.append("- " + _clip(json.dumps(shown, ensure_ascii=False), ITEM_CHARS))
    return "\n".join(lines)


def _diagram_body(message: Message, selection: Selection) -> str | None:
    source = diagrams(message).get(selection.block_id)
    if source is None:
        return None
    picked = "\n".join(f"- {item.id}: {item.label}" for item in selection.items)
    return (f"Mermaid diagram {selection.block_id} of answer {message.id}. Selected (ids from its source):\n"
            f"{picked}\nThe diagram's source:\n```mermaid\n{source}\n```")


_NOTES = {
    "ask": ("The user selected these items in your earlier answer (an AI answer: context, not evidence) "
            "and asks about them in the message below."),
    "explain": ("The user selected these items in your earlier answer and pressed «Explain more»: explain "
                "them in more detail from the sources, citing them. Answer in the language of that answer "
                "unless the user wrote their own words in another language."),
    "wrong": ("The user selected these items in your earlier answer and says they are wrong. Recheck each "
              "selected item against its sources — read them with the tools; the earlier answer is not "
              "evidence. Say plainly which items hold and which don't, citing the sources. Answer in the "
              "language of that answer unless the user wrote their own words in another language."),
}


def selection_context(messages: Sequence[Message], selection: Selection) -> tuple[str, str, str] | None:
    """(note, label, body) for the question's context; ``None`` when the answer is gone since."""
    message = next((m for m in messages if m.id == selection.message_id and m.role == "assistant"), None)
    if message is None:
        return None
    body = _block_body(message, selection) if selection.kind == "block" else _diagram_body(message, selection)
    if body is None:
        return None
    return f"{_NOTES[selection.intent]} The selected items:", "selected items", body


def history_note(selection: Selection) -> str:
    """A past question's selection, short, for the conversation history."""
    labels = "; ".join(f"“{item.label}”" for item in selection.items)
    return f"(The user selected in an earlier answer: {labels})"
