"""OpenAlex map, explicit marks and factual signal contracts (B4)."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, Field

from ..markdown.source import MaterialKind
from .schemas_explore_common import (
    KbAcknowledged,  # noqa: F401 (the manifest finds each route's response model here)
    KbContractRequest,
    KbEntityId,
    KbPublicationDate,
    KbReadMarkValue,
)


class KbArea(BaseModel):
    id: KbEntityId
    parent_id: KbEntityId | None
    taxonomy_id: str | None
    #: Approved v3 opens on OpenAlex domains; a custom area collects topics from several branches.
    level: Literal["domain", "field", "subfield", "topic", "custom"]
    name: str
    original_name: str
    hidden: bool
    pinned: bool
    topic_ids: list[str]
    has_children: bool
    #: "5 of 14 topics": children with pages, and all children in the taxonomy.
    children_covered: int
    children_total: int
    pages: int
    sources: int
    newest_source_year: int | None
    recent_activity_at: datetime | None
    new_findings: int
    marked_materials: int
    wiki_share: Annotated[float, Field(ge=0, le=1)]
    depth: Literal["empty", "thin", "medium", "dense"]
    #: A gap tile's factual reason ("Next to LLM agents · no pages yet"); ``null`` for covered areas.
    gap_reason: str | None


class KbAreaMap(BaseModel):
    parent_id: KbEntityId | None
    breadcrumbs: list[KbArea]
    areas: list[KbArea]
    total_pages: int
    total_sources: int
    #: Gaps and thin areas anywhere below ``parent_id``, so not necessarily among ``areas``.
    worth_closing: list[KbArea]


class KbAreaUpdate(KbContractRequest):
    name: Annotated[str, Field(min_length=1, max_length=200)] | None = None
    hidden: bool | None = None
    pinned: bool | None = None


class KbAreaCreate(KbContractRequest):
    name: Annotated[str, Field(min_length=1, max_length=200)]
    topic_ids: list[str] = Field(min_length=1, max_length=100)


class KbReadMarkUpdate(KbContractRequest):
    value: KbReadMarkValue


class KbReadMark(BaseModel):
    material_id: str | None
    finding_id: KbEntityId | None
    value: KbReadMarkValue | None
    updated_at: datetime | None


class KbAreaMaterial(BaseModel):
    material_id: str
    title: str
    kind: MaterialKind
    publication: KbPublicationDate
    wiki_pages: int
    read_mark: KbReadMarkValue | None
    repeat_status: Literal["checked", "not_checked"]
    repeated_percent: Annotated[int, Field(ge=0, le=100)] | None
    repeats_source_titles: list[str]
    freshness_mark_ids: list[str]


class KbAreaMaterials(BaseModel):
    materials: list[KbAreaMaterial]
    #: In the whole area, not this page: whether to offer "Check older materials".
    not_checked_count: int
    next_cursor: str | None


class KbSignalEntity(BaseModel):
    kind: Literal["user", "material", "finding", "area", "research_task", "study_item", "chat"]
    id: str


class KbFactualSignal(BaseModel):
    id: KbEntityId
    subject: KbSignalEntity
    predicate: Literal[
        "read_mark_set",
        "read_mark_removed",
        "area_opened",
        "area_pinned",
        "area_hidden",
        "research_started",
        "research_paused",
        "research_completed",
        "study_reviewed",
    ]
    object: KbSignalEntity
    occurred_at: datetime
    origin: Literal["user_action", "task_event", "study_event"]
    value: str | None
    evidence_id: str
    supersedes_id: KbEntityId | None


class KbSignals(BaseModel):
    signals: list[KbFactualSignal]
    next_cursor: str | None
