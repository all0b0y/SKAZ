"""Shared 0.4.0 wire shapes. Counters describe observations, never user knowledge."""

from __future__ import annotations

from datetime import date, datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

KbEntityId = Annotated[str, Field(min_length=1, max_length=128, pattern=r"^[a-zA-Z0-9_-]+$")]
KbCount = Annotated[int, Field(ge=0)]
KbExploreJobState = Literal["queued", "running", "paused", "done", "cancelled", "error"]
KbStopReason = Literal[
    "budget",
    "user_pause",
    "app_exit",
    "openalex_daily_limit",
    "decision_model_required",
    "science_consent_required",
    "provider_unavailable",
    "completed",
    "cancelled",
    "failed",
]
KbRunStage = Literal["collect", "rules", "decision", "novelty", "ready", "links", "repeats"]
KbJobOwner = Literal["explore", "research", "links", "weekly", "repeats"]
#: What one budget step counts. The funnel is always 30 candidates per batch (decision 3a+).
KbBudgetUnit = Literal["candidate", "claim_comparison", "material", "link"]
KbReadMarkValue = Literal["useful_method", "changed_my_view", "already_knew", "not_for_me"]


class KbContractRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True, str_strip_whitespace=True)


class KbContractError(BaseModel):
    code: Literal[
        "not_ready",
        "not_found",
        "conflict",
        "consent_required",
        "invalid_request",
        "openalex_daily_limit",
        "provider_unavailable",
        "library_unavailable",
    ]


class KbDateWindow(KbContractRequest):
    from_date: date | None = None
    to_date: date | None = None
    unknown: Literal["exclude", "separate"] = "exclude"

    @model_validator(mode="after")
    def ordered_dates(self) -> KbDateWindow:
        if self.from_date is not None and self.to_date is not None and self.from_date > self.to_date:
            raise ValueError("from_date must not follow to_date")
        return self


class KbPublicationDate(BaseModel):
    year: Annotated[int, Field(ge=1, le=9999)] | None
    date: date | None
    month: Annotated[int, Field(ge=1, le=12)] | None = None
    precision: Literal["day", "month", "year", "unknown"]
    origin: Literal["openalex", "arxiv", "crossref", "page", "unknown"]
    evidence_url: str | None

    @model_validator(mode="after")
    def precise_date(self) -> KbPublicationDate:
        if self.precision == "unknown":
            if self.year is not None or self.date is not None or self.month is not None:
                raise ValueError("Unknown publication dates must not contain invented components")
        elif self.year is None:
            raise ValueError("Known publication dates require a year")
        elif self.precision == "day":
            if self.date is None or self.date.year != self.year:
                raise ValueError("Day precision requires a matching publication date")
            if self.month is not None and self.month != self.date.month:
                raise ValueError("Publication month must match the date")
        elif self.date is not None:
            raise ValueError("Partial publication dates must not invent a day")
        elif self.precision == "month" and self.month is None:
            raise ValueError("Month precision requires a month")
        elif self.precision == "year" and self.month is not None:
            raise ValueError("Year precision must not invent a month")
        return self


class KbRunBudget(BaseModel):
    """One batch of a job. Continue starts the next batch; ``total_used`` spans all batches."""

    unit: KbBudgetUnit
    limit: Annotated[int, Field(ge=1)]
    used: KbCount
    remaining: KbCount
    total_used: KbCount
    batch: Annotated[int, Field(ge=1)]
    #: Only free steps run (weekly check, missed week): no paid model is called.
    free_only: bool

    @model_validator(mode="after")
    def consistent(self) -> KbRunBudget:
        if self.used + self.remaining != self.limit:
            raise ValueError("used + remaining must equal limit")
        if self.total_used < self.used:
            raise ValueError("total_used spans all batches, so it cannot be below used")
        if self.unit == "candidate" and self.limit != 30:
            raise ValueError("The funnel budget is 30 candidates per batch")
        return self


class KbCheckpoint(BaseModel):
    id: KbEntityId
    revision: Annotated[int, Field(ge=1)]
    stage: KbRunStage
    cursor: str | None
    completed_ids: list[str]
    pending_ids: list[str]
    saved_at: datetime


class KbRunCounters(BaseModel):
    checked: KbCount
    after_rules: KbCount
    #: Sorted by the decision model so far ("Sort by area 120 of 198").
    decided: KbCount
    on_topic: KbCount
    novelty_checked: KbCount
    new: KbCount
    covered: KbCount
    #: EX3 (UX-3): works dropped because neither an open text nor a real abstract exists.
    no_text: KbCount = 0


class KbExploreJob(BaseModel):
    id: KbEntityId
    owner: KbJobOwner
    state: KbExploreJobState
    stage: KbRunStage
    stop_reason: KbStopReason | None
    budget: KbRunBudget
    counters: KbRunCounters
    checkpoint: KbCheckpoint | None
    created_at: datetime
    updated_at: datetime
    #: Non-empty only with stop reason ``decision_model_required``; there is no silent fallback.
    decision_choices: list[Literal["download_local", "openrouter_jev"]]
    #: The model doing the sorting, shown as "local model · free"; ``null`` before one is chosen.
    decision_provider: Literal["local", "openrouter_jev"] | None
    #: When a stop like the daily OpenAlex limit lifts, if the provider says so.
    retry_at: datetime | None


class KbJobSummary(BaseModel):
    """One background job for the Explore progress line and the tray status item."""

    id: KbEntityId
    owner: KbJobOwner
    title: str
    state: KbExploreJobState
    stage: KbRunStage
    stop_reason: KbStopReason | None
    budget: KbRunBudget
    task_id: KbEntityId | None
    chat_id: str | None
    area_id: KbEntityId | None
    updated_at: datetime


class KbJobs(BaseModel):
    jobs: list[KbJobSummary]


class KbContinue(KbContractRequest):
    checkpoint_id: KbEntityId
    revision: Annotated[int, Field(ge=1)]
    decision_choice: Literal["download_local", "openrouter_jev"] | None = None


class KbExplorePageRef(BaseModel):
    page_id: str
    title: str
    block_id: str | None = None


class KbMaterialRef(BaseModel):
    material_id: str
    title: str


class KbAcknowledged(BaseModel):
    ok: Literal[True] = True
