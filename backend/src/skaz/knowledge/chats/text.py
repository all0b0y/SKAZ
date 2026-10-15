"""Text views of a message: plain text (preview, search), agent text (handoff), titles."""
from __future__ import annotations

import json
import re
import unicodedata
from collections.abc import Sequence
from datetime import UTC, datetime

from .model import CitePart, ConnectionPart, PagePart, Part, TextPart, ToolPart

PREVIEW_CHARS = 140
TITLE_CHARS = 60
DEFAULT_TITLE = "New chat"
_WHITESPACE = re.compile(r"\s+")
_MARKDOWN_NOISE = re.compile(r"[*_`>#]+")


def utc_now() -> str:
    """ISO-8601 UTC with milliseconds: chats and messages created within one second keep their order."""
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def collapse(text: str) -> str:
    return _WHITESPACE.sub(" ", text).strip()


def plain_text(parts: Sequence[Part]) -> str:
    """What the reader sees, without chips' ids: for previews and chat search."""
    pieces: list[str] = []
    for part in parts:
        if isinstance(part, TextPart):
            pieces.append(part.text)
        elif isinstance(part, PagePart):
            pieces.append(f" {part.title} ")
        elif isinstance(part, ConnectionPart):
            pieces.append("\n" + "\n".join(side.text for side in part.sides) + "\n" + part.inference + "\n")
    return "".join(pieces)


def preview(parts: Sequence[Part]) -> str:
    text = collapse(_MARKDOWN_NOISE.sub("", plain_text(parts)))
    return text if len(text) <= PREVIEW_CHARS else text[: PREVIEW_CHARS - 1].rstrip() + "…"


def agent_text(parts: Sequence[Part]) -> str:
    """The answer as the next agent sees it after a switch: only checked ids survive as tokens."""
    pieces: list[str] = []
    for part in parts:
        if isinstance(part, TextPart):
            pieces.append(part.text)
        elif isinstance(part, CitePart):
            pieces.append(f"⟦m:{part.material_id}:{part.seg}⟧")
        elif isinstance(part, PagePart):
            pieces.append(f"⟦p:{part.page_id}#{part.block_id}⟧" if part.block_id else f"⟦p:{part.page_id}⟧")
        elif isinstance(part, ConnectionPart):
            payload = {
                "folders": [{"folder_id": side.folder_id, "text": side.text,
                             "cite": f"{side.material_id}:{side.seg}"} for side in part.sides],
                "inference": part.inference,
                **({"page_id": part.page_id} if part.page_id else {}),
            }
            pieces.append("\n```skaz-connection\n" + json.dumps(payload, ensure_ascii=False) + "\n```\n")
        elif isinstance(part, ToolPart):
            continue
    return "".join(pieces).strip()


def auto_title(text: str) -> str:
    """A chat title from the first question: its first line, cut at a word, no control characters."""
    line = next((candidate for candidate in text.splitlines() if candidate.strip()), "")
    cleaned = "".join(char for char in unicodedata.normalize("NFC", line)
                      if unicodedata.category(char)[0] != "C")
    cleaned = collapse(_MARKDOWN_NOISE.sub("", cleaned))
    if not cleaned:
        return DEFAULT_TITLE
    if len(cleaned) <= TITLE_CHARS:
        return cleaned
    cut = cleaned[:TITLE_CHARS]
    space = cut.rfind(" ")
    return (cut[:space] if space > TITLE_CHARS // 2 else cut).rstrip(" ,.;:") + "…"
