"""The "Save to wiki" action: an answer (or a whole chat) becomes an analysis page (decision 8).

Only the user's explicit action writes here; the agent never does. The page
keeps links to the primary sources the answer cited, but a statement becomes
``from_source`` only when the answer named the exact words and they are still
verbatim in the fragment (layer 4); everything else is an ``explanation``.
A connection is a ``connection`` block only with two such checked sides.
A name that is taken is refused (no date or "(2)" appended, FILESYSTEM-
LIBRARY-SPEC 14–15): the page is named after the question, else the chat.
Model text is made inert for the page format, and a page that reads like
instructions to an AI is not saved at all (layer 5). An analysis page is
never a source itself: its claims cite materials, never other pages.
"""
from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass, field

from ..errors import KnowledgeError, NameRejected, NameTaken
from ..ids import new_id
from ..ingest.checks import clean_text, clean_title
from ..ingest.pages import PageRef, SourceRef, spaced
from ..markdown.page import Block, BlockKind, Cite, Heading, PageDocument, PageMeta
from ..markdown.page import Part as PagePiece
from ..service import KnowledgeService
from ..sources.guard.detector import detect_instruction
from ..store.records import PageRecord
from .model import CitePart, ConnectionPart, PagePart, Part, TextPart
from .resolve import MaterialReader

TITLE_CHARS = 80
DEFAULT_TITLE = "Analysis"
_FORBIDDEN = re.compile(r'[/\\:*?"<>|#^\[\]\x00-\x1f]')
_LIST_ITEM = re.compile(r"^\s*(?:[-*+]|\d{1,3}[.)])\s+")
_HEADING = re.compile(r"^\s*#{1,6}\s+")
_PARAGRAPH_BREAK = re.compile(r"\n[ \t]*\n")
INSTRUCTION_REFUSAL = ("This answer contains text that reads like instructions to an AI, "
                       "so SKAZ won't put it in the wiki.")
NOTHING_TO_SAVE = "There is nothing to save from this chat yet."
BAD_NAME = "SKAZ can't name a wiki page after this chat. Rename the chat, then save again."


class AnalysisRefused(KnowledgeError):
    status_code = 422


@dataclass
class _Paragraph:
    pieces: list[str] = field(default_factory=list)
    cites: list[CitePart] = field(default_factory=list)
    pages: list[PagePart] = field(default_factory=list)
    heading: bool = False

    def empty(self) -> bool:
        return not "".join(self.pieces).strip() and not self.cites and not self.pages


@dataclass(frozen=True)
class Section:
    """One question (heading) and the answer parts saved under it."""

    question: str
    parts: tuple[Part, ...]


def page_title(text: str) -> str:
    """A file-safe page title from a question or chat title (no characters names refuse)."""
    line = next((candidate for candidate in text.splitlines() if candidate.strip()), "")
    cleaned = " ".join(_FORBIDDEN.sub(" ", clean_title(line)).split()).lstrip(". ")
    if len(cleaned) > TITLE_CHARS:
        cut = cleaned[:TITLE_CHARS]
        space = cut.rfind(" ")
        cleaned = (cut[:space] if space > TITLE_CHARS // 2 else cut).rstrip(" ,.;")
    return cleaned or DEFAULT_TITLE


def paragraphs(parts: Sequence[Part]) -> list[_Paragraph | ConnectionPart]:
    """The answer in reading order: paragraphs with the chips that follow their text, and connections."""
    out: list[_Paragraph | ConnectionPart] = []
    current = _Paragraph()

    def close() -> None:
        nonlocal current
        if not current.empty():
            out.append(current)
        current = _Paragraph()

    def attach(part: CitePart | PagePart) -> None:
        target = current
        if not "".join(current.pieces).strip() and out and isinstance(out[-1], _Paragraph):
            target = out[-1]  # a chip right after a paragraph break belongs to the paragraph before
        if isinstance(part, CitePart):
            target.cites.append(part)
        else:
            target.pages.append(part)

    for part in parts:
        if isinstance(part, TextPart):
            for index, chunk in enumerate(_PARAGRAPH_BREAK.split(part.text)):
                if index:
                    close()
                for number, line in enumerate(chunk.split("\n")):
                    if _HEADING.match(line):
                        close()
                        current.heading = True
                        current.pieces.append(_HEADING.sub("", line))
                        close()
                        continue
                    if _LIST_ITEM.match(line) and "".join(current.pieces).strip():
                        close()
                    current.pieces.append(("\n" if number else "") + line)
        elif isinstance(part, CitePart | PagePart):
            attach(part)
        elif isinstance(part, ConnectionPart):
            close()
            out.append(part)
    close()
    return out


class AnalysisWriter:
    def __init__(self, kb: KnowledgeService, reader: MaterialReader, language: str) -> None:
        self.kb = kb
        self.reader = reader
        self.language = language
        self._sources: dict[str, SourceRef | None] = {}
        self.cited: dict[str, None] = {}

    # -- references -----------------------------------------------------------------

    def _source(self, material_id: str) -> SourceRef | None:
        if material_id not in self._sources:
            source = self.reader.source(material_id)
            self._sources[material_id] = None if source is None else SourceRef(
                material_id=material_id, folder_name=source.folder_name, title=source.title,
                file_stem=source.files.source_path.stem,
                start_ms={fragment.seg: fragment.start_ms for fragment in source.fragments},
                page={fragment.seg: fragment.page for fragment in source.fragments},
            )
        return self._sources[material_id]

    def _link(self, material_id: str, seg: int) -> str | None:
        source = self._source(material_id)
        if source is None or self.reader.fragment(material_id, seg) is None:
            return None
        self.cited.setdefault(material_id, None)
        return source.link(seg)

    def _checked(self, material_id: str, seg: int, quote: str | None) -> Cite | None:
        checked = self.reader.checked_quote(material_id, seg, quote)
        return Cite(material_id, seg, checked) if checked else None

    def _page_link(self, part: PagePart) -> str | None:
        record = self.kb.page_repo.get(part.page_id)
        return PageRef(record.rel_path.removesuffix(".md"), record.title).link() if record else None

    # -- blocks ------------------------------------------------------------------------

    def _paragraph_block(self, paragraph: _Paragraph) -> PagePiece | None:
        text = clean_text("".join(paragraph.pieces))
        if paragraph.heading:
            title = clean_title(text)
            return Heading(3, title) if title else None
        if not text:
            return None
        cites: list[Cite] = []
        links: list[str] = []
        for cite in paragraph.cites:
            link = self._link(cite.material_id, cite.seg)
            if link is not None and link not in links:
                links.append(link)
            checked = self._checked(cite.material_id, cite.seg, cite.quote)
            if checked is not None and checked not in cites:
                cites.append(checked)
        for page in paragraph.pages:
            link = self._page_link(page)
            if link is not None and link not in links:
                links.append(link)
        _refuse_instructions(text)
        kind: BlockKind = "from_source" if cites else "explanation"
        return Block.create(new_id("c"), kind, " ".join([text, *links]), cites=tuple(cites))

    def _connection_block(self, part: ConnectionPart) -> Block | None:
        pieces: list[str] = []
        cites: list[Cite] = []
        for side in part.sides:
            folder = self.kb.folder_repo.get(side.folder_id)
            side_text = clean_text(side.text)
            _refuse_instructions(side_text)
            link = self._link(side.material_id, side.seg)
            label = f"{folder.name}: " if folder else ""
            pieces.append(f"{label}{side_text}" + (f" {link}" if link else ""))
            checked = self._checked(side.material_id, side.seg, side.quote)
            if checked is not None and all(cite.material_id != checked.material_id or cite.seg != checked.seg
                                           for cite in cites):
                cites.append(checked)
        inference = clean_text(part.inference)
        _refuse_instructions(inference)
        page = self.kb.page_repo.get(part.page_id) if part.page_id else None
        page_link = PageRef(page.rel_path.removesuffix(".md"), page.title).link() if page else ""
        body = clean_text(" ".join(filter(None, [inference, "—" if inference else "", "; ".join(pieces)])))
        body = " ".join(filter(None, [body, page_link]))
        if not body:
            return None
        kind: BlockKind = "connection" if len(cites) >= 2 else "explanation"
        return Block.create(new_id("c"), kind, body, cites=tuple(cites) if kind == "connection" else ())

    def blocks(self, sections: Sequence[Section]) -> list[PagePiece]:
        out: list[PagePiece] = []
        for section in sections:
            body: list[PagePiece] = []
            for item in paragraphs(section.parts):
                built = (self._connection_block(item) if isinstance(item, ConnectionPart)
                         else self._paragraph_block(item))
                if built is not None:
                    body.append(built)
            if not any(isinstance(piece, Block) for piece in body):
                continue
            question = clean_title(section.question)
            if question:
                _refuse_instructions(question)
                out.append(Heading(2, question))
            out.extend(body)
        return out

    # -- the page ----------------------------------------------------------------------

    def save(self, titles: Sequence[str], sections: Sequence[Section], chat_id: str) -> PageRecord:
        parts = self.blocks(sections)
        if not any(isinstance(part, Block) for part in parts):
            raise AnalysisRefused(NOTHING_TO_SAVE)
        sources = tuple(self.cited)
        folders: dict[str, None] = {}
        for material_id in sources:
            material = self.kb.material_repo.get(material_id)
            if material is not None:
                folders.setdefault(material.folder_id, None)
        base = PageMeta(skaz_id=new_id("pg"), kind="analysis", title="", language=self.language,
                        folders=tuple(folders), sources=sources, extra={"skaz_chat": chat_id})
        candidates = _title_candidates(titles)
        taken: list[str] = []
        for title in candidates:
            _refuse_instructions(title)
            meta = PageMeta(skaz_id=base.skaz_id, kind="analysis", title=title, language=base.language,
                            folders=base.folders, sources=base.sources, extra=base.extra)
            try:
                self.kb.create_page(PageDocument(meta=meta, parts=spaced(parts)))
            except NameTaken:
                taken.append(title)
                continue
            except NameRejected:
                continue
            record = self.kb.page_repo.get(meta.skaz_id)
            if record is not None:
                return record
        if taken:
            raise NameTaken(name_taken(taken[0]))
        raise AnalysisRefused(BAD_NAME)


def name_taken(title: str) -> str:
    return f"A wiki page named “{title}” already exists. Rename the chat or that page, then save again."


def _title_candidates(titles: Sequence[str]) -> list[str]:
    """The page's natural names in order (the question, then the chat's name) — never a date or "(2)"."""
    out: list[str] = []
    for raw in titles:
        title = page_title(raw)
        if title not in out:
            out.append(title)
    return out


def _refuse_instructions(text: str) -> None:
    if text and detect_instruction(text) is not None:
        raise AnalysisRefused(INSTRUCTION_REFUSAL)
