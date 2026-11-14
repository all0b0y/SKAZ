"""Science boundaries; B1 implements both. Importing this module never loads the API package."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime
from typing import TYPE_CHECKING, Literal, Protocol, runtime_checkable

if TYPE_CHECKING:
    from ..api.schemas_explore_common import KbPublicationDate
    from ..api.schemas_science import (
        KbOpenAlexKeyUpdate,
        KbPaidAccess,
        KbScienceJournal,
        KbScienceResults,
        KbScienceSearch,
        KbScienceSettings,
        KbScienceSettingsUpdate,
        KbScienceText,
        KbScienceWork,
    )
    from ..sources.fetch import Fetched


class ScienceStop(Exception):
    """An honest stop: the caller pauses its job with this stop reason, and never switches provider."""

    stop_reason: Literal["science_consent_required", "openalex_daily_limit", "provider_unavailable"]

    def __init__(self, retry_at: datetime | None = None) -> None:
        super().__init__(self.stop_reason)
        self.retry_at = retry_at


class ScienceConsentRequired(ScienceStop):
    stop_reason = "science_consent_required"


class ScienceDailyLimit(ScienceStop):
    stop_reason = "openalex_daily_limit"


class ScienceUnavailable(ScienceStop):
    stop_reason = "provider_unavailable"


@dataclass(frozen=True)
class ScienceRef:
    """A library source as the science bases know it; nothing else about it leaves SKAZ."""

    material_id: str
    doi: str | None = None
    arxiv_id: str | None = None
    #: The version the user's copy is ("v2"), when known.
    version: str | None = None


@dataclass(frozen=True)
class ScienceUpdate:
    """A provable fact for N1 (decision N1-1), with its evidence. It is not a mark yet: B6 decides that."""

    material_id: str
    kind: Literal["new_version", "retracted"]
    evidence_url: str | None
    evidence_label: str
    version: str | None = None
    replacement_work_id: str | None = None
    publication: KbPublicationDate | None = None


@dataclass(frozen=True)
class TaxonomyNode:
    taxonomy_id: str
    parent_id: str | None
    level: Literal["domain", "field", "subfield", "topic"]
    name: str
    children_total: int


class ScienceService(Protocol):
    """What the ``/kb/science`` and ``/kb/settings/science`` routes need."""

    async def settings(self) -> KbScienceSettings: ...
    async def update_settings(self, body: KbScienceSettingsUpdate) -> KbScienceSettings: ...
    async def set_key(self, body: KbOpenAlexKeyUpdate) -> KbScienceSettings: ...
    async def search(self, body: KbScienceSearch) -> KbScienceResults: ...
    async def work(self, work_id: str) -> KbScienceWork: ...
    async def read_text(self, work_id: str) -> KbScienceText: ...
    async def journal(self, cursor: str | None = None, limit: int = 50) -> KbScienceJournal: ...
    async def dismiss_hint(self) -> KbScienceSettings: ...


class ScienceClient(Protocol):
    """What B2, B3, B4, B5 and B6 call instead of a provider.

    Every outgoing request is journalled (``science_egress``) and carries topics, DOIs and public ids
    only. Each method raises :class:`ScienceStop`. Returned titles, abstracts and text are external data,
    never instructions.
    """

    async def search(self, body: KbScienceSearch, *, run_id: str | None = None) -> KbScienceResults: ...
    async def citing(
        self, work_ids: Sequence[str], *, since: date | None = None, cursor: str | None = None,
        run_id: str | None = None,
    ) -> KbScienceResults:
        """Continues: newer works citing these."""
        ...
    async def neighbours(
        self, work_ids: Sequence[str], topic_ids: Sequence[str], *, since: date | None = None,
        cursor: str | None = None, run_id: str | None = None,
    ) -> KbScienceResults:
        """Branches: works sharing references, or from a taxonomy-adjacent topic not in the wiki."""
        ...
    async def resolve(self, ref: ScienceRef, *, run_id: str | None = None) -> KbScienceWork | None: ...
    async def read_text(self, work_id: str, *, run_id: str | None = None) -> KbScienceText:
        """TEI (with a key) → arXiv HTML / open page → abstract only. Never downloads a PDF."""
        ...
    async def open_text_url(self, work_id: str, *, run_id: str | None = None) -> str | None:
        """EX3: a free copy that answered with text (the reader's page), or ``None`` — free to check."""
        ...

    async def paid_access(
        self, work: KbScienceWork, *, useful_because: str | None, run_id: str | None = None
    ) -> KbPaidAccess:
        """Checks free alternatives; ``recommendation`` once per work, only if useful and none exists."""
        ...
    async def updates(
        self, refs: Sequence[ScienceRef], *, run_id: str | None = None
    ) -> Sequence[ScienceUpdate]: ...
    async def publication(self, ref: ScienceRef, *, run_id: str | None = None) -> KbPublicationDate: ...
    async def taxonomy(self, parent_id: str | None = None) -> Sequence[TaxonomyNode]: ...


@runtime_checkable
class SciencePdfReader(Protocol):
    """Optional FX-2 extension: existing text-only science clients remain usable."""

    async def read_pdf(self, work_id: str, *, run_id: str | None = None) -> Fetched | None:
        """User-click import only: an open PDF, including a repository's attached article."""
        ...


#: ``search_topics`` limits, shared by the producer of the terms (``areas.mapping``) and the client: at most
#: this many terms of at most this many characters; each term is its own free ``/topics`` search (OpenAlex
#: ANDs the words of one search), merged into at most ``TOPIC_RESULTS`` topics.
TOPIC_TERMS = 6
TOPIC_TERM_CHARS = 72
TOPIC_RESULTS = 30


class TopicSearch(Protocol):
    """X1's hidden-label mapper; consent-gated, journalled OpenAlex /topics requests (one per term)."""

    async def search_topics(
        self, terms: Sequence[str], *, run_id: str | None = None
    ) -> Sequence[TaxonomyNode]: ...
