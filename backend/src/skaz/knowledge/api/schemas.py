"""Pydantic models of the ``/kb/*`` API. The TypeScript contract is generated from these.

Names carry a ``Kb`` prefix so they never collide with the legacy OpenAPI
components. Response models have no defaults: every field is always present
(``null`` when empty), which keeps the generated TS types exact.
"""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from ..markdown.page import BlockKind, Owner, PageKind
from ..markdown.source import MaterialKind, MaterialStatus

KbLibraryState = Literal["not_configured", "ready", "unavailable"]


class _Request(BaseModel):
    model_config = ConfigDict(extra="forbid")


class KbLibrary(BaseModel):
    state: KbLibraryState
    root: str | None
    #: Where a new library would be created by ``POST /kb/library`` without a path.
    suggested_root: str
    #: Plain-English reason when ``state`` is ``unavailable``.
    reason: str | None
    library_id: str | None


class KbLibraryConnect(_Request):
    #: A folder the user chose; ``null`` = the suggested place in Documents.
    path: str | None = Field(default=None, max_length=4096)


class KbFolder(BaseModel):
    id: str
    name: str
    #: ``Inbox``: always present, cannot be renamed or deleted.
    system: bool
    material_count: int
    created_at: str


class KbFolderCreate(_Request):
    name: str = Field(min_length=1, max_length=255)


class KbFolderRename(_Request):
    name: str = Field(min_length=1, max_length=255)


class KbOrigin(BaseModel):
    type: Literal["recording", "file", "url", "paste"]
    url: str | None
    file_name: str | None


class KbMaterialSummary(BaseModel):
    id: str
    title: str
    kind: MaterialKind
    status: MaterialStatus
    folder_id: str
    languages: list[str]
    created_at: str
    fragment_count: int


class KbFragment(BaseModel):
    #: ``seg-<n>``: the block id in the source Markdown; stable forever.
    id: str
    seg: int
    text: str
    start_ms: int | None
    end_ms: int | None
    speaker: str | None
    page: int | None
    index: int | None


class KbMaterial(KbMaterialSummary):
    origin: KbOrigin | None
    fragments: list[KbFragment]


class KbPageSummary(BaseModel):
    id: str
    kind: PageKind
    title: str
    original: str | None
    aliases: list[str]
    folders: list[str]
    sources: list[str]
    language: str


class KbCitation(BaseModel):
    material_id: str
    seg: int
    #: False when the cited fragment is not in the library (deleted/not yet indexed).
    available: bool
    material_title: str | None
    start_ms: int | None
    end_ms: int | None
    page: int | None


class KbBlock(BaseModel):
    #: ``c-<id>`` for SKAZ blocks, ``u-<n>`` for unmarked user text.
    id: str
    kind: BlockKind
    owner: Owner
    #: False: plain text the user wrote without a SKAZ marker (always ``user_note``/``user``).
    marked: bool
    section: str | None
    #: Markdown of the block without the marker and block id (wikilinks kept).
    text: str
    hash: str
    citations: list[KbCitation]


class KbPage(KbPageSummary):
    blocks: list[KbBlock]


class KbSnippetPart(BaseModel):
    text: str
    match: bool


class KbFragmentHit(BaseModel):
    material_id: str
    material_title: str
    material_kind: MaterialKind
    seg: int
    start_ms: int | None
    page: int | None
    snippet: list[KbSnippetPart]


class KbBlockHit(BaseModel):
    page_id: str
    page_title: str
    page_kind: PageKind
    block_id: str
    kind: BlockKind
    owner: Owner
    snippet: list[KbSnippetPart]


class KbPageHit(BaseModel):
    id: str
    title: str
    kind: PageKind
    matched_alias: str | None


class KbSearchResults(BaseModel):
    query: str
    fragments: list[KbFragmentHit]
    blocks: list[KbBlockHit]
    pages: list[KbPageHit]


class KbNotification(BaseModel):
    id: str
    #: Set by the area that raises it (e.g. ``discrepancy``, ``excluded_fragment``).
    kind: str
    title: str
    body: str
    payload: dict[str, Any]
    requires_action: bool
    created_at: str
    dismissed_at: str | None
