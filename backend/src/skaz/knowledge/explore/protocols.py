"""Explore boundaries; B2 implements all three. Importing this module never loads the API package."""

from __future__ import annotations

from collections.abc import Collection, Sequence
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from ..api.schemas_explore import (
        KbCandidateOutcome,
        KbDiscussion,
        KbFinding,
        KbFindingImported,
        KbFindings,
        KbFindingsShow,
        KbFindingsSort,
        KbFindingsType,
        KbFunnelCandidate,
        KbFunnelCandidates,
        KbFunnelRun,
        KbFunnelStart,
        KbSearch,
        KbSearches,
        KbSearchPlan,
        KbSearchPlanRequest,
        KbSearchRename,
        KbThesis,
    )
    from ..api.schemas_explore_common import (
        KbAcknowledged,
        KbCheckpoint,
        KbContinue,
        KbExploreJob,
        KbJobOwner,
        KbJobs,
        KbRunBudget,
        KbRunCounters,
        KbRunStage,
        KbStopReason,
    )
    from ..api.schemas_science import KbScienceWork


class ExploreService(Protocol):
    """What the ``/kb/explore`` routes need."""

    async def start(self, body: KbFunnelStart, *, free_only: bool = False) -> KbFunnelRun: ...
    async def run(self, run_id: str) -> KbFunnelRun: ...
    async def pause(self, run_id: str) -> KbFunnelRun: ...
    async def resume(self, run_id: str, body: KbContinue) -> KbFunnelRun: ...
    async def cancel(self, run_id: str) -> KbFunnelRun: ...
    async def jobs(self, active: bool = True) -> KbJobs: ...
    async def findings(
        self,
        area_id: str | None = None,
        task_id: str | None = None,
        include_covered: bool = False,
        cursor: str | None = None,
        limit: int = 30,
        *,
        run_id: str | None = None,
        show: KbFindingsShow = "active",
        free_only: bool = False,
        year_from: int | None = None,
        year_to: int | None = None,
        types: Sequence[KbFindingsType] = (),
        sort: KbFindingsSort = "for_you",
    ) -> KbFindings: ...
    async def finding(self, finding_id: str) -> KbFinding: ...
    # EX3 (Explore v2): searches in the side list and what the user does with a finding.
    async def searches(self) -> KbSearches: ...
    async def rename_search(self, run_id: str, body: KbSearchRename) -> KbSearch: ...
    async def delete_search(self, run_id: str) -> KbAcknowledged: ...
    async def mark_seen(self, finding_id: str) -> KbFinding: ...
    async def dismiss(self, finding_id: str) -> KbFinding: ...
    async def restore(self, finding_id: str) -> KbFinding: ...
    async def add_to_materials(self, finding_id: str) -> KbFindingImported: ...
    async def discuss(self, finding_id: str) -> KbDiscussion: ...
    # EX2 (X2): the "Will search" plan and the funnel on view.
    async def plan(self, body: KbSearchPlanRequest) -> KbSearchPlan: ...
    async def candidates(
        self,
        run_id: str,
        outcome: KbCandidateOutcome | None = None,
        cursor: str | None = None,
        limit: int = 30,
    ) -> KbFunnelCandidates: ...
    async def mark_fits(self, run_id: str, candidate_id: str) -> KbFunnelCandidate: ...


class NoveltyChecker(Protocol):
    """Theses against the wiki, in batches; one model call per batch, the budget is the caller's."""

    async def check(self, works: Sequence[KbScienceWork]) -> Sequence[Sequence[KbThesis]]: ...


class JobStore(Protocol):
    """The one store of ``explore_jobs``, checkpoints and completed work; B3, B5, B6 and B7 use it.

    Blocking repository, like ``WebSearchStore``: callers run it through ``disk_call``.
    """

    def create(
        self, owner: KbJobOwner, title: str, stage: KbRunStage, budget: KbRunBudget
    ) -> KbExploreJob: ...
    def get(self, job_id: str) -> KbExploreJob | None: ...
    def active(self) -> Sequence[KbExploreJob]: ...
    def progress(
        self, job_id: str, *, stage: KbRunStage, budget: KbRunBudget, counters: KbRunCounters
    ) -> KbExploreJob: ...
    def claim_paused(
        self, job_id: str, *, checkpoint_id: str, revision: int, budget: KbRunBudget | None = None
    ) -> KbExploreJob:
        """Continue: paused at exactly this checkpoint → running, atomically; else ``ClaimLost`` (409)."""
        ...
    def advance(
        self, job_id: str, *, stage: KbRunStage, budget: KbRunBudget, counters: KbRunCounters
    ) -> KbExploreJob:
        """Progress of a running worker that never undoes a Pause/Cancel which landed meanwhile."""
        ...
    def stop(self, job_id: str, reason: KbStopReason, *, retry_at: str | None = None) -> KbExploreJob:
        """Paused, done, cancelled or error follows from the reason."""
        ...
    def checkpoint(
        self, job_id: str, *, stage: KbRunStage, cursor: str | None, completed_ids: Sequence[str],
        pending_ids: Sequence[str],
    ) -> KbCheckpoint: ...
    def complete(self, job_id: str, candidate_id: str, stage: KbRunStage, result_json: str) -> None:
        """Records finished work; doing the same work twice is a conflict, so Continue never repeats it."""
        ...
    def completed(self, job_id: str, stage: KbRunStage) -> Collection[str]: ...
    def recover(self) -> Sequence[str]:
        """On start: running jobs become paused with ``app_exit``; returns their ids."""
        ...
