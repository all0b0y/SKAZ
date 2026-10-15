"""Typed rows of the knowledge database (plain dataclasses, no ORM)."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from ..markdown.source import FragmentRole


@dataclass(frozen=True)
class FolderRecord:
    id: str
    name: str
    rel_path: str
    system: bool
    created_at: str
    material_count: int = 0


@dataclass(frozen=True)
class MaterialRecord:
    id: str
    folder_id: str
    kind: str
    status: str
    title: str
    rel_dir: str
    source_file: str
    origin: dict[str, Any] | None
    languages: tuple[str, ...]
    created_at: str
    fragment_count: int = 0


@dataclass(frozen=True)
class FragmentRecord:
    material_id: str
    seg: int
    ordinal: int
    text: str
    start_ms: int | None = None
    end_ms: int | None = None
    speaker: str | None = None
    page: int | None = None
    index: int | None = None
    role: FragmentRole = "paragraph"
    level: int | None = None

    @property
    def id(self) -> str:
        return f"seg-{self.seg}"


@dataclass(frozen=True)
class PageRecord:
    id: str
    kind: str
    title: str
    rel_path: str
    original: str | None
    language: str
    file_sha256: str
    indexed_at: str
    folders: tuple[str, ...] = ()
    sources: tuple[str, ...] = ()
    aliases: tuple[str, ...] = ()


@dataclass(frozen=True)
class CitationRecord:
    material_id: str
    seg: int
    quote: str | None = None


@dataclass(frozen=True)
class BlockRecord:
    page_id: str
    block_id: str
    ordinal: int
    section: str | None
    kind: str
    owner: str
    hash: str
    text: str
    marked: bool
    citations: tuple[CitationRecord, ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class NotificationRecord:
    id: str
    kind: str
    title: str
    body: str
    payload: dict[str, Any]
    requires_action: bool
    created_at: str
    dismissed_at: str | None
    #: Monotonic change cursor: set on creation and bumped by every change (resolve, dismiss).
    seq: int = 0
    #: What a click opens: ``{"type": "material"|"page"|"chat", "id", "block_id"?, "seg"?}``.
    subject: dict[str, Any] | None = None
    resolved_at: str | None = None
    #: The id of the action the user chose.
    resolution: str | None = None
    read_at: str | None = None


@dataclass(frozen=True)
class LibraryStateRecord:
    root: str
    library_id: str
    connected_at: str
