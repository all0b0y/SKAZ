"""Explore boundaries; B2 implements all three. Importing this module never loads the API package."""

from __future__ import annotations

from collections.abc import Collection, Sequence
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from ..api.schemas_explore import (
        KbCandidateOutcome,
        KbExploreStart,
        KbExploring,
        KbExploringList,
        KbFinding,
        KbFindingImport,
        KbFindingImported,
        KbFindings,
        KbFunnelCandidate,
        KbFunnelCandidates,
        KbFunnelRun,
        KbFunnelStart,
        KbSearchPlan,
        KbSearchPlanRequest,
        KbThesis,
    )
    from ..api.schemas_explore_common import (
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
    ) -> KbFindings: ...
    async def finding(self, finding_id: str) -> KbFinding: ...
    async def explore(self, finding_id: str, body: KbExploreStart) -> KbExploring: ...
    async def add_to_wiki(self, finding_id: str, body: KbFindingImport) -> KbFindingImported: ...
    async def exploring(self) -> KbExploringList: ...
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


class FunnelRunner(Protocol):
    """B3 runs a research task's funnel through this; the task owns no funnel logic of its own."""

    async def start_for_task(
        self, task_id: str, title: str, body: KbFunnelStart, *, free_only: bool = False
    ) -> KbFunnelRun: ...
    async def waiting(self, run_id: str) -> list[str]: ...
    async def run(self, run_id: str) -> KbFunnelRun: ...
    async def pause(self, run_id: str) -> KbFunnelRun: ...
    async def resume(self, run_id: str, body: KbContinue) -> KbFunnelRun: ...
    async def cancel(self, run_id: str) -> KbFunnelRun: ...


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
