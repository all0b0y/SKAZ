"""Export of a chat as Markdown (the UI saves it through the native dialog).

Chips become readable references (source title · time or page, wiki page
title); ids, tool steps and SKAZ markup are left out.
"""
from __future__ import annotations

import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass

from ..agents.registry import ENGINE_NAMES
from ..markdown.text import format_timestamp
from ..service import KnowledgeService
from .model import Chat, CitePart, ConnectionPart, Message, PagePart, Part, TextPart
from .text import DEFAULT_TITLE

_FILE_FORBIDDEN = re.compile(r'[/\\:*?"<>|\x00-\x1f]')
MAX_FILE_STEM = 120


@dataclass(frozen=True)
class ChatExport:
    file_name: str
    markdown: str


def file_name(title: str) -> str:
    stem = " ".join(_FILE_FORBIDDEN.sub(" ", title).split()).lstrip(". ")[:MAX_FILE_STEM].rstrip()
    return f"{stem or DEFAULT_TITLE}.md"


class _Labels:
    def __init__(self, kb: KnowledgeService) -> None:
        self.kb = kb

    def cite(self, material_id: str, seg: int) -> str:
        record = self.kb.material_repo.get(material_id)
        if record is None:
            return "[source no longer in the library]"
        found = self.kb.material_repo.fragment_map({(material_id, seg)}).get((material_id, seg))
        where = ""
        if found is not None:
            fragment = found[0]
            if fragment.start_ms is not None:
                where = f" · {format_timestamp(fragment.start_ms)}"
            elif fragment.page is not None:
                where = f" · p. {fragment.page}"
        return f"[{record.title}{where}]"

    def page(self, part: PagePart) -> str:
        record = self.kb.page_repo.get(part.page_id)
        return f"[{record.title if record else part.title}]"

    def folder(self, folder_id: str) -> str:
        folder = self.kb.folder_repo.get(folder_id)
        return folder.name if folder else "Folder"


def _render_parts(parts: Sequence[Part], labels: _Labels) -> str:
    out: list[str] = []

    def chip(label: str) -> None:
        spaced = not out or out[-1][-1:].isspace()
        out.append(label if spaced else " " + label)

    for part in parts:
        if isinstance(part, TextPart):
            out.append(part.text)
        elif isinstance(part, CitePart):
            chip(labels.cite(part.material_id, part.seg))
        elif isinstance(part, PagePart):
            chip(labels.page(part))
        elif isinstance(part, ConnectionPart):
            lines = [f"\n\n> **Connection · {len({side.folder_id for side in part.sides})} folders**"]
            for side in part.sides:
                lines.append(f"> - {labels.folder(side.folder_id)}: {side.text} "
                             f"{labels.cite(side.material_id, side.seg)}")
            if part.inference:
                lines.append(f"> - *Agent inference:* {part.inference}")
            out.append("\n".join(lines) + "\n\n")
    return "".join(out).strip()


def export_chat(kb: KnowledgeService, chat: Chat, messages: Sequence[Message],
                now: Callable[[], str]) -> ChatExport:
    labels = _Labels(kb)
    lines = [f"# {chat.title}", "", f"*Exported from SKAZ on {now()[:10]}.*", ""]
    for message in messages:
        if message.role == "system":
            lines += [f"*{_render_parts(message.parts, labels)}*", ""]
            continue
        if message.role == "user":
            lines += [f"## You · {message.created_at[:16].replace('T', ' ')}", ""]
            given = message.input
            lines.append(given.text if given is not None else _render_parts(message.parts, labels))
            for quote in given.quotes if given is not None else ():
                origin = "AI answer" if quote.source == "chat" else quote.source
                lines += ["", f"> *Quoted ({origin}):* " + " ".join(quote.text.split())]
            lines.append("")
            continue
        name = ENGINE_NAMES.get(message.engine, "Assistant") if message.engine else "Assistant"
        lines += [f"## {name} · {message.created_at[:16].replace('T', ' ')}", ""]
        body = _render_parts(message.parts, labels)
        if body:
            lines.append(body)
        if message.state in ("interrupted", "failed") and message.failure is not None:
            lines += ["", f"*Answer interrupted: {message.failure.message}*"]
        elif message.state == "cancelled":
            lines += ["", "*Answer stopped.*"]
        lines.append("")
    return ChatExport(file_name(chat.title), "\n".join(lines).rstrip() + "\n")
