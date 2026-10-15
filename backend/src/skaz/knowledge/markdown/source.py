"""Source format: ``<Title>.md`` (one paragraph per fragment) + ``.skaz/material.json``.

Every fragment is a Markdown paragraph that ends with the Obsidian block id
``^seg-<n>``. ``n`` is a stable per-material ordinal: appending (a live
recording growing) never renumbers existing fragments. Speech fragments open
with ``**Speaker N** · mm:ss`` on their own line; the timing itself lives in
``material.json`` so the Markdown is never parsed for metadata.
"""
from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal, Protocol

from pydantic import BaseModel, ConfigDict, Field, SerializerFunctionWrapHandler, model_serializer

from .frontmatter import FrontmatterError, render_frontmatter, split_frontmatter
from .text import format_timestamp

MaterialKind = Literal["recording", "audio", "video", "video_link", "pdf", "book", "web", "text"]
MaterialStatus = Literal["recording", "processing", "ready", "failed"]
#: How a fragment is shown (user bug 1016-5): set by the extractors, never changes the text.
FragmentRole = Literal["paragraph", "heading", "list_item", "quote", "code"]
FRAGMENT_ROLES: tuple[FragmentRole, ...] = ("paragraph", "heading", "list_item", "quote", "code")
MATERIAL_KINDS: tuple[MaterialKind, ...] = (
    "recording", "audio", "video", "video_link", "pdf", "book", "web", "text",
)
MANIFEST_VERSION = 1

_SEG_SUFFIX = re.compile(r"[ \t]\^seg-(\d+)$")
_PARAGRAPH_BREAK = re.compile(r"\n[ \t]*\n")


class SourceFormatError(ValueError):
    pass


@dataclass(frozen=True)
class FragmentInput:
    """A fragment before it has an id: what extractors and recorders hand over."""

    text: str
    start_ms: int | None = None
    end_ms: int | None = None
    speaker: str | None = None
    page: int | None = None
    index: int | None = None
    role: FragmentRole = "paragraph"
    #: Heading level 1–6 (``role == "heading"`` only).
    level: int | None = None


@dataclass(frozen=True)
class Fragment:
    seg: int
    text: str
    start_ms: int | None = None
    end_ms: int | None = None
    speaker: str | None = None
    page: int | None = None
    index: int | None = None
    role: FragmentRole = "paragraph"
    level: int | None = None

    @property
    def block_id(self) -> str:
        return f"seg-{self.seg}"


class FragmentPlacement(Protocol):
    """What the reader needs from the fragment table to read paragraphs back."""

    @property
    def seg(self) -> int: ...
    @property
    def start_ms(self) -> int | None: ...
    @property
    def end_ms(self) -> int | None: ...
    @property
    def speaker(self) -> str | None: ...
    @property
    def page(self) -> int | None: ...
    @property
    def index(self) -> int | None: ...
    @property
    def role(self) -> FragmentRole | None: ...
    @property
    def level(self) -> int | None: ...


class Origin(BaseModel):
    """Where a material came from. Extractors may add their own fields."""

    model_config = ConfigDict(extra="allow")
    type: Literal["recording", "file", "url", "paste"]
    url: str | None = None
    file_name: str | None = None


class FragmentMeta(BaseModel):
    model_config = ConfigDict(extra="allow")
    id: str = Field(pattern=r"^seg-[1-9]\d*$")
    start_ms: int | None = Field(default=None, ge=0)
    end_ms: int | None = Field(default=None, ge=0)
    speaker: str | None = None
    page: int | None = Field(default=None, ge=1)
    index: int | None = Field(default=None, ge=0)
    #: Absent (manifests before roles, speech, plain text): a paragraph.
    role: FragmentRole | None = None
    level: int | None = Field(default=None, ge=1, le=6)

    @property
    def seg(self) -> int:
        return int(self.id.removeprefix("seg-"))

    @model_serializer(mode="wrap")
    def _without_paragraph_role(self, handler: SerializerFunctionWrapHandler) -> dict[str, object]:
        """A paragraph's manifest entry stays as it was before roles (no ``role``/``level`` keys)."""
        data: dict[str, object] = handler(self)
        for key in ("role", "level"):
            if data.get(key) is None:
                data.pop(key, None)
        return data

    @classmethod
    def of(cls, fragment: Fragment) -> FragmentMeta:
        meta = cls(id=fragment.block_id, start_ms=fragment.start_ms, end_ms=fragment.end_ms,
                   speaker=fragment.speaker, page=fragment.page, index=fragment.index)
        if fragment.role != "paragraph":  # a paragraph adds nothing to the manifest
            meta.role = fragment.role
            meta.level = fragment.level if fragment.role == "heading" else None
        return meta


class MaterialManifest(BaseModel):
    """``.skaz/material.json``: identity, metadata and the fragment table.

    The folder a material belongs to is where its directory physically lies;
    ``folder`` records the last known folder id and is refreshed on writes.
    The title shown is the directory name (a Finder rename is accepted).
    """

    model_config = ConfigDict(extra="allow")
    format: Literal[1] = 1
    id: str = Field(pattern=r"^mat-[A-Za-z0-9-]+$")
    kind: MaterialKind
    status: MaterialStatus
    title: str
    folder: str
    origin: Origin | None = None
    languages: list[str] = Field(default_factory=list)
    fragments: list[FragmentMeta] = Field(default_factory=list)
    created_at: str

    def next_seg(self) -> int:
        return max((meta.seg for meta in self.fragments), default=0) + 1


def number_fragments(existing: Sequence[Fragment], new: Sequence[FragmentInput], *,
                     start: int | None = None) -> list[Fragment]:
    """Assign ``seg`` ids after the existing ones; validates one-paragraph text.

    ``start`` (the manifest's next id) wins over ``existing`` so an id is never
    reused even when a paragraph went missing from the Markdown.
    """
    if start is None:
        start = max((fragment.seg for fragment in existing), default=0) + 1
    numbered = []
    for offset, item in enumerate(new):
        text = item.text.replace("\r\n", "\n").replace("\r", "\n").strip()
        if not text:
            raise SourceFormatError("A fragment cannot be empty.")
        if _PARAGRAPH_BREAK.search(text):
            raise SourceFormatError("A fragment is one paragraph; split it before adding.")
        numbered.append(Fragment(
            seg=start + offset, text=text, start_ms=item.start_ms, end_ms=item.end_ms,
            speaker=item.speaker, page=item.page, index=item.index, role=item.role,
            level=item.level if item.role == "heading" else None,
        ))
    return numbered


def _header(placement: FragmentPlacement) -> str | None:
    if placement.start_ms is None:
        return None
    stamp = format_timestamp(placement.start_ms)
    return f"**Speaker {placement.speaker}** · {stamp}" if placement.speaker else stamp


def _paragraph(fragment: Fragment) -> str:
    header = _header(fragment)
    body = f"{fragment.text} ^{fragment.block_id}"
    return f"{header}\n{body}" if header else body


def render_source(material_id: str, kind: MaterialKind, fragments: Sequence[Fragment]) -> str:
    paragraphs = [_paragraph(fragment) for fragment in fragments]
    head = render_frontmatter({"skaz_id": material_id, "kind": kind})
    return head + "\n" + "\n\n".join(paragraphs) + ("\n" if paragraphs else "")


def render_appendix(fragments: Sequence[Fragment], *, after_existing: bool) -> str:
    """The bytes ``render_source`` would add for ``fragments`` at the end of the file.

    ``render_source(existing) + render_appendix(new, after_existing=bool(existing))``
    equals ``render_source(existing + new)``, so a growing source can be
    appended to instead of rewritten.
    """
    if not fragments:
        return ""
    body = "\n\n".join(_paragraph(fragment) for fragment in fragments) + "\n"
    return "\n" + body if after_existing else body


def source_paragraphs(text: str) -> dict[int, str]:
    """Map ``seg`` → raw paragraph text (block id removed). Foreign paragraphs are ignored."""
    try:
        _raw, _fields, body = split_frontmatter(text)
    except FrontmatterError as error:
        raise SourceFormatError(str(error)) from error
    found: dict[int, str] = {}
    for paragraph in _PARAGRAPH_BREAK.split(body.replace("\r\n", "\n")):
        stripped = paragraph.strip("\n")
        match = _SEG_SUFFIX.search(stripped)
        if match is None:
            continue
        found.setdefault(int(match.group(1)), stripped[: match.start()])
    return found


def read_source(text: str, placements: Sequence[FragmentPlacement]) -> list[Fragment]:
    """Fragments listed in the table, with their text read from the Markdown.

    A listed fragment whose paragraph is missing is skipped (the caller sees
    fewer fragments than the table lists); no text is ever guessed.
    """
    paragraphs = source_paragraphs(text)
    result = []
    for placement in placements:
        raw = paragraphs.get(placement.seg)
        if raw is None:
            continue
        header = _header(placement)
        if header is not None and raw.startswith(header + "\n"):
            raw = raw[len(header) + 1:]
        result.append(Fragment(
            seg=placement.seg, text=raw, start_ms=placement.start_ms, end_ms=placement.end_ms,
            speaker=placement.speaker, page=placement.page, index=placement.index,
            role=placement.role or "paragraph", level=placement.level,
        ))
    return result
