"""Science/wiki-only weekly checks and evidence-backed N1 marks (B6)."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel

from .schemas_explore_common import (
    KbContractRequest,
    KbExploreJob,
    KbExplorePageRef,
    KbMaterialRef,
    KbPublicationDate,
)
from .schemas_freshness import KbLinkObservation


class KbWeeklySettings(BaseModel):
    enabled: bool
    #: The check whose candidates wait for "Check novelty"; ``null`` before the first one.
    latest_check_id: str | None
    candidates_waiting: int
    last_completed_at: datetime | None
    next_due_at: datetime | None
    missed: bool


class KbWeeklySettingsUpdate(KbContractRequest):
    enabled: bool


class KbMarkedStatement(KbExplorePageRef):
    """A wiki claim that uses the marked source: dimmed only when no other source supports it."""

    sole_source: bool
    also_supported_by: list[KbMaterialRef]


class KbFreshnessMark(BaseModel):
    id: str
    material_id: str
    kind: Literal["new_version", "retracted", "newer_contradicts", "link_gone"]
    reason: str
    evidence_url: str | None
    #: Where the fact comes from ("arXiv version history", "Crossref").
    evidence_label: str | None
    checked_at: datetime
    replacement_work_id: str | None
    #: New version: the one that is out ("v3"), and the one the user's copy is ("v2").
    version: str | None
    current_version: str | None
    publication: KbPublicationDate
    affected_statements: list[KbMarkedStatement]
    actions: list[Literal["replace_version", "delete_source", "keep_marked"]]
    kept_marked: bool
    created_at: datetime


class KbFreshnessMarks(BaseModel):
    marks: list[KbFreshnessMark]
    #: The latest "Check links" answer for one material, including "couldn't check" (never a mark).
    #: Always ``null`` when listing a wiki page's marks.
    last_link_check: KbLinkObservation | None


class KbFreshnessAction(KbContractRequest):
    action: Literal["replace_version", "keep_marked"]


class KbFreshnessActionResult(BaseModel):
    mark: KbFreshnessMark
    ingest_job_id: str | None


class KbCheckNotification(BaseModel):
    id: str
    kind: Literal["explore_finished", "research_finished", "weekly_check_started", "weekly_check_finished"]
    job_id: str
    task_id: str | None
    created_at: datetime
    message: str


class KbWeeklyCheck(KbExploreJob):
    trigger: Literal["manual", "scheduled", "missed_week"]
    candidates_waiting: int
    #: Pass as ``KbFunnelStart.candidate_ids`` for "Check novelty".
    candidate_ids: list[str]
    new_versions: int
    retractions: int
    newer_contradictions: int
    notifications: list[KbCheckNotification]
