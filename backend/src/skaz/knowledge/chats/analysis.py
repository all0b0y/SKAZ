"""The "Save to wiki" action: an answer (or a whole chat) becomes an analysis page (decision 8).

Only the user's explicit action writes here; the agent never does. The page
keeps links to the primary sources the answer cited, but a statement becomes
``from_source`` only when the answer named the exact words and they are still
verbatim in the fragment (layer 4); everything else is an ``explanation``.
A connection is a ``connection`` block only with two such checked sides.
The answer keeps its Markdown shape (QA D1): a paragraph, a whole list, a
quote, a table or a fenced code block is one block, answer headings stay
headings one level below the question, and each citation link stays in the
sentence (list item, table row) it was given for.
A ```mermaid diagram (decision D-10) is always an agent ``explanation``: its
links to the cited passages stand under the fence. A diagram with none is left out — never
put in the wiki unsourced — and the rest is saved with a warning naming what was left out and
why (decision 9, 2026-10-21); an answer that is nothing but such diagrams is refused.
A name that is taken is refused (no date or "(2)" appended, FILESYSTEM-
LIBRARY-SPEC 14–15): the page is named after the question, else the chat.
Model text is made inert for the page format, and a page that reads like
instructions to an AI is not saved at all (layer 5). An analysis page is
never a source itself: its claims cite materials, never other pages.
"""
from __future__ import annotations

import re
import unicodedata
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Literal

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
_LIST_ITEM = re.compile(r"^\s*(?:[-*+]|\d{1,9}[.)])(?:\s+|$)")
_HEADING = re.compile(r"^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$")
_SETEXT = re.compile(r"^ {0,3}(=+|-+)[ \t]*$")
_THEMATIC = re.compile(r"^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$")
_FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})(.*)$")
_QUOTE = re.compile(r"^ {0,3}>")
_TABLE_DELIMITER = re.compile(r"^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$")
_TRAILING_BLOCK_ID = re.compile(r"\s+\^[A-Za-z0-9-]+$")
_SPACES = re.compile(r"[ \t\u00a0\u2000-\u200a\u3000]+")
#: Where a chip sat in the answer text (private-use characters, removed from model text first).
_SLOT_OPEN, _SLOT_CLOSE = "\ue000", "\ue001"
_SLOT = re.compile("\ue000(\\d+)\ue001")
INSTRUCTION_REFUSAL = ("This answer contains text that reads like instructions to an AI, "
                       "so SKAZ won't put it in the wiki.")
NOTHING_TO_SAVE = "There is nothing to save from this chat yet."
BAD_NAME = "SKAZ can't name a wiki page after this chat. Rename the chat, then save again."
ONLY_UNCITED_DIAGRAMS = ("Nothing was saved: the diagram has no quotes from your materials. "
                         "Ask the agent to cite the sources of the diagram, then save again.")


def uncited_diagrams_warning(count: int) -> str | None:
    """What the user is told when diagrams without material citations were left out of the page."""
    if count <= 0:
        return None
    if count == 1:
        return "Saved without 1 diagram: it has no quotes from your materials."
    return f"Saved without {count} diagrams: they have no quotes from your materials."

ChunkKind = Literal["heading", "paragraph", "list", "quote", "table", "code"]
Chip = CitePart | PagePart


class AnalysisRefused(KnowledgeError):
    status_code = 422


@dataclass
class Chunk:
    """One Markdown block of an answer; ``lines`` keep the chips' places as slots."""

    kind: ChunkKind
    lines: list[str] = field(default_factory=list)
    level: int = 0
    chips: list[Chip] = field(default_factory=list)

    def slots(self) -> list[int]:
        return [int(match.group(1)) for line in self.lines for match in _SLOT.finditer(line)]

    def bare(self) -> str:
        """The text without chips."""
        return "\n".join(_SLOT.sub("", line) for line in self.lines)

    def empty(self) -> bool:
        return not self.bare().strip() and not self.slots()


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


def _fence_closes(line: str, fence: str) -> bool:
    match = _FENCE.match(line)
    return bool(match and match.group(1)[0] == fence[0] and len(match.group(1)) >= len(fence)
                and not match.group(2).strip())


def _split(stream: str) -> list[Chunk]:
    """Top-level Markdown blocks of one stretch of answer text, as the chat renders them."""
    lines = stream.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    out: list[Chunk] = []
    current: Chunk | None = None
    after_blank = False

    def close() -> None:
        nonlocal current
        if current is not None and not current.empty():
            out.append(current)
        current = None

    index = 0
    while index < len(lines):
        line = lines[index]
        index += 1
        fence = _FENCE.match(line)
        if fence and not (fence.group(1)[0] == "`" and "`" in fence.group(2)):
            close()
            code = Chunk("code", [line])
            while index < len(lines):
                code.lines.append(lines[index])
                index += 1
                if _fence_closes(code.lines[-1], fence.group(1)):
                    break
            else:
                code.lines.append(fence.group(1))  # an unclosed fence ends with the answer
            out.append(code)
            after_blank = False
            continue
        if not line.strip():
            if current is not None and current.kind != "list":
                close()
            after_blank = True
            continue
        if not _SLOT.sub("", line).strip():  # only chips on this line: they follow the text before
            if current is not None and not after_blank:
                current.lines[-1] += line.strip()
            else:
                close()
                current = Chunk("paragraph", [line.strip()])
            after_blank = False
            continue
        if current is not None and current.kind == "paragraph" and _SETEXT.match(line):
            current.kind, current.level = "heading", 1 if line.strip().startswith("=") else 2
            close()
            continue
        heading = _HEADING.match(line)
        if heading:
            close()
            out.append(Chunk("heading", [heading.group(2) or ""], level=len(heading.group(1))))
            after_blank = False
            continue
        if _THEMATIC.match(line):
            close()
            after_blank = False
            continue
        if (current is None or after_blank) and index < len(lines) and "|" in line \
                and _TABLE_DELIMITER.match(lines[index]) and "-" in lines[index]:
            close()
            table = Chunk("table", [line, lines[index]])
            index += 1
            while index < len(lines) and lines[index].strip() and "|" in lines[index]:
                table.lines.append(lines[index])
                index += 1
            out.append(table)
            after_blank = False
            continue
        is_item = bool(_LIST_ITEM.match(line))
        indented = line[:1] in (" ", "\t")
        kind = current.kind if current is not None else None
        if (kind == "list" and (is_item or indented or not after_blank)) \
                or (kind == "quote" and not after_blank) \
                or (kind == "paragraph" and not after_blank and not is_item and not _QUOTE.match(line)):
            # List items, nested items and continuation lines (a loose list stays one block);
            # lazy quote lines; paragraph lines up to a list or quote that interrupts them.
            assert current is not None
            current.lines.append(line)
        else:
            close()
            current = Chunk("list" if is_item else "quote" if _QUOTE.match(line) else "paragraph", [line])
        after_blank = False
    close()
    return out


def _settle(chunks: list[Chunk]) -> list[Chunk]:
    """A chip at the start of a block (right after a break) belongs to the block before it;
    chips can't sit in a heading — they go to the block before (or after) it."""
    out: list[Chunk] = []
    carry = ""
    for chunk in chunks:
        if chunk.kind == "heading":
            moved = "".join(match.group(0) for match in _SLOT.finditer(chunk.lines[0]))
            chunk.lines[0] = _SLOT.sub("", chunk.lines[0])
            if moved and out and out[-1].kind != "heading":
                out[-1].lines[-1] += moved
            else:
                carry += moved
            if chunk.lines[0].strip():
                out.append(chunk)
            continue
        first = chunk.lines[0]
        lead = re.match(r"^(\s*(?:\ue000\d+\ue001\s*)+)", first) if chunk.kind != "code" else None
        if lead and out and out[-1].kind != "heading":
            moved = "".join(match.group(0) for match in _SLOT.finditer(lead.group(1)))
            out[-1].lines[-1] += moved
            chunk.lines[0] = first[lead.end():]
        if carry:
            chunk.lines[0] += carry
            carry = ""
        if not chunk.empty():
            out.append(chunk)
    if carry and out:
        out[-1].lines[-1] += carry
    return out


def paragraphs(parts: Sequence[Part]) -> list[Chunk | ConnectionPart]:
    """The answer in reading order: Markdown blocks with their chips in place, and connections."""
    out: list[Chunk | ConnectionPart] = []
    chips: list[Chip] = []
    stream: list[str] = []

    def flush() -> None:
        for chunk in _settle(_split("".join(stream))):
            chunk.chips = chips
            out.append(chunk)
        stream.clear()

    for part in parts:
        if isinstance(part, TextPart):
            stream.append(part.text.replace(_SLOT_OPEN, "").replace(_SLOT_CLOSE, ""))
        elif isinstance(part, CitePart | PagePart):
            stream.append(f"{_SLOT_OPEN}{len(chips)}{_SLOT_CLOSE}")
            chips.append(part)
        elif isinstance(part, ConnectionPart):
            flush()
            chips = []
            out.append(part)
    flush()
    return out


def _visible(text: str) -> str:
    value = unicodedata.normalize("NFC", text)
    return "".join(char for char in value if unicodedata.category(char) != "Cf")


def _inert(line: str, *, keep_indent: bool) -> str:
    """One answer line made inert for the page format, its Markdown kept: no wikilinks or
    Obsidian comments (``%%`` would forge a SKAZ marker), no block ids, single spaces."""
    value = _visible(line)
    for token, plain in (("%%", "%"), ("[[", "["), ("]]", "]")):
        while token in value:
            value = value.replace(token, plain)
    stripped = value.lstrip(" \t")
    indent = value[: len(value) - len(stripped)].replace("\t", "    ") if keep_indent else ""
    stripped = _SPACES.sub(" ", stripped).rstrip()
    while True:
        cut = _TRAILING_BLOCK_ID.sub("", stripped)
        if cut == stripped:
            break
        stripped = cut
    return indent + stripped


def _is_mermaid(chunk: Chunk) -> bool:
    fence = _FENCE.match(chunk.lines[0]) if chunk.kind == "code" and chunk.lines else None
    return bool(fence and fence.group(2).strip().lower() == "mermaid")


def _inert_mermaid(line: str) -> str | None:
    """A diagram line made inert for the page format and still valid Mermaid: a ``%%`` comment
    goes (a spaced "% %" breaks Mermaid's parser), a ``[[subroutine]]`` box becomes a plain box."""
    value = _visible(line).replace("\t", "    ").rstrip()
    if value.lstrip().startswith("%%"):
        return None
    for token, plain in (("[[", "["), ("]]", "]"), ("%%", "%")):
        while token in value:
            value = value.replace(token, plain)
    return value


def _inert_code(line: str) -> str:
    """A code line stays as written; only what the page format would read as its own syntax
    is broken apart (a marker line, a wikilink)."""
    value = _visible(line).replace("\t", "    ").rstrip()
    for token, spaced_out in (("%%", "% %"), ("[[", "[ ["), ("]]", "] ]")):
        while token in value:
            value = value.replace(token, spaced_out)
    return value


class AnalysisWriter:
    def __init__(self, kb: KnowledgeService, reader: MaterialReader, language: str) -> None:
        self.kb = kb
        self.reader = reader
        self.language = language
        self._sources: dict[str, SourceRef | None] = {}
        self.cited: dict[str, None] = {}
        #: Diagrams left out of the page because they cite no material passage (decision 9).
        self.left_out_diagrams = 0

    @property
    def warning(self) -> str | None:
        """What the saved page is missing, and why — ``None`` when nothing was left out."""
        return uncited_diagrams_warning(self.left_out_diagrams)

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

    def _chip_link(self, chip: Chip, cites: list[Cite]) -> str | None:
        if isinstance(chip, PagePart):
            return self._page_link(chip)
        checked = self._checked(chip.material_id, chip.seg, chip.quote)
        if checked is not None and checked not in cites:
            cites.append(checked)
        return self._link(chip.material_id, chip.seg)

    def _links(self, line: str, chunk: Chunk, cites: list[Cite], seen: set[str]) -> tuple[str, list[str]]:
        """``line`` without its chips, and the links of those chips (each link once per block)."""
        links: list[str] = []
        for match in _SLOT.finditer(line):
            link = self._chip_link(chunk.chips[int(match.group(1))], cites)
            if link is not None and link not in seen:
                seen.add(link)
                links.append(link)
        return _SLOT.sub("", line), links

    def _inline(self, line: str, chunk: Chunk, cites: list[Cite], seen: set[str]) -> str:
        """Each chip becomes its link right where it was: the citation stays with its sentence."""
        out: list[str] = []
        last = 0
        for match in _SLOT.finditer(line):
            out.append(line[last:match.start()])
            last = match.end()
            link = self._chip_link(chunk.chips[int(match.group(1))], cites)
            if link is None or link in seen:
                continue
            seen.add(link)
            before = "".join(out)
            out.append(link if not before or before[-1].isspace() else f" {link}")
        out.append(line[last:])
        return re.sub(r"(\]\]) (?=[.,;:!?)])", r"\1", "".join(out)).rstrip()

    def _chunk_block(self, chunk: Chunk) -> PagePiece | None:
        if chunk.kind == "heading":
            title = clean_title(chunk.lines[0])
            _refuse_instructions(title)
            # The question is the section (##); the answer's own headings sit below it.
            return Heading(min(6, chunk.level + 2), title) if title else None
        if not chunk.bare().strip():
            return None
        _refuse_instructions(" ".join(_visible(chunk.bare()).split()))
        cites: list[Cite] = []
        seen: set[str] = set()
        if chunk.kind == "code" and _is_mermaid(chunk):
            return self._diagram_block(chunk)
        if chunk.kind == "code":
            code: list[str] = []
            links: list[str] = []
            for line in chunk.lines:
                bare, found = self._links(line, chunk, cites, seen)
                code.append(_inert_code(bare))
                links.extend(found)
            # A fence line can hold nothing else: the chips follow the code, on their own line.
            body = "\n".join(code + ([" ".join(links)] if links else []))
        elif chunk.kind == "table":
            rows = [_inert(line, keep_indent=False) for line in chunk.lines]
            pending: list[str] = []
            for number, row in enumerate(rows):
                bare, found = self._links(row, chunk, cites, seen)
                bare = _SPACES.sub(" ", bare)
                pending.extend(found)
                if number >= 2 and pending:
                    # Past the last cell, where a link's "|" can't split the row's cells.
                    edge = bare.rstrip() if bare.rstrip().endswith("|") else f"{bare.rstrip()} |"
                    bare = f"{edge} {' '.join(pending)}"
                    pending = []
                rows[number] = bare.rstrip()
            body = "\n".join(rows)
        else:
            keep = chunk.kind == "list"
            lines = [_inert(line, keep_indent=keep) for line in chunk.lines]
            body = "\n".join(line for line in (self._inline(line, chunk, cites, seen) for line in lines)
                             if line.strip())
            if body.startswith(("#", "---", "===")):
                body = "\\" + body
        if not body.strip():
            return None
        kind: BlockKind = "from_source" if cites else "explanation"
        return Block.create(new_id("c"), kind, body, cites=tuple(cites))

    def _diagram_block(self, chunk: Chunk) -> Block | None:
        """A Mermaid diagram: the fence kept as Mermaid, the links to its cited passages under it.
        Only a link to a material fragment counts as a citation (a wiki page is not a passage);
        a diagram without one is left out and counted for the warning."""
        if not self._cites_a_passage(chunk):
            self.left_out_diagrams += 1
            return None
        code: list[str] = []
        links: list[str] = []
        seen: set[str] = set()
        last = len(chunk.lines) - 1
        for number, line in enumerate(chunk.lines):
            for match in _SLOT.finditer(line):
                link = self._chip_link(chunk.chips[int(match.group(1))], [])
                if link is not None and link not in seen:
                    seen.add(link)
                    links.append(link)
            bare = _SLOT.sub("", line)
            kept = _inert_code(bare) if number in (0, last) else _inert_mermaid(bare)
            if kept is not None:
                code.append(kept)
        return Block.create(new_id("c"), "explanation", "\n".join([*code, " ".join(links)]))

    def _cites_a_passage(self, chunk: Chunk) -> bool:
        """Whether a diagram's chips include a material fragment that still exists — checked before
        any link is made, so a left-out diagram adds nothing to the page's sources."""
        for slot in chunk.slots():
            chip = chunk.chips[slot]
            if isinstance(chip, CitePart) and self._source(chip.material_id) is not None \
                    and self.reader.fragment(chip.material_id, chip.seg) is not None:
                return True
        return False

    def _connection_block(self, part: ConnectionPart) -> Block | None:
        pieces: list[str] = []
        cites: list[Cite] = []
        for side in part.sides:
            folder = self.kb.folder_repo.get(side.folder_id)
            side_text = clean_text(side.text)
            _refuse_instructions(side_text)
            link = self._link(side.material_id, side.seg)
            label = f"{folder.name}: " if folder else ""
            pieces.append(" ".join(filter(None, [f"{label}{side_text}".strip(), link or ""])))
            checked = self._checked(side.material_id, side.seg, side.quote)
            if checked is not None and all(cite.material_id != checked.material_id or cite.seg != checked.seg
                                           for cite in cites):
                cites.append(checked)
        inference = clean_text(part.inference)
        _refuse_instructions(inference)
        page = self.kb.page_repo.get(part.page_id) if part.page_id else None
        page_link = PageRef(page.rel_path.removesuffix(".md"), page.title).link() if page else ""
        # The links are added after the text is made inert, so they stay links.
        sides = "; ".join(piece for piece in pieces if piece)
        body = " ".join(filter(None, [inference, "—" if inference and sides else "", sides, page_link]))
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
                         else self._chunk_block(item))
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
            raise AnalysisRefused(ONLY_UNCITED_DIAGRAMS if self.left_out_diagrams else NOTHING_TO_SAVE)
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
