"""Checking the agent's references against the library (runs in a worker thread).

An id the library does not know is dropped: it never becomes a chip and its
text never reaches the answer. A fragment excluded as a possible instruction
(S1) is not a valid citation either. A quote counts only when it is a verbatim
part of the fragment as the wiki sees it (corrections applied, layer 4).
"""
from __future__ import annotations

import json
from collections.abc import Callable, Mapping
from typing import Any

from ..agents.mcp_access import tool_name
from ..errors import KnowledgeError
from ..ingest.checks import MIN_QUOTE_CHARS, clean_text
from ..ingest.protocols import IdentityTextLayer, TextLayer
from ..ingest.sources import ExclusionsUnreadable, IngestSource, load_source
from ..markdown.source import Fragment
from ..markdown.text import normalize_text, quote_in_fragment
from ..service import KnowledgeService
from .model import CitePart, ConnectionPart, ConnectionSide, PagePart, TextPart, ToolPart
from .parsing import CiteToken, PageToken, parse_token, strip_tokens

MAX_SIDE_CHARS = 1_000
MAX_INFERENCE_CHARS = 2_000
MAX_SIDES = 8


class MaterialReader:
    """Material fragments as the wiki sees them, cached for one answer or one save."""

    def __init__(self, kb: KnowledgeService, text_layer: TextLayer | None = None) -> None:
        self.kb = kb
        self.text_layer = text_layer or IdentityTextLayer()
        self._sources: dict[str, IngestSource | None] = {}

    def source(self, material_id: str) -> IngestSource | None:
        if material_id not in self._sources:
            self._sources[material_id] = self._load(material_id)
        return self._sources[material_id]

    def _load(self, material_id: str) -> IngestSource | None:
        record = self.kb.material_repo.get(material_id)
        if record is None:
            return None
        try:
            return load_source(self.kb.require(), material_id, record.rel_dir, self.text_layer)
        except (KnowledgeError, ExclusionsUnreadable, OSError, ValueError):
            return None  # unreadable now: nothing of it is cited or quoted

    def fragment(self, material_id: str, seg: int) -> Fragment | None:
        source = self.source(material_id)
        return source.by_seg().get(seg) if source is not None else None

    def checked_quote(self, material_id: str, seg: int, quote: str | None) -> str | None:
        """``quote`` when it is verbatim in the fragment and long enough to be evidence; else ``None``."""
        fragment = self.fragment(material_id, seg)
        if fragment is None or not quote:
            return None
        if not quote_in_fragment(quote, fragment.text):
            return None
        if len(normalize_text(quote)) < min(MIN_QUOTE_CHARS, len(normalize_text(fragment.text))):
            return None
        return quote.strip()


class Resolver:
    def __init__(self, kb: KnowledgeService, reader: MaterialReader) -> None:
        self.kb = kb
        self.reader = reader

    def cite(self, token: CiteToken) -> CitePart | None:
        if self.reader.fragment(token.material_id, token.seg) is None:
            return None
        return CitePart(token.material_id, token.seg,
                        self.reader.checked_quote(token.material_id, token.seg, token.quote))

    def page(self, token: PageToken) -> PagePart | None:
        record = self.kb.page_repo.get(token.page_id)
        if record is None:
            return None
        block_id = token.block_id
        blocks = self.kb.page_repo.blocks(record.id) if block_id is not None else []
        if block_id is not None and all(block.block_id != block_id for block in blocks):
            block_id = None  # the page exists, the block does not: a chip to the page
        return PagePart(record.id, block_id, record.title, record.kind)

    def connection(self, payload: str) -> ConnectionPart | TextPart:
        """A checked connection, or its readable text when it does not have two real sides."""
        try:
            data = json.loads(payload)
        except ValueError:
            return TextPart(_fallback_text(None, payload))
        if not isinstance(data, dict):
            return TextPart(_fallback_text(None, payload))
        sides: list[ConnectionSide] = []
        folders = data.get("folders")
        raw_sides = folders if isinstance(folders, list) else []
        for item in raw_sides[:MAX_SIDES]:
            side = self._side(item)
            if side is not None:
                sides.append(side)
        inference = _clip(clean_text(strip_tokens(str(data.get("inference") or ""))), MAX_INFERENCE_CHARS)
        if len(sides) < 2:
            return TextPart(_fallback_text(data, payload))
        page_id = data.get("page_id")
        page = self.kb.page_repo.get(page_id) if isinstance(page_id, str) else None
        return ConnectionPart(tuple(sides), inference, page.id if page else None)

    def _side(self, item: Any) -> ConnectionSide | None:
        if not isinstance(item, dict) or not isinstance(item.get("cite"), str):
            return None
        token = parse_token("m:" + str(item["cite"]))
        if not isinstance(token, CiteToken):
            return None
        cite = self.cite(token)
        record = self.kb.material_repo.get(token.material_id) if cite is not None else None
        if cite is None or record is None:
            return None
        text = _clip(clean_text(strip_tokens(str(item.get("text") or ""))), MAX_SIDE_CHARS)
        quote = cite.quote or self.reader.checked_quote(token.material_id, token.seg, text)
        # The material's real folder, whatever folder id the agent named.
        return ConnectionSide(record.folder_id, text, cite.material_id, cite.seg, quote)

    # -- tool calls ---------------------------------------------------------------

    def tool(self, name: str, arguments: Mapping[str, Any]) -> ToolPart:
        short = tool_name(name)
        labeller = _TOOL_LABELS.get(short)
        label = labeller(self, arguments) if labeller is not None else f"Used {short}"
        return ToolPart(short, _clip(label, 160))

    def page_title(self, arguments: Mapping[str, Any]) -> str:
        page_id = arguments.get("page_id")
        record = self.kb.page_repo.get(page_id) if isinstance(page_id, str) else None
        if record is not None:
            return record.title
        title = arguments.get("title")
        return str(title) if isinstance(title, str) and title.strip() else "a wiki page"

    def material_title(self, arguments: Mapping[str, Any]) -> str:
        material_id = arguments.get("material_id")
        record = self.kb.material_repo.get(material_id) if isinstance(material_id, str) else None
        return record.title if record is not None else "a material"


def _clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _fallback_text(data: Mapping[str, Any] | None, payload: str) -> str:
    """A connection without two real sides is shown as plain text, without any ids."""
    if data is None:
        return ""
    lines: list[str] = []
    folders = data.get("folders")
    for item in folders if isinstance(folders, list) else []:
        if isinstance(item, dict) and item.get("text"):
            lines.append(clean_text(strip_tokens(str(item["text"]))))
    inference = data.get("inference")
    if inference:
        lines.append(clean_text(strip_tokens(str(inference))))
    lines = [_clip(line, MAX_SIDE_CHARS) for line in lines if line]
    return ("\n" + "\n\n".join(lines) + "\n") if lines else ""


def _search_label(_resolver: Resolver, arguments: Mapping[str, Any]) -> str:
    query = arguments.get("query")
    return f"Searched “{query}”" if isinstance(query, str) and query.strip() else "Searched the library"


def _recent_label(resolver: Resolver, arguments: Mapping[str, Any]) -> str:
    minutes = arguments.get("minutes")
    span = f"the last {minutes} min of " if isinstance(minutes, int) else "the latest part of "
    return f"Read {span}{resolver.material_title(arguments)}"


_TOOL_LABELS: dict[str, Callable[[Resolver, Mapping[str, Any]], str]] = {
    "skaz_wiki_index": lambda _r, _a: "Looked through the wiki index",
    "skaz_read_page": lambda r, a: f"Read page {r.page_title(a)}",
    "skaz_search": _search_label,
    "skaz_read_material": lambda r, a: f"Read {r.material_title(a)}",
    "skaz_list_materials": lambda _r, _a: "Listed materials",
    "skaz_list_folders": lambda _r, _a: "Listed folders",
    "skaz_recent_speech": _recent_label,
    "skaz_get_fragment": lambda r, a: f"Read a passage of {r.material_title(a)}",
}
