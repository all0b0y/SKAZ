"""What B6 takes from other slices, each named explicitly (no ``getattr`` guessing, no stand-ins).

The runtime passes ``kb_jobs`` (B2), ``kb_science`` (B1), ``kb_explore`` (B2), ``kb_areas.directory`` (B4),
``kb_freshness`` (B5), ``kb_sources`` and ``kb_ingest`` (the existing intake). These Protocols name only
the calls B6 makes; importing this module never loads the API package.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import TYPE_CHECKING, Any, Protocol

from ..explore.protocols import JobStore

if TYPE_CHECKING:
    from ..api.schemas_explore import KbFunnelRun, KbFunnelStart
    from ..api.schemas_explore_common import KbContinue, KbJobOwner, KbRunStage
    from ..api.schemas_freshness import KbLinkObservation
    from ..api.schemas_science import KbScienceSettings
    from ..science.protocols import ScienceRef, ScienceUpdate


class WeeklyJobs(JobStore, Protocol):
    """B2's ``JobStore`` plus the cross-run verdict lookup it offers (open question 4)."""

    def earlier_result(
        self, candidate_id: str, stage: KbRunStage, *, owners: Sequence[KbJobOwner], exclude_job: str
    ) -> str | None: ...
    def result(self, job_id: str, candidate_id: str, stage: KbRunStage) -> str | None: ...
    def results(self, job_id: str, stage: KbRunStage) -> Mapping[str, str]: ...


class WeeklyScience(Protocol):
    """B1's client: N1 facts, and whether the integration is on (a manual check refuses before a job)."""

    async def updates(
        self, refs: Sequence[ScienceRef], *, run_id: str | None = None
    ) -> Sequence[ScienceUpdate]: ...
    async def settings(self) -> KbScienceSettings: ...


class WeeklyFunnel(Protocol):
    """B2's funnel: a ``free_only`` run per pinned area, then the candidates it left for "Check novelty"."""

    async def start(self, body: KbFunnelStart, *, free_only: bool = False) -> KbFunnelRun: ...
    async def run(self, run_id: str) -> KbFunnelRun: ...
    async def pause(self, run_id: str) -> KbFunnelRun: ...
    async def resume(self, run_id: str, body: KbContinue) -> KbFunnelRun: ...
    async def settled(self, run_id: str) -> KbFunnelRun: ...
    async def waiting(self, run_id: str) -> list[str]: ...


class LinkIntake(Protocol):
    """The existing link intake (``sources/service.py``): "Replace with vN" adds the new version by link."""

    async def add_link(
        self, url: str, folder_id: str, title: str | None = None, *, to_wiki: bool | None = None
    ) -> Any: ...


class IngestStarter(Protocol):
    """The existing wiki intake: the replacement goes to the wiki when the replaced copy was there."""

    async def request_ingest(self, material_id: str) -> Any: ...


class LinkObservations(Protocol):
    """B5: the latest "Check links" answer for one material ("couldn't check" included; never a mark)."""

    def latest_observation(self, material_id: str) -> KbLinkObservation | None: ...
