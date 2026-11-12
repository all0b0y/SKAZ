"""Map of the user's own topics, explicit marks and factual signal contracts (B4; EX2 redesign after G2).

EX2: the map is built from the user's own two-level topics (``level == "custom"``), stored when a material is
labelled; reading the map never calls a model or the network. OpenAlex topic ids stay a hidden search
label of a topic in the backend and never reach the UI (``topic_ids`` is empty for own topics).
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, Field

from ..markdown.source import MaterialKind
from .schemas_explore_common import (
    # Re-exported on purpose: the route manifest finds each response model here, and areas/freshness import
    # these from this module (explicit `X as X` keeps strict mypy's no-implicit-reexport happy).
    KbAcknowledged as KbAcknowledged,
)
from .schemas_explore_common import (
    KbContractRequest,
    KbEntityId,
    KbPublicationDate,
)
from .schemas_explore_common import (
    KbReadMarkValue as KbReadMarkValue,
)


class KbArea(BaseModel):
    id: KbEntityId
    parent_id: KbEntityId | None
    taxonomy_id: str | None
    #: EX2: ``custom`` = one of the user's own topics (topic or subtopic by ``parent_id``). The OpenAlex
    #: levels     #: remain only for rows of 0.4.0 builds before EX2 (hidden, never on the map).
    level: Literal["domain", "field", "subfield", "topic", "custom"]
    name: str
    original_name: str
    hidden: bool
    pinned: bool
    #: EX2: always empty for own topics — the hidden OpenAlex label never leaves the backend.
    topic_ids: list[str]
    has_children: bool
    #: "5 of 14 topics": children with pages, and all children in the taxonomy.
    children_covered: int
    children_total: int
    pages: int
    #: EX3 (UX-13): concept pages of the wiki made from this topic's materials — the tile's size. A concept
    #: drawn from two topics counts in each.
    concepts: int = 0
    sources: int
    newest_source_year: int | None
    recent_activity_at: datetime | None
    new_findings: int
    marked_materials: int
    #: EX2: wiki materials labelled with this topic (subtopics included); ``wiki_share`` is its share of all.
    materials: int
    wiki_share: Annotated[float, Field(ge=0, le=1)]
    depth: Literal["empty", "thin", "medium", "dense"]
    #: A gap tile's factual reason ("Next to LLM agents · no pages yet"); ``null`` for covered areas.
    gap_reason: str | None


class KbTopicLabelling(BaseModel):
    """The background job that gives wiki materials their topic (EX2).

    ``not_ready``: no wiki engine to ask."""

    state: Literal["idle", "running", "paused", "not_ready"]
    job_id: KbEntityId | None
    done: int
    total: int
    #: A job stop reason / contract error code when paused or not ready (``engine_limit``, ``not_ready``…).
    reason_code: str | None
    #: The engine that labels (the wiki engine of Settings → Wiki), for "≈5 calls on Codex".
    engine: str | None


class KbAreaMap(BaseModel):
    parent_id: KbEntityId | None
    breadcrumbs: list[KbArea]
    areas: list[KbArea]
    total_pages: int
    total_sources: int
    #: EX2: deprecated, always empty ("Worth closing" was removed with the OpenAlex domains map).
    worth_closing: list[KbArea]
    #: EX2: wiki materials with no topic yet, and the job that labels them (started only by the user's click).
    unsorted_materials: int
    labelling: KbTopicLabelling


class KbAreaUpdate(KbContractRequest):
    name: Annotated[str, Field(min_length=1, max_length=200)] | None = None
    hidden: bool | None = None
    pinned: bool | None = None


class KbAreaCreate(KbContractRequest):
    """EX2: the user creates an own topic by name (a subtopic with ``parent_id``)."""

    name: Annotated[str, Field(min_length=1, max_length=200)]
    parent_id: KbEntityId | None = None
    #: Pre-EX2 custom areas from OpenAlex topics; own topics leave it empty.
    topic_ids: list[str] = Field(default_factory=list, max_length=100)


class KbAreaMerge(KbContractRequest):
    """EX2: merge this topic into another; its materials and subtopics move there."""

    into_id: KbEntityId


class KbMaterialTopicSet(KbContractRequest):
    """EX2: the user moves a material to one of their topics (wins over the agent's label)."""

    area_id: KbEntityId


class KbMaterialTopic(BaseModel):
    material_id: str
    area_id: KbEntityId | None
    origin: Literal["agent", "user"] | None


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
    #: EX3 (UX-15): concept pages this material gave the wiki — its tile's size on the last map level.
    concepts: int = 0
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
