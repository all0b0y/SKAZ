"""Statements of wiki pages as the W2 agents see them, and citations re-checked against the sources.

A statement given to an agent is numbered; the agent answers with numbers,
and SKAZ copies the *checked* citations of those statements into anything new
it writes — the agent never types a material id, a fragment number or a
quote of its own. Quotes are checked again against the current text (applied
recognition corrections included) before they are written.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass

from ..corrections.store import CorrectionStore
from ..errors import KnowledgeError
from ..ingest.pages import SourceRef
from ..markdown.page import Cite
from ..markdown.text import normalize_text, quote_in_fragment
from ..service import KnowledgeService
from ..store.records import CitationRecord
from .move import source_ref

_LINK = re.compile(r"[ \t]?\[\[[^\]\n]*\]\]")
MAX_STATEMENT_CHARS = 600


def statement_text(body: str) -> str:
    """The statement without its links (they are presentation added by SKAZ)."""
    return normalize_text(_LINK.sub("", body))


@dataclass(frozen=True)
class Statement:
    page_id: str
    block_id: str
    kind: str
    owner: str
    text: str
    cites: tuple[CitationRecord, ...]
    material_title: str
    folder_name: str

    @property
    def material_id(self) -> str | None:
        return self.cites[0].material_id if self.cites else None

    def line(self, number: int | str) -> str:
        source = f" (source: {self.material_title}" + (
            f", folder {self.folder_name})" if self.folder_name else ")"
        )
        return f"[{number}]{source} {self.text[:MAX_STATEMENT_CHARS]}"


def page_statements(
    kb: KnowledgeService, page_id: str, *, kinds: Iterable[str] = ("from_source",), limit: int | None = None
) -> list[Statement]:
    """Cited statements of a page in page order (the user's edited ones included: they are statements too)."""
    wanted = set(kinds)
    result = []
    for block in kb.page_repo.blocks(page_id):
        if not block.marked or block.kind not in wanted or not block.citations:
            continue
        material = kb.material_repo.get(block.citations[0].material_id)
        folder = kb.folder_repo.get(material.folder_id) if material else None
        result.append(
            Statement(
                page_id,
                block.block_id,
                block.kind,
                block.owner,
                statement_text(block.text),
                block.citations,
                material.title if material else "a deleted material",
                folder.name if folder else "",
            )
        )
        if limit is not None and len(result) >= limit:
            break
    return result


class Citations:
    """Checked citations and their links for new blocks."""

    def __init__(self, kb: KnowledgeService, store: CorrectionStore) -> None:
        self.kb = kb
        self.store = store
        self._refs: dict[str, SourceRef | None] = {}

    def fragment_text(self, material_id: str, seg: int) -> str | None:
        found = self.kb.material_repo.fragment_map({(material_id, seg)}).get((material_id, seg))
        if found is None:
            return None
        return self.store.corrected_text(material_id, seg, found[0].text)

    def verified(self, cites: Iterable[CitationRecord]) -> tuple[Cite, ...]:
        """The citations whose fragment still exists and still holds the quote verbatim (de-duplicated)."""
        kept: dict[tuple[str, int, str | None], Cite] = {}
        for cite in cites:
            text = self.fragment_text(cite.material_id, cite.seg)
            if text is None or (cite.quote and not quote_in_fragment(cite.quote, text)):
                continue
            kept.setdefault(
                (cite.material_id, cite.seg, cite.quote), Cite(cite.material_id, cite.seg, cite.quote)
            )
        return tuple(kept.values())

    def ref(self, material_id: str) -> SourceRef | None:
        if material_id not in self._refs:
            record = self.kb.material_repo.get(material_id)
            ref = None
            if record is not None:
                library = self.kb.require()
                try:
                    ref = source_ref(library, library.read_material(material_id, hint=record.rel_dir))
                except (KnowledgeError, OSError, ValueError):
                    ref = None  # no link rather than a wrong one; the marker still cites by id
            self._refs[material_id] = ref
        return self._refs[material_id]

    def links(self, cites: Sequence[Cite]) -> list[str]:
        seen: set[tuple[str, int]] = set()
        links = []
        for cite in cites:
            if (cite.material_id, cite.seg) in seen:
                continue
            seen.add((cite.material_id, cite.seg))
            ref = self.ref(cite.material_id)
            if ref is not None:
                links.append(ref.link(cite.seg))
        return links
