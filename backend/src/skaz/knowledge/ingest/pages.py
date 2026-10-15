"""Building and merging wiki pages from checked statements (pure functions, no I/O).

Ownership rules (decisions 6, 22; B3):

* Blocks owned by the user (``user``/``user_edited``) and unmarked text are
  never changed, moved out of their section, or dropped; their raw bytes are
  re-emitted as parsed.
* On the Notes page every agent block is SKAZ's to rewrite (one material).
* On a Concept page only the agent blocks of *this* material are replaced;
  blocks of other materials stay where they are. A block's material is encoded
  in its id (``c-<material id without "mat-">-<hex>``), which survives an
  external edit of the marker's hash/owner.
"""
from __future__ import annotations

import re
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field, replace
from uuid import uuid4

from ..markdown.page import (
    Block,
    BlockKind,
    Cite,
    Heading,
    PageDocument,
    PageMeta,
    Part,
    RawText,
    citation_link,
    section_title,
)
from ..markdown.text import format_timestamp, name_key, normalize_text
from .checks import CheckedBlock

#: Navigation sections written by code (not model statements), labelled in the wiki language.
NAV_TITLES: dict[str, dict[str, str]] = {
    "en": {"folders": "In folders", "related": "Related", "concepts": "Concepts"},
    "ru": {"folders": "В папках", "related": "Связанные понятия", "concepts": "Понятия"},
}
NAV_FOLDERS_ID = "c-in-folders"
NAV_RELATED_ID = "c-related"
NAV_CONCEPTS_ID = "c-concepts"
_CONCEPT_ORDER: tuple[str, ...] = (
    "from_source", "connection", "explanation", "folders", "related", "user_note",
)
_LINK = re.compile(r"\[\[([^\]|\n]+)\|([^\]\n]+)\]\]")


def nav_title(key: str, language: str) -> str:
    return NAV_TITLES.get(language, NAV_TITLES["en"])[key]


def match_key(text: str) -> str:
    """Concept matching key: NFC, whitespace-collapsed, case-folded, ё = е."""
    return name_key(normalize_text(text)).replace("ё", "е")


# -- references ---------------------------------------------------------------


@dataclass(frozen=True)
class SourceRef:
    """What a citation link needs to know about the material."""

    material_id: str
    folder_name: str
    title: str
    file_stem: str
    start_ms: dict[int, int | None] = field(default_factory=dict)
    page: dict[int, int | None] = field(default_factory=dict)

    def label(self, seg: int) -> str:
        start = self.start_ms.get(seg)
        if start is not None:
            return format_timestamp(start)
        page = self.page.get(seg)
        if page is not None:
            return f"p. {page}"
        return f"¶ {seg}"

    def link(self, seg: int) -> str:
        stem = self.file_stem if self.file_stem != self.title else None
        return citation_link(self.folder_name, self.title, seg, self.label(seg), file_stem=stem)

    @property
    def block_prefix(self) -> str:
        return block_prefix(self.material_id)


@dataclass(frozen=True)
class PageRef:
    #: Wikilink target: library-relative path without ``.md``.
    target: str
    title: str
    page_id: str | None = None

    def link(self) -> str:
        return f"[[{self.target}|{self.title}]]"


def block_prefix(material_id: str) -> str:
    return f"c-{material_id.removeprefix('mat-')}-"


def new_block_id(material_id: str) -> str:
    return f"{block_prefix(material_id)}{uuid4().hex[:8]}"


def render_statement(block: CheckedBlock, source: SourceRef, links: Sequence[PageRef]) -> Block:
    """A SKAZ block: model text + citation/page links built by code from ids."""
    pieces = [block.text, *(source.link(seg) for seg in block.segs), *(ref.link() for ref in links)]
    cites = (tuple(Cite(source.material_id, seg, quote) for seg, quote in block.quotes)
             or tuple(Cite(source.material_id, seg) for seg in block.segs))
    return Block.create(new_block_id(source.material_id), block.kind, " ".join(pieces), cites=cites)


def page_links(body: str) -> list[PageRef]:
    return [PageRef(match.group(1), match.group(2)) for match in _LINK.finditer(body)]


# -- document helpers ---------------------------------------------------------


def _is_agent(part: Part) -> bool:
    return isinstance(part, Block) and part.owner == "agent" and part.hash_matches()


def _protect(part: Part) -> Part:
    """An agent block whose text no longer matches its hash was edited outside: it is the user's now."""
    if isinstance(part, Block) and part.owner == "agent" and not part.hash_matches():
        return part.remarked(owner="user_edited")
    return part


def _is_blank(part: Part) -> bool:
    return isinstance(part, RawText) and not part.text.strip()


def spaced(parts: Iterable[Part]) -> list[Part]:
    """Drop blank filler between parts and put exactly one blank line where a raw part needs it.

    New parts (``raw is None``) get their separator from ``render_page``; raw
    parts (user text, re-used headings/blocks) keep their bytes and get a blank
    line before them when the previous output does not already end with one.
    """
    result: list[Part] = []
    out = "---\n"
    for part in parts:
        if _is_blank(part):
            continue
        piece = part.render()
        is_new = getattr(part, "raw", "") is None
        if not is_new:
            ends_blank = out.endswith("\n\n") or (out.endswith("\n") and piece.startswith("\n"))
            if not ends_blank:
                filler = "\n" if out.endswith("\n") else "\n\n"
                result.append(RawText(filler))
                out += filler
        elif not out.endswith("\n\n"):
            out += "\n" if out.endswith("\n") else "\n\n"
        result.append(part)
        out += piece
    return result


@dataclass
class _Section:
    heading: Heading | None
    parts: list[Part]

    @property
    def title_key(self) -> str | None:
        return match_key(self.heading.title) if self.heading else None


def _sections(parts: Sequence[Part]) -> list[_Section]:
    sections = [_Section(None, [])]
    for part in parts:
        if isinstance(part, Heading):
            sections.append(_Section(part, []))
        else:
            sections[-1].parts.append(_protect(part))
    return sections


# -- Notes page ---------------------------------------------------------------


@dataclass(frozen=True)
class NoteSection:
    title: str
    blocks: tuple[Block, ...]


def build_note(existing: PageDocument | None, meta: PageMeta,
               sections: Sequence[NoteSection]) -> PageDocument:
    """The Notes page with fresh agent sections; the user's blocks and text keep their sections.

    A user part stays in the section whose title it was under: at the end of
    the new section of the same title, or — if that section is gone — in its
    old section (old heading kept) placed after the new section that follows
    the same earlier sections. Text before the first heading stays first.
    """
    old = _sections(existing.parts) if existing else [_Section(None, [])]
    new_sections = [section for section in sections if section.blocks]

    def kept(section: _Section) -> list[Part]:
        return [part for part in section.parts if not _is_agent(part) and not _is_blank(part)]

    new_keys = [match_key(section.title) for section in new_sections]
    matched: dict[int, int] = {}  # old section index → new section index
    used: set[int] = set()
    for old_index, section in enumerate(old):
        key = section.title_key
        if key is None:
            continue
        for new_index, candidate in enumerate(new_keys):
            if candidate == key and new_index not in used:
                matched[old_index] = new_index
                used.add(new_index)
                break

    # Unmatched old sections that still hold user parts, placed after the new
    # section matched by the nearest earlier old section (or at the top).
    orphans: dict[int, list[_Section]] = {}
    anchor = -1
    for old_index, section in enumerate(old):
        if old_index == 0:
            continue
        if old_index in matched:
            anchor = matched[old_index]
        elif kept(section):
            orphans.setdefault(anchor, []).append(section)

    parts: list[Part] = list(kept(old[0]))
    reused = {new_index: old[old_index].heading for old_index, new_index in matched.items()}
    old_by_new = {new_index: old[old_index] for old_index, new_index in matched.items()}

    def emit_orphans(position: int) -> None:
        for section in orphans.get(position, []):
            assert section.heading is not None
            parts.append(section.heading)
            parts.extend(kept(section))

    emit_orphans(-1)
    for index, new_section in enumerate(new_sections):
        parts.append(reused.get(index) or Heading(2, new_section.title))
        parts.extend(new_section.blocks)
        if index in old_by_new:
            parts.extend(kept(old_by_new[index]))
        emit_orphans(index)
    document_meta = meta if existing is None else _merge_meta(existing.meta, meta, replace_sources=True)
    if existing is None:
        return PageDocument(meta=document_meta, parts=spaced(parts))
    return replace(existing, meta=document_meta, parts=spaced(parts))


def _merge_meta(old: PageMeta, new: PageMeta, *, replace_sources: bool) -> PageMeta:
    sources = new.sources if replace_sources else tuple(dict.fromkeys((*old.sources, *new.sources)))
    folders = tuple(dict.fromkeys((*old.folders, *new.folders))) if not replace_sources else new.folders
    language = new.language if replace_sources else old.language or new.language
    return replace(old, kind=new.kind, title=old.title or new.title, sources=sources, folders=folders,
                   language=language)


# -- Concept pages ------------------------------------------------------------


def _label(key: str, language: str) -> str:
    if key in ("from_source", "connection", "explanation", "user_note"):
        kind: BlockKind = key  # type: ignore[assignment]
        return section_title(kind, language)
    return nav_title(key, language)


def _find_heading(parts: Sequence[Part], title: str) -> int | None:
    key = match_key(title)
    for index, part in enumerate(parts):
        if isinstance(part, Heading) and part.level <= 2 and match_key(part.title) == key:
            return index
    return None


def _section_end(parts: Sequence[Part], heading_index: int) -> int:
    heading = parts[heading_index]
    assert isinstance(heading, Heading)
    for index in range(heading_index + 1, len(parts)):
        part = parts[index]
        if isinstance(part, Heading) and part.level <= heading.level:
            return index
    return len(parts)


def insert_into_section(parts: list[Part], key: str, language: str, new: Sequence[Part]) -> None:
    """Append ``new`` at the end of the labelled section, creating it in canonical order if absent."""
    if not new:
        return
    title = _label(key, language)
    index = _find_heading(parts, title)
    if index is not None:
        end = _section_end(parts, index)
        parts[end:end] = list(new)
        return
    later = [_label(other, language) for other in _CONCEPT_ORDER[_CONCEPT_ORDER.index(key) + 1:]]
    positions = [found for found in (_find_heading(parts, other) for other in later) if found is not None]
    at = min(positions) if positions else len(parts)
    parts[at:at] = [Heading(2, title), *new]


def _set_nav(parts: list[Part], block_id: str, key: str, language: str, body: str | None,
             kind: BlockKind = "connection") -> None:
    """Replace (or add/remove) one code-written navigation block; a user-owned one is left alone."""
    index = next((i for i, part in enumerate(parts) if isinstance(part, Block) and part.id == block_id), None)
    if index is not None:
        current = parts[index]
        assert isinstance(current, Block)
        if not _is_agent(current):
            return
        if body is None:
            del parts[index]
        elif current.body != body:
            parts[index] = Block.create(block_id, kind, body)
        return
    if body is not None:
        insert_into_section(parts, key, language, [Block.create(block_id, kind, body)])


#: Public for area W2 (folder moves refresh "In folders" the same way ingest does).
set_nav = _set_nav


@dataclass
class ConceptUpdate:
    """What this material contributes to one concept page."""

    material_id: str
    blocks: list[Block]
    aliases: list[str]
    related: list[PageRef]


def strip_material(document: PageDocument, material_id: str) -> tuple[PageDocument, int]:
    """Remove this material's agent blocks (re-ingest); returns the document and how many went."""
    prefix = block_prefix(material_id)
    parts: list[Part] = []
    removed = 0
    for part in document.parts:
        if _is_agent(part) and isinstance(part, Block) and part.id.startswith(prefix):
            removed += 1
            continue
        parts.append(_protect(part))
    return replace(document, parts=parts), removed


def cites_material(document: PageDocument, material_id: str) -> bool:
    return any(cite.material_id == material_id for block in document.blocks() for cite in block.cites)


def merge_concept(document: PageDocument, update: ConceptUpdate | None, *, material_id: str,
                  folders_of: Callable[[Sequence[str]], tuple[str, ...]],
                  folders_body: Callable[[PageMeta], str | None]) -> PageDocument:
    """Drop this material's previous agent blocks, add the new ones, refresh meta and navigation.

    ``folders`` of a concept page are derived from its sources (where the
    concept occurs, decision 10); ``aliases`` only grow.
    """
    document, _removed = strip_material(document, material_id)
    meta = document.meta
    language = meta.language or "en"
    parts = list(document.parts)
    sources = tuple(source for source in meta.sources if source != material_id)
    if update is not None:
        for kind in ("from_source", "connection", "explanation"):
            added = [block for block in update.blocks if block.kind == kind]
            insert_into_section(parts, kind, language, added)
        alias_keys = {match_key(alias) for alias in meta.aliases} | {match_key(meta.title)}
        aliases = list(meta.aliases)
        for alias in update.aliases:
            if alias and match_key(alias) not in alias_keys:
                alias_keys.add(match_key(alias))
                aliases.append(alias)
        meta = replace(meta, aliases=tuple(aliases))
        sources = tuple(dict.fromkeys((*meta.sources, material_id)))
    elif cites_material(replace(document, parts=parts), material_id):
        sources = meta.sources  # the user's own blocks still cite it
    meta = replace(meta, sources=sources, folders=folders_of(sources))

    current = next((part for part in parts if isinstance(part, Block) and part.id == NAV_RELATED_ID), None)
    related = page_links(current.body) if isinstance(current, Block) else []
    for ref in update.related if update else []:
        if ref.target not in {item.target for item in related}:
            related.append(ref)
    _set_nav(parts, NAV_FOLDERS_ID, "folders", language, folders_body(meta))
    _set_nav(parts, NAV_RELATED_ID, "related", language,
             ", ".join(ref.link() for ref in related) if related else None)
    return replace(document, meta=meta, parts=spaced(parts))


def new_concept(meta: PageMeta) -> PageDocument:
    return PageDocument(meta=meta, parts=[])


def set_note_concepts(document: PageDocument, refs: Sequence[PageRef]) -> PageDocument:
    """The Notes page links the concept pages of its material (decision 11)."""
    parts = list(document.parts)
    language = document.meta.language or "en"
    body = ", ".join(ref.link() for ref in refs) if refs else None
    index = next((i for i, part in enumerate(parts)
                  if isinstance(part, Block) and part.id == NAV_CONCEPTS_ID), None)
    if index is not None:
        _set_nav(parts, NAV_CONCEPTS_ID, "concepts", language, body)
    elif body is not None:
        title = nav_title("concepts", language)
        at = _find_heading(parts, title)
        block = Block.create(NAV_CONCEPTS_ID, "connection", body)
        if at is None:
            parts.extend([Heading(2, title), block])
        else:
            end = _section_end(parts, at)
            parts[end:end] = [block]
    return replace(document, parts=spaced(parts))


def description(text: str, limit: int = 120) -> str:
    """One line for ``index.md``: the statement without its trailing links."""
    head = text.split(" [[", 1)[0].strip()
    head = normalize_text(head)
    return head if len(head) <= limit else head[: limit - 1].rstrip() + "…"
