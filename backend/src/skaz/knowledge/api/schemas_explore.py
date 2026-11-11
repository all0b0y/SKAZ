"""Funnel, finding and reading-session contracts (B2)."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal, cast

from pydantic import BaseModel, Field

from .schemas_explore_common import (
    KbContractRequest,
    KbDateWindow,
    KbEntityId,
    KbExploreJob,
    KbExploreJobState,
    KbExplorePageRef,
    KbJobs,  # noqa: F401 (the manifest finds each route's response model here)
    KbMaterialRef,
    KbReadMarkValue,
)
from .schemas_science import SCIENCE_TOPIC_CHARS, KbScienceWork

KbFindingLabel = Literal["new", "extends", "contradicts", "branch", "covered"]
KbFindingChannel = Literal["continues", "branches", "search"]


class KbFunnelStart(KbContractRequest):
    area_id: KbEntityId | None = None
    #: The search line leaves as one science topic (C0-1): the same limit, checked before a run exists
    #: (review R1-12).
    query: Annotated[str, Field(max_length=SCIENCE_TOPIC_CHARS)] = ""
    dates: KbDateWindow | None = None
    channels: list[KbFindingChannel] = Field(
        default_factory=lambda: cast(list[KbFindingChannel], ["continues", "branches", "search"])
    )
    candidate_ids: list[KbEntityId] = Field(default_factory=list, max_length=100)


class KbFunnelRun(KbExploreJob):
    area_id: KbEntityId | None
    task_id: KbEntityId | None
    query: str
    channels: list[KbFindingChannel]
    active_area_ids: list[KbEntityId]


class KbThesis(BaseModel):
    text: str
    label: KbFindingLabel
    wiki_refs: list[KbExplorePageRef]


class KbFinding(BaseModel):
    id: KbEntityId
    run_id: KbEntityId
    task_id: KbEntityId | None
    area_id: KbEntityId | None
    channel: KbFindingChannel
    label: KbFindingLabel
    work: KbScienceWork
    #: The area's path for the finding row ("AI › LLM agents").
    area_path: list[str]
    #: Why it matters; external text is data, and the wording is SKAZ's own.
    reason: str
    #: Wiki pages ``reason`` talks about.
    wiki_refs: list[KbExplorePageRef]
    theses: list[KbThesis]
    #: Continues: wiki sources this work cites ("cites Reflexion").
    cites_materials: list[KbMaterialRef]
    #: Branches: how many of the user's sources it shares ("shares 3 of your sources").
    shared_source_count: int
    #: N2: shown in the mode menu ("Sections 1–2 repeat your wiki — Brief tour will skip them").
    repeat_hint: str | None
    read_mark: KbReadMarkValue | None
    material_id: str | None
    text_available: Literal["full_text", "abstract_only", "unchecked"]
    created_at: datetime


class KbFindingGroup(BaseModel):
    task_id: KbEntityId | None
    task_title: str | None
    #: The task's state for the group heading; ``null`` for findings outside a task.
    task_state: KbExploreJobState | None
    updated_at: datetime | None
    findings: list[KbFinding]


class KbFindings(BaseModel):
    groups: list[KbFindingGroup]
    covered_count: int
    next_cursor: str | None
    checked_at: datetime | None
    full_text_key_hint_count: int


class KbExploreStart(KbContractRequest):
    mode: Literal["brief_tour", "deep_dive", "notes"]
    add_to_wiki: bool = False


class KbExploring(BaseModel):
    id: KbEntityId
    finding_id: KbEntityId
    chat_id: str
    mode: Literal["brief_tour", "deep_dive", "notes"]
    text_kind: Literal["tei", "arxiv_html", "open_page", "abstract_only"]
    material_id: str | None
    started_at: datetime


class KbExploringList(BaseModel):
    items: list[KbExploring]


class KbFindingImport(KbContractRequest):
    content: Literal["full_text", "abstract_only"]


class KbFindingImported(BaseModel):
    finding_id: KbEntityId
    material_id: str
    content: Literal["full_text", "abstract_only"]
    to_wiki: Literal[True] = True
