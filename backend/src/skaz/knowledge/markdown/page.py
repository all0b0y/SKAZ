"""Wiki page format: frontmatter + sections + marked blocks, lossless round-trip.

A SKAZ block is::

    %% skaz:block id=c-<id> kind=<kind> owner=<owner> hash=<sha256-12> cites=mat-x:seg-12~<quote>,… %%
    Paragraph or list item text [[Materials/<Folder>/<Title>/<Title>#^seg-12|<Title> · 08:12]] ^c-<id>

The marker (``cites`` by id) is the machine truth; the wikilink is only a
presentation. Anything that is not a well-formed block — text the user typed
in SKAZ or Obsidian, headings, blank lines, a marker that lost its block id —
is kept verbatim. Parsing then rendering an untouched document returns the
same string byte for byte; only parts that were replaced are re-rendered.
"""
from __future__ import annotations

import base64
import re
from collections.abc import Mapping
from dataclasses import dataclass, field, replace
from typing import Any, Literal, get_args

from .frontmatter import FrontmatterError, render_frontmatter, split_frontmatter
from .text import block_hash

PageKind = Literal["concept", "note", "folder", "analysis"]
BlockKind = Literal["from_source", "connection", "explanation", "user_note"]
Owner = Literal["agent", "user", "user_edited"]
PAGE_KINDS: tuple[PageKind, ...] = get_args(PageKind)
BLOCK_KINDS: tuple[BlockKind, ...] = get_args(BlockKind)
OWNERS: tuple[Owner, ...] = get_args(Owner)

#: Section labels are written in the wiki language; English is the fallback.
SECTION_TITLES: dict[str, dict[BlockKind, str]] = {
    "en": {
        "from_source": "From sources",
        "connection": "Connections (agent inference)",
        "explanation": "Agent explanation",
        "user_note": "My notes",
    },
    "ru": {
        "from_source": "Из источников",
        "connection": "Связи (вывод агента)",
        "explanation": "Пояснение агента",
        "user_note": "Мои заметки",
    },
}

_MARKER = re.compile(r"%% skaz:block (.+?) %%")
_HEADING = re.compile(r"(#{1,6})[ \t]+(.*?)[ \t#]*")
_BLOCK_ID = re.compile(r"c-[A-Za-z0-9-]+")
#: ``mat-x:seg-12`` or, with the exact quote the claim rests on, ``mat-x:seg-12~<base64url(utf-8)>``.
_CITE = re.compile(r"(mat-[A-Za-z0-9-]+):seg-([1-9]\d*)(?:~([A-Za-z0-9_-]+))?")
_BLANK_SPLIT = re.compile(r"\n[ \t]*\n")
_LABELLED_LINK = re.compile(r"\[\[[^\]|\n]+\|([^\]\n]+)\]\]")
_BARE_LINK = re.compile(r"\[\[([^\]|\n]+)\]\]")


def plain_text(body: str) -> str:
    """Block text for search/snippets: wikilinks reduced to what the reader sees."""
    text = _LABELLED_LINK.sub(r"\1", body)
    return _BARE_LINK.sub(lambda match: match.group(1).split("#")[0].rsplit("/", 1)[-1], text)


class PageFormatError(ValueError):
    """Not a SKAZ page (no frontmatter, no id, unknown kind). The file is left alone."""


def section_title(kind: BlockKind, language: str) -> str:
    return SECTION_TITLES.get(language, SECTION_TITLES["en"])[kind]


def citation_link(folder: str, title: str, seg: int, label: str, *, file_stem: str | None = None) -> str:
    """Human-readable wikilink to a source fragment; ``label`` is e.g. ``08:12`` or ``p. 3``.

    ``file_stem`` is the source file name when it differs from the directory
    (a material folder renamed in Finder keeps its old ``<Title>.md``).
    """
    return f"[[Materials/{folder}/{title}/{file_stem or title}#^seg-{seg}|{title} · {label}]]"


@dataclass(frozen=True)
class Cite:
    material_id: str
    seg: int
    #: The verbatim quote in the fragment that was checked (layer 4); ``None`` for older/hand-made
    #: markers — then the whole fragment is the reference.
    quote: str | None = None

    @property
    def token(self) -> str:
        base = f"{self.material_id}:seg-{self.seg}"
        if not self.quote:
            return base
        encoded = base64.urlsafe_b64encode(self.quote.encode("utf-8")).decode("ascii").rstrip("=")
        return f"{base}~{encoded}"


def _decode_quote(encoded: str | None) -> str | None:
    if not encoded:
        return None
    try:
        quote = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)).decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        return None  # a damaged quote keeps the citation; it just points at the whole fragment
    return quote or None


@dataclass(frozen=True)
class Block:
    id: str
    kind: BlockKind
    owner: Owner
    hash: str
    cites: tuple[Cite, ...]
    #: Block text without the marker line and without the trailing `` ^c-id``.
    body: str
    #: Exact source text when parsed; ``None`` renders canonically.
    raw: str | None = None

    @classmethod
    def create(cls, block_id: str, kind: BlockKind, body: str, *,
               cites: tuple[Cite, ...] = (), owner: Owner = "agent") -> Block:
        if not _BLOCK_ID.fullmatch(block_id):
            raise ValueError("Block ids look like c-<id>.")
        if not body.strip() or _BLANK_SPLIT.search(body.replace("\r\n", "\n")):
            raise ValueError("A block is one non-empty paragraph or list item.")
        return cls(id=block_id, kind=kind, owner=owner, hash=block_hash(body), cites=cites, body=body)

    def hash_matches(self) -> bool:
        return self.hash == block_hash(self.body)

    def marker_line(self) -> str:
        parts = [f"id={self.id}", f"kind={self.kind}", f"owner={self.owner}", f"hash={self.hash}"]
        if self.cites:
            parts.append("cites=" + ",".join(cite.token for cite in self.cites))
        return "%% skaz:block " + " ".join(parts) + " %%"

    def render(self) -> str:
        if self.raw is not None:
            return self.raw
        return f"{self.marker_line()}\n{self.body} ^{self.id}\n"

    def remarked(self, *, owner: Owner | None = None) -> Block:
        """Same text, fresh hash (and optionally new owner); only the marker line changes."""
        updated = replace(self, owner=owner or self.owner, hash=block_hash(self.body), raw=None)
        if self.raw is None:
            return updated
        first, newline, rest = self.raw.partition("\n")
        ending = "\r" if first.endswith("\r") else ""
        return replace(updated, raw=updated.marker_line() + ending + newline + rest)


@dataclass(frozen=True)
class Heading:
    level: int
    title: str
    raw: str | None = None

    def render(self) -> str:
        return self.raw if self.raw is not None else f"{'#' * self.level} {self.title}\n"


@dataclass(frozen=True)
class RawText:
    """Verbatim text that is not a SKAZ block: the user's own words, blank lines."""

    text: str

    def render(self) -> str:
        return self.text


Part = Block | Heading | RawText


@dataclass(frozen=True)
class UserParagraph:
    """A paragraph of unmarked text; counted as a ``user_note`` owned by the user."""

    ordinal: int
    section: str | None
    text: str

    @property
    def id(self) -> str:
        return f"u-{self.ordinal}"


@dataclass(frozen=True)
class PageMeta:
    skaz_id: str
    kind: PageKind
    title: str = ""
    original: str | None = None
    aliases: tuple[str, ...] = ()
    folders: tuple[str, ...] = ()
    language: str = ""
    sources: tuple[str, ...] = ()
    extra: Mapping[str, Any] = field(default_factory=dict)

    def fields(self) -> dict[str, Any]:
        return {
            "skaz_id": self.skaz_id, "kind": self.kind, "title": self.title,
            "original": self.original, "aliases": list(self.aliases), "folders": list(self.folders),
            "language": self.language, "sources": list(self.sources), **dict(self.extra),
        }


@dataclass(frozen=True)
class PageEntry:
    section: str | None
    item: Block | UserParagraph


@dataclass
class PageDocument:
    meta: PageMeta
    parts: list[Part]
    frontmatter_raw: str | None = None
    parsed_meta: PageMeta | None = None

    def blocks(self) -> list[Block]:
        return [part for part in self.parts if isinstance(part, Block)]

    def block(self, block_id: str) -> Block | None:
        return next((block for block in self.blocks() if block.id == block_id), None)

    def with_block(self, block: Block) -> PageDocument:
        parts = [block if isinstance(part, Block) and part.id == block.id else part for part in self.parts]
        return replace(self, parts=parts)

    def entries(self) -> list[PageEntry]:
        """Blocks and unmarked paragraphs in document order, each with its section heading."""
        section: str | None = None
        ordinal = 0
        result: list[PageEntry] = []
        for part in self.parts:
            if isinstance(part, Heading):
                section = part.title
            elif isinstance(part, Block):
                result.append(PageEntry(section, part))
            else:
                for paragraph in _BLANK_SPLIT.split(part.text.replace("\r\n", "\n")):
                    text = paragraph.strip("\n")
                    if text.strip():
                        ordinal += 1
                        result.append(PageEntry(section, UserParagraph(ordinal, section, text)))
        return result

    def user_paragraphs(self) -> list[UserParagraph]:
        return [entry.item for entry in self.entries() if isinstance(entry.item, UserParagraph)]


def _meta(fields: dict[str, Any]) -> PageMeta:
    skaz_id = fields.get("skaz_id")
    kind = fields.get("kind")
    if not isinstance(skaz_id, str) or not skaz_id.strip():
        raise PageFormatError("A SKAZ page needs skaz_id in its frontmatter.")
    if kind not in PAGE_KINDS:
        raise PageFormatError("Unknown page kind.")

    def strings(name: str) -> tuple[str, ...]:
        value = fields.get(name)
        if value is None:
            return ()
        if isinstance(value, list):
            return tuple(str(item) for item in value if item is not None)
        return (str(value),)

    def text(name: str) -> str | None:
        value = fields.get(name)
        return None if value is None else str(value)

    known = {"skaz_id", "kind", "title", "original", "aliases", "folders", "language", "sources"}
    return PageMeta(
        skaz_id=skaz_id, kind=kind, title=text("title") or "", original=text("original"),
        aliases=strings("aliases"), folders=strings("folders"), language=text("language") or "",
        sources=strings("sources"), extra={key: value for key, value in fields.items() if key not in known},
    )


def _marker(content: str) -> tuple[str, BlockKind, Owner, str, tuple[Cite, ...]] | None:
    match = _MARKER.fullmatch(content)
    if match is None:
        return None
    attrs: dict[str, str] = {}
    for token in match.group(1).split():
        key, sep, value = token.partition("=")
        if not sep or key in attrs:
            return None
        attrs[key] = value
    block_id, kind, owner, digest = (attrs.get(name, "") for name in ("id", "kind", "owner", "hash"))
    if not _BLOCK_ID.fullmatch(block_id) or kind not in BLOCK_KINDS or owner not in OWNERS or not digest:
        return None
    cites: list[Cite] = []
    for token in filter(None, attrs.get("cites", "").split(",")):
        cite = _CITE.fullmatch(token)
        if cite is None:
            return None
        cites.append(Cite(cite.group(1), int(cite.group(2)), _decode_quote(cite.group(3))))
    return block_id, kind, owner, digest, tuple(cites)


def parse_page(text: str) -> PageDocument:
    try:
        frontmatter_raw, fields, body = split_frontmatter(text)
    except FrontmatterError as error:
        raise PageFormatError(str(error)) from error
    meta = _meta(fields)
    lines = body.splitlines(keepends=True)
    parts: list[Part] = []
    pending: list[str] = []

    def flush() -> None:
        if pending:
            parts.append(RawText("".join(pending)))
            pending.clear()

    index = 0
    while index < len(lines):
        line = lines[index]
        content = line.rstrip("\r\n")
        marker = _marker(content)
        if marker is not None:
            block_id = marker[0]
            collected: list[str] = []
            closed = False
            cursor = index + 1
            while cursor < len(lines):
                candidate = lines[cursor].rstrip("\r\n")
                if not candidate.strip() or _MARKER.fullmatch(candidate):
                    break
                collected.append(lines[cursor])
                cursor += 1
                if candidate.endswith(f" ^{block_id}"):
                    closed = True
                    break
            if closed:
                flush()
                last = collected[-1].rstrip("\r\n")
                body_text = "".join(collected[:-1]) + last[: -len(f" ^{block_id}")]
                parts.append(Block(
                    id=block_id, kind=marker[1], owner=marker[2], hash=marker[3], cites=marker[4],
                    body=body_text, raw=line + "".join(collected),
                ))
                index = cursor
                continue
        heading = _HEADING.fullmatch(content)
        if heading is not None:
            flush()
            parts.append(Heading(len(heading.group(1)), heading.group(2), raw=line))
        else:
            pending.append(line)
        index += 1
    flush()
    return PageDocument(meta=meta, parts=parts, frontmatter_raw=frontmatter_raw, parsed_meta=meta)


def render_page(document: PageDocument) -> str:
    if document.frontmatter_raw is not None and document.meta == document.parsed_meta:
        out = document.frontmatter_raw
    else:
        out = render_frontmatter(document.meta.fields())
    for part in document.parts:
        piece = part.render()
        if getattr(part, "raw", "") is None and not out.endswith("\n\n"):
            # A newly created part is separated by a blank line; parsed parts keep their spacing.
            out += "\n" if out.endswith("\n") else "\n\n"
        out += piece
    return out
