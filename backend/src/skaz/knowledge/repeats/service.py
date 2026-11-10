"""``runtime.kb_repeats``: repeats of a material and "Check older materials" on an area (0.4.0 B7).

Reading needs no other slice. A check is a ``JobStore`` job (owner ``repeats``, unit ``claim_comparison``,
30 per batch, ``free_only`` false: the decision model is asked); until ``runtime.kb_jobs`` exists the job
routes answer ``not_ready`` and nothing starts. No decision model chosen → the job stops
``decision_model_required`` with the free steps done; there is no fallback to another model.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime

from ...native_io import disk_call
from ..api.contract_routes import ContractFailure
from ..api.schemas_explore_common import KbContinue, KbRunBudget, KbRunCounters, KbStopReason
from ..api.schemas_repeats import KbMaterialRepeats, KbRepeatCheck, KbRepeatCheckStart
from ..areas.protocols import AreaDirectory
from ..decisions.protocol import DecisionLayer
from ..errors import KnowledgeError, NotFound
from ..explore.protocols import JobStore
from ..ingest.pages import block_prefix
from ..service import KnowledgeService
from ..wiki.overlap import _statements
from ..wiki.statements import Statement, page_statements
from .compare import Unanswered, compare
from .reader import RepeatReader, stamp_marks_from, text_hash
from .store import Evidence, Judged, RepeatStore

log = logging.getLogger(__name__)

BATCH_LIMIT = 30
#: This many "no answer at all" in a row (not "unsure") means the layer is down, not undecided.
OUTAGE_STREAK = 3


class _Conflict(KnowledgeError):
    status_code = 409


def _candidate_id(page_id: str, block_id: str) -> str:
    return f"{page_id}:{block_id}"


@dataclass
class _Plan:
    """What is left of one material: its own statements not compared yet."""

    material_id: str
    statements: list[tuple[str, str]]


@dataclass
class _Live:
    task: asyncio.Task[None] | None = None
    pause: bool = False
    #: Set when the task ends on its own so ``pause`` can wait for the final state.
    finished: asyncio.Event = field(default_factory=asyncio.Event)


class RepeatsService:
    """Implements ``repeats.protocols.RepeatsService`` and ``RepeatSummaries``."""

    def __init__(
        self,
        kb: KnowledgeService,
        *,
        areas: AreaDirectory | None,
        decisions: Callable[[], DecisionLayer | None],
        jobs: JobStore | None = None,
        batch_limit: int = BATCH_LIMIT,
        n2_from: datetime | None = None,
    ) -> None:
        self._kb = kb
        self._store = RepeatStore(kb.db)
        self._reader = RepeatReader(kb, self._store, n2_from=n2_from)
        # Option A: stamp the boundary when 0.4.0 first scans a library, not later on the first repeats read.
        kb.after_scan.append(self._stamp_marks_from)
        self._areas = areas
        self._decisions = decisions
        self._jobs = jobs
        self._limit = batch_limit
        self._live: dict[str, _Live] = {}

    # -- readiness --------------------------------------------------------------------------

    def _stamp_marks_from(self) -> None:
        stamp_marks_from(self._kb)

    def _ensure_ready(self) -> None:
        if self._kb.view().state == "not_configured":
            raise ContractFailure(503, "not_ready")

    def _job_store(self) -> JobStore:
        if self._jobs is None:
            raise ContractFailure(503, "not_ready")
        return self._jobs

    def _directory(self) -> AreaDirectory:
        if self._areas is None:
            raise ContractFailure(503, "not_ready")
        return self._areas

    # -- reading ----------------------------------------------------------------------------

    def summaries(self, material_ids: Sequence[str]) -> Mapping[str, KbMaterialRepeats]:
        """``RepeatSummaries``: blocking; callers use ``disk_call``."""
        if self._kb.view().state == "not_configured":
            return {}
        return self._reader.summaries(material_ids)

    async def material(self, material_id: str) -> KbMaterialRepeats:
        await disk_call(self._ensure_ready)
        return await disk_call(self._reader.material, material_id)

    # -- jobs -------------------------------------------------------------------------------

    async def start(self, body: KbRepeatCheckStart) -> KbRepeatCheck:
        await disk_call(self._ensure_ready)
        jobs, directory = self._job_store(), self._directory()
        if not await disk_call(directory.area_path, body.area_id):
            raise NotFound("This area wasn't found.")
        for run in await disk_call(self._store.runs_of_area, body.area_id):
            job = await disk_call(jobs.get, run.check_id)
            if job is not None and job.state in ("queued", "running"):
                raise _Conflict("A check of this area is already running.")
        budget = KbRunBudget(unit="claim_comparison", limit=self._limit, used=0, remaining=self._limit,
                             total_used=0, batch=1, free_only=False)
        job = await disk_call(jobs.create, "repeats", "Check older materials", "repeats", budget)
        await disk_call(self._store.add_run, job.id, body.area_id, 0)
        self._launch(job.id, body.area_id)
        return await self._view(job.id)

    async def check(self, check_id: str) -> KbRepeatCheck:
        await disk_call(self._ensure_ready)
        return await self._view(check_id)

    async def pause(self, check_id: str) -> KbRepeatCheck:
        await disk_call(self._ensure_ready)
        job = (await self._view(check_id))
        live = self._live.get(check_id)
        if job.state not in ("running", "queued") or live is None:
            raise _Conflict("This check is not running.")
        live.pause = True
        await live.finished.wait()
        return await self._view(check_id)

    async def resume(self, check_id: str, body: KbContinue) -> KbRepeatCheck:
        await disk_call(self._ensure_ready)
        job = await self._view(check_id)
        if job.state != "paused" or check_id in self._live:
            raise _Conflict("Only a paused check can continue.")
        cp = job.checkpoint
        if cp is None or cp.id != body.checkpoint_id or cp.revision != body.revision:
            raise _Conflict("The checkpoint is out of date.")
        run = await disk_call(self._store.run, check_id)
        if run is None:
            raise NotFound("This check wasn't found.")
        self._launch(check_id, run.area_id)
        return await self._view(check_id)

    async def join(self, check_id: str) -> None:
        """Waits for a running check's task to end (tests, shutdown)."""
        live = self._live.get(check_id)
        if live is not None:
            await live.finished.wait()

    async def aclose(self) -> None:
        live_checks = list(self._live.values())
        for live in live_checks:
            if live.task is not None:
                live.task.cancel()
        await asyncio.gather(*(live.finished.wait() for live in live_checks))

    async def _view(self, check_id: str) -> KbRepeatCheck:
        jobs = self._job_store()
        job = await disk_call(jobs.get, check_id)
        run = await disk_call(self._store.run, check_id)
        if job is None or run is None or job.owner != "repeats":
            raise NotFound("This check wasn't found.")
        return KbRepeatCheck(**job.model_dump(), area_id=run.area_id, materials_checked=run.materials_checked,
                             materials_remaining=run.materials_remaining)

    # -- the batch --------------------------------------------------------------------------

    def _launch(self, check_id: str, area_id: str) -> None:
        live = _Live()
        self._live[check_id] = live

        async def run() -> None:
            try:
                await self._run(check_id, area_id, live)
            except asyncio.CancelledError:
                raise  # app exit: ``JobStore.recover`` pauses the job with ``app_exit`` at the next start
            except Exception:  # ids only: the text of a material never goes to a log
                log.exception("repeat check %s failed", check_id)
                try:
                    await disk_call(self._job_store().stop, check_id, "failed")
                except Exception:
                    log.exception("repeat check %s could not be marked failed", check_id)
            finally:
                self._live.pop(check_id, None)
                live.finished.set()

        live.task = asyncio.get_running_loop().create_task(run())

    def _plan(self, area_id: str) -> list[_Plan]:
        """Materials of the area still ``not_checked`` with their statements not compared yet."""
        material_ids = list(self._directory().materials(area_id))
        pending = self._reader.needs_check(material_ids)
        evidence = self._store.evidence(pending)
        plans = []
        for material_id in pending:
            judged = evidence[material_id].judged if material_id in evidence else {}
            statements = [(item.page_id, item.block_id) for item in _statements(self._kb, material_id)
                          if item.block_id.startswith(block_prefix(material_id))
                          and item.materials == {material_id}
                          and (item.page_id, item.block_id) not in judged]
            plans.append(_Plan(material_id, statements))
        return plans

    def _statement(self, page_id: str, block_id: str,
                   material_id: str) -> tuple[Statement | None, list[Statement]]:
        """The statement and what it can repeat: statements of sources added BEFORE its material.

        Only the earlier source can be "already in your wiki", exactly as N2 merges a later source into an
        earlier one; comparing both ways would make every pair repeat each other.
        """
        everything = page_statements(self._kb, page_id)
        own = next((item for item in everything if item.block_id == block_id), None)
        record = self._kb.material_repo.get(material_id)
        if own is None or record is None:
            return None, []
        mine = {cite.material_id for cite in own.cites}
        earlier: dict[str, bool] = {}

        def is_earlier(other: Statement) -> bool:
            author = other.material_id
            if author is None:
                return False
            if author not in earlier:
                found = self._kb.material_repo.get(author)
                earlier[author] = found is not None and (
                    (found.created_at, found.id) < (record.created_at, record.id))
            return earlier[author]

        return own, [item for item in everything
                     if item.block_id != block_id and not mine & {cite.material_id for cite in item.cites}
                     and is_earlier(item)]

    def _save(self, material_id: str, judged: Judged | None, *, checked: bool) -> None:
        stored = self._store.evidence([material_id]).get(material_id)
        evidence = stored or Evidence(material_id, "not_checked", None)
        if judged is not None:
            evidence.judged[judged.key] = judged
        if checked:
            evidence.status, evidence.checked_at = "checked", datetime.now(UTC)
        self._store.save(evidence)

    async def _stop(self, check_id: str, reason: KbStopReason, plans: list[_Plan],
                    finished: list[str]) -> None:
        jobs = self._job_store()
        pending = [plan.material_id for plan in plans if plan.material_id not in finished]
        await disk_call(jobs.checkpoint, check_id, stage="repeats", cursor=pending[0] if pending else None,
                        completed_ids=finished, pending_ids=pending)
        await disk_call(jobs.stop, check_id, reason)

    async def _run(self, check_id: str, area_id: str, live: _Live) -> None:
        jobs = self._job_store()
        job = await disk_call(jobs.get, check_id)
        if job is None:
            return
        # A budget stop starts the next batch; any other stop goes on with the batch it interrupted.
        next_batch = job.stop_reason == "budget"
        used = 0 if next_batch else job.budget.used
        batch = job.budget.batch + (1 if next_batch else 0)
        total = job.budget.total_used
        counters = job.counters
        done_here: list[str] = []
        plans = await disk_call(self._plan, area_id)
        run = await disk_call(self._store.run, check_id)
        already = run.materials_checked if run else 0
        statements_left = sum(len(plan.statements) for plan in plans)
        counters = counters.model_copy(update={"after_rules": counters.checked + statements_left})

        def budget() -> KbRunBudget:
            return KbRunBudget(unit="claim_comparison", limit=self._limit, used=used,
                               remaining=self._limit - used, total_used=total, batch=batch, free_only=False)

        job = await disk_call(jobs.progress, check_id, stage="repeats", budget=budget(), counters=counters)
        await disk_call(self._store.set_run, check_id, checked=already, remaining=len(plans))
        layer = self._decisions()
        if layer is None and any(plan.statements for plan in plans):
            await self._stop(check_id, "decision_model_required", plans, done_here)
            return
        completed = set(await disk_call(jobs.completed, check_id, "repeats"))
        held: list[tuple[str, Judged]] = []

        for plan in plans:
            for page_id, block_id in plan.statements:
                candidate = _candidate_id(page_id, block_id)
                if candidate in completed:
                    continue
                if live.pause:
                    await self._flush(check_id, held)
                    await self._stop(check_id, "user_pause", plans, done_here)
                    return
                if used >= self._limit:
                    await self._flush(check_id, held)
                    await self._stop(check_id, "budget", plans, done_here)
                    return
                statement, others = await disk_call(self._statement, page_id, block_id, plan.material_id)
                if statement is None:
                    continue  # the page changed under us: nothing to compare any more
                if others and layer is not None:
                    used += 1
                    total += 1
                    outcome = await compare(layer, statement, others)
                else:
                    outcome = Judged(page_id, block_id, text_hash(statement.text), "new")
                if isinstance(outcome, Unanswered):
                    unsure = Judged(page_id, block_id, text_hash(statement.text), "unsure")
                    held.append((plan.material_id, unsure))
                    if len(held) >= OUTAGE_STREAK:
                        # Down, not undecided: nothing is recorded, so Continue asks these again.
                        await self._stop(check_id, "provider_unavailable", plans, done_here)
                        return
                else:
                    await self._flush(check_id, held)
                    held = []
                    await self._record(check_id, plan.material_id, outcome)
                    completed.add(candidate)
                    counters = _count(counters, outcome)
                job = await disk_call(jobs.progress, check_id, stage="repeats", budget=budget(),
                                      counters=counters)
            await self._flush(check_id, held)
            held = []
            await disk_call(self._save, plan.material_id, None, checked=True)
            done_here.append(plan.material_id)
            await disk_call(self._store.set_run, check_id, checked=already + len(done_here),
                            remaining=len(plans) - len(done_here))
            pending = [p.material_id for p in plans if p.material_id not in done_here]
            await disk_call(jobs.checkpoint, check_id, stage="repeats",
                            cursor=pending[0] if pending else None,
                            completed_ids=done_here, pending_ids=pending)
        await disk_call(jobs.stop, check_id, "completed")

    async def _record(self, check_id: str, material_id: str, judged: Judged) -> None:
        jobs = self._job_store()
        await disk_call(self._save, material_id, judged, checked=False)
        await disk_call(jobs.complete, check_id, _candidate_id(judged.page_id, judged.block_id), "repeats",
                        json.dumps({"verdict": judged.verdict}))

    async def _flush(self, check_id: str, held: list[tuple[str, Judged]]) -> None:
        """Answers that were "unsure" before a real answer came: they are verdicts after all."""
        for material_id, judged in held:
            await self._record(check_id, material_id, judged)
        held.clear()


def _count(counters: KbRunCounters, judged: Judged) -> KbRunCounters:
    return counters.model_copy(update={
        "checked": counters.checked + 1,
        "decided": counters.decided + (judged.verdict != "unsure"),
        "new": counters.new + (judged.verdict == "new"),
        "covered": counters.covered + (judged.verdict == "repeat"),
    })
