"""Science metadata and text contracts; egress contains only topics, DOIs and public ids."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, Field, SecretStr, model_validator

from .schemas_explore_common import KbContractRequest, KbDateWindow, KbEntityId, KbPublicationDate

KbScienceProvider = Literal["openalex", "arxiv", "crossref"]
#: The longest topic that may leave SKAZ; the Explore search line (one topic) has the same limit.
SCIENCE_TOPIC_CHARS = 300


class KbSciencePayload(KbContractRequest):
    topics: list[Annotated[str, Field(min_length=1, max_length=SCIENCE_TOPIC_CHARS)]] = Field(
        default_factory=list, max_length=30
    )
    dois: list[Annotated[str, Field(pattern=r"^10\.\d{4,9}/\S+$", max_length=512)]] = Field(
        default_factory=list, max_length=30
    )
    ids: list[Annotated[str, Field(min_length=1, max_length=256)]] = Field(
        default_factory=list, max_length=30
    )


class KbScienceSearch(KbContractRequest):
    provider: KbScienceProvider = "openalex"
    payload: KbSciencePayload
    dates: KbDateWindow | None = None
    cursor: str | None = None
    limit: Annotated[int, Field(ge=1, le=100)] = 30


class KbScienceLocation(BaseModel):
    url: str
    kind: Literal["tei", "arxiv_html", "open_page", "publisher"]
    open_access: bool


class KbPaidAccess(BaseModel):
    paid: bool
    alternatives_checked: bool
    free_alternative_ids: list[str]
    suggestion_shown_at: datetime | None
    recommendation: str | None
    publisher_url: str | None


class KbScienceWork(BaseModel):
    id: KbEntityId
    provider: KbScienceProvider
    provider_id: str
    doi: str | None
    arxiv_id: str | None
    title: str
    authors: list[str]
    publication: KbPublicationDate
    venue: str | None
    #: The provider's work type ("article", "preprint"…), shown beside the year.
    publication_type: str | None
    abstract: str | None
    topic_ids: list[str]
    referenced_ids: list[str]
    cited_by_count: int
    locations: list[KbScienceLocation]
    access: KbPaidAccess


class KbScienceResults(BaseModel):
    works: list[KbScienceWork]
    next_cursor: str | None
    stop_reason: Literal["openalex_daily_limit", "provider_unavailable"] | None
    retry_at: datetime | None = None


class KbScienceText(BaseModel):
    work_id: KbEntityId
    kind: Literal["tei", "arxiv_html", "open_page", "abstract_only"]
    text: str
    source_url: str | None
    access: KbPaidAccess


class KbScienceEgress(BaseModel):
    id: KbEntityId
    requested_at: datetime
    provider: KbScienceProvider
    operation: Literal["search", "metadata", "citations", "full_text", "alternatives", "taxonomy"]
    destination_host: str
    payload: KbSciencePayload
    outcome: Literal["sent", "succeeded", "failed", "rate_limited"]
    status_code: int | None
    run_id: str | None


class KbScienceJournal(BaseModel):
    records: list[KbScienceEgress]
    next_cursor: str | None


class KbScienceSettings(BaseModel):
    enabled: bool
    consent_at: datetime | None
    openalex_key_configured: bool
    full_text_hint_dismissed: bool


class KbScienceSettingsUpdate(KbContractRequest):
    enabled: bool
    consent: Literal["topics_dois_ids"] | None = None

    @model_validator(mode="after")
    def explicit_consent(self) -> KbScienceSettingsUpdate:
        if self.enabled and self.consent != "topics_dois_ids":
            raise ValueError("Enabling science integration requires explicit consent")
        return self


class KbOpenAlexKeyUpdate(KbContractRequest):
    """Saved in the secret store, never returned; an empty key deletes it (as ``/keys/{provider}``)."""

    key: SecretStr = Field(max_length=4096)
