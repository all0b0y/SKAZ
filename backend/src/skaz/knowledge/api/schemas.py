"""Pydantic models of the ``/kb/*`` API. The TypeScript contract is generated from these.

Names carry a ``Kb`` prefix so they never collide with the legacy OpenAPI
components. Response models have no defaults: every field is always present
(``null`` when empty), which keeps the generated TS types exact.
"""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from ..markdown.page import BlockKind, Owner, PageKind
from ..markdown.source import FragmentRole, MaterialKind, MaterialStatus

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
    #: A full scan is rebuilding the index (app start, retry): lists and search may be a step behind.
    indexing: bool = False


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


KbWikiState = Literal["not_in_wiki", "processing", "in_wiki", "failed"]


class KbMaterialSummary(BaseModel):
    id: str
    title: str
    kind: MaterialKind
    status: MaterialStatus
    folder_id: str
    languages: list[str]
    created_at: str
    fragment_count: int
    #: The "Wiki" column of All materials (see ``KbMaterialWiki``).
    wiki_state: KbWikiState
    folder_name: str


class KbFragment(BaseModel):
    #: ``seg-<n>``: the block id in the source Markdown; stable forever.
    id: str
    seg: int
    #: The text with the applied recognition corrections (what the wiki is built from).
    text: str
    start_ms: int | None
    end_ms: int | None
    speaker: str | None
    page: int | None
    index: int | None
    #: How the fragment is shown: a heading (``level`` 1–6), a list item, a quote, code or a paragraph.
    #: Display only — ``text`` is the same whatever the role, and quotes are matched against it.
    role: FragmentRole
    level: int | None
    #: The recognised text when corrections changed it; ``null`` when ``text`` is the original.
    original_text: str | None
    #: Ids of the recognition corrections in this fragment (any state).
    corrections: list[str]


class KbCorrectionCounts(BaseModel):
    applied: int
    doubtful: int


class KbTranslationFragment(BaseModel):
    #: Soniox translations have no segment ids: ``null``, paragraphs in the original's order.
    seg: int | None
    speaker: str | None
    text: str


class KbTranslation(BaseModel):
    language: str | None
    fragments: list[KbTranslationFragment]


class KbMaterialWiki(BaseModel):
    #: ``processing``: an ingest job runs; ``in_wiki``: its note/concept pages exist;
    #: ``failed``: the last job failed and nothing is in the wiki yet.
    state: KbWikiState
    note_page_id: str | None
    concept_count: int
    #: The latest ingest job of this material, if any.
    job_id: str | None
    #: Why the latest job failed (also when older pages are still in the wiki).
    error: str | None
    #: ``AGENT_UNAVAILABLE``: the agent can't work until it is fixed in Settings → Accounts & keys
    #: (signed out, outdated, none connected); a retry alone won't help. ``null`` otherwise.
    error_code: str | None


class KbMaterial(KbMaterialSummary):
    origin: KbOrigin | None
    fragments: list[KbFragment]
    correction_counts: KbCorrectionCounts
    #: The provider's translation (``.skaz/translation.md``), else ``null``.
    translation: KbTranslation | None
    wiki: KbMaterialWiki
    #: Fragments kept out of processing as instructions for an AI ("excluded fragments: N").
    excluded_count: int
    #: PDF pages with text SKAZ couldn't read (a font without a usable character map): that text
    #: is left out of the material — never sent to agents, never quoted.
    unreadable_pages: list[int] = Field(default_factory=list)


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
    #: The verbatim quote the claim rests on; highlight it rather than the whole fragment.
    quote: str | None = None


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


class KbPageRef(BaseModel):
    id: str
    kind: PageKind
    title: str


class KbPage(KbPageSummary):
    blocks: list[KbBlock]
    #: Pages this one is connected to (graph edges: its links and agent connections).
    related: list[KbPageRef]
    #: Pages that link here (backlinks) and are not already in ``related``.
    mentioned_in: list[KbPageRef]
    folder_names: list[str]
    #: When the page file last changed (ISO-8601 UTC); ``null`` when unknown.
    updated_at: str | None
    #: An Analysis (saved chat answer) is never a source for "from source" statements.
    is_analysis_source_forbidden: bool


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


class KbMaterialHit(BaseModel):
    id: str
    title: str
    kind: MaterialKind
    folder_id: str
    folder_name: str
    created_at: str
    #: The title with the matched words marked.
    snippet: list[KbSnippetPart]


class KbSearchCounts(BaseModel):
    """Totals per ⌘K section (not the length of the returned lists)."""

    wiki: int
    materials: int
    chats: int


class KbSearchResults(BaseModel):
    query: str
    fragments: list[KbFragmentHit]
    blocks: list[KbBlockHit]
    pages: list[KbPageHit]
    #: Materials whose title matches (newest first).
    materials: list[KbMaterialHit]
    counts: KbSearchCounts


class KbNotificationAction(BaseModel):
    id: str
    label: str
    primary: bool
    #: The action asks for a text (own note, fixed address).
    needs_text: bool


class KbSubjectRef(BaseModel):
    """What a click on a notification opens."""

    type: Literal["material", "page", "chat"]
    id: str
    block_id: str | None
    seg: int | None


class KbNotification(BaseModel):
    id: str
    #: Set by the area that raises it (e.g. ``discrepancy``, ``excluded_instruction``).
    kind: str
    title: str
    body: str
    payload: dict[str, Any]
    #: "Needs a decision" group; the others are "New".
    requires_action: bool
    created_at: str
    dismissed_at: str | None
    #: Monotonic change cursor (``after`` of the long poll).
    seq: int
    actions: list[KbNotificationAction]
    subject: KbSubjectRef | None
    resolved_at: str | None
    #: The id of the chosen action.
    resolution: str | None
