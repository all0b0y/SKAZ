"""``runtime.kb_explore``: the funnel (``ExploreService`` + ``FunnelRunner``), 0.4.0 B2.

Stages (v3 "step N of 5"): collect → rules → decision → novelty → ready.

* collect — Continues (works citing the user's sources), Branches (shared roots / a neighbouring topic),
  Search (the search line's text as a topic, or the area's topics). Only topics, DOIs and ids leave.
* rules — in code, free (``rules.py``).
* decision — the decision model places each work in an area or calls it off-topic. With no model chosen
  the run pauses with ``decision_model_required`` and both choices; never a silent fallback.
* novelty — theses against the wiki, ``NOVELTY_BATCH`` works per agent run, 30 works per budget batch;
  reaching the limit pauses with ``budget``. ``free_only`` runs never get here.
* ready — paid works that are worth it get their one-time access check; the run finishes.

Every finished unit is recorded through ``JobStore.complete`` before the next starts, and every counter is
recomputed from those records, so pause, crash or Quit never repeat work or miscount it. Logs carry ids
and states only.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from collections.abc import Awaitable, Callable, Mapping, Sequence
from datetime import UTC, date, datetime
from typing import Any, Literal, Protocol, TypeVar, cast

from ...native_io import disk_call
from ..agents.prompting import untrusted_block
from ..api.contract_routes import ContractFailure
from ..api.schemas_areas import KbReadMark, KbSignalEntity
from ..api.schemas_explore import (
    KbExploreStart,
    KbExploring,
    KbExploringList,
    KbFinding,
    KbFindingChannel,
    KbFindingGroup,
    KbFindingImport,
    KbFindingImported,
    KbFindings,
    KbFunnelRun,
    KbFunnelStart,
    KbThesis,
)
from ..api.schemas_explore_common import (
    KbContinue,
    KbDateWindow,
    KbExploreJob,
    KbJobOwner,
    KbJobs,
    KbJobSummary,
    KbMaterialRef,
    KbPublicationDate,
    KbReadMarkValue,
    KbRunBudget,
    KbRunCounters,
    KbRunStage,
    KbStopReason,
)
from ..api.schemas_science import KbSciencePayload, KbScienceResults, KbScienceSearch, KbScienceWork
from ..areas.protocols import AreaDirectory, SignalDraft, SignalRecorder
from ..decisions.protocol import ChoiceAnswer, ChoiceQuestion, DecisionLayer
from ..errors import KnowledgeError, NotFound
from ..freshness.protocols import PublicationDates
from ..permissions.search_rules import ActiveRules
from ..science.protocols import (
    ScienceClient,
    ScienceConsentRequired,
    ScienceDailyLimit,
    ScienceRef,
    ScienceStop,
    ScienceUnavailable,
)
from ..service import KnowledgeService
from .jobs import STATE_OF, SqliteJobStore
from .novelty import (
    NoveltyUnavailable,
    WikiClaims,
    finding_label,
    finding_refs,
    reason_for,
    work_state,
)
from .protocols import NoveltyChecker
from .reading import ReadingDesk
from .rules import (
    Seed,
    blocked_by_rules,
    continues_since,
    default_window,
    in_library,
    in_window,
    seed_of,
)
from .store import ExploreStore, FindingRow, RunRow

logger = logging.getLogger(__name__)
T = TypeVar("T")

BUDGET_LIMIT = 30
#: Works per agent run of the novelty check ("one model call per batch").
NOVELTY_BATCH = 5
#: Questions per ``ask_many`` of the decision model.
DECISION_BATCH = 10
#: Library sources resolved per run as Continues/Branches seeds (one ids-only request each).
SEED_LIMIT = 10
CHANNEL_LIMIT = 50
OFF_TOPIC = "None of these: off-topic"
ON_TOPIC = "On topic"
_CHANNEL_ORDER: dict[str, int] = {"continues": 0, "branches": 1, "search": 2}
_USEFUL = frozenset({"new", "extends", "contradicts"})
_RUN_OWNERS: tuple[KbJobOwner, ...] = ("explore", "research")
_VERDICT_OWNERS: tuple[KbJobOwner, ...] = ("explore", "research", "weekly")
_COLLECT_DONE = "@collect"
_LOCAL_USER = KbSignalEntity(kind="user", id="local-user")
DecisionChoice = Literal["download_local", "openrouter_jev"]


class Deciders(Protocol):
    """The decision layer the user chose (``knowledge/decisions``)."""

    def layer(self) -> DecisionLayer | None: ...
    def ready(self) -> bool: ...
    async def choose(self, choice: DecisionChoice) -> bool:
        """The user's answer to ``decision_model_required``; ``True`` when the chosen layer can answer now."""
        ...


class _Refused(Exception):
    """The very first science request of a new run met the consent gate: the run is undone, 403."""


class _Conflict(KnowledgeError):
    status_code = 409


def _now() -> datetime:
    return datetime.now(UTC)


def _dump(model: Any) -> dict[str, Any]:
    return cast(dict[str, Any], model.model_dump(mode="json"))


def _json(data: Mapping[str, Any]) -> str:
    return json.dumps(dict(data), ensure_ascii=False, separators=(",", ":"))


class ExploreFunnel:
    """Implements ``ExploreService`` and ``FunnelRunner``; ``jobs`` is the shared ``JobStore``.

    ``science`` stays ``None`` until B1's client is wired (``runtime.kb_explore.science = …``); until
    then everything that would reach a science base answers ``not_ready``.
    """

    def __init__(
        self,
        kb: KnowledgeService,
        jobs: SqliteJobStore,
        *,
        directory: AreaDirectory,
        recorder: SignalRecorder,
        finding_mark: Callable[[str], KbReadMark],
        publication_dates: PublicationDates,
        deciders: Deciders,
        novelty: NoveltyChecker,
        claims: WikiClaims,
        search_rules: Callable[[], ActiveRules | None],
        reading: ReadingDesk,
        science: ScienceClient | None = None,
        today: Callable[[], date] = lambda: datetime.now(UTC).date(),
    ) -> None:
        self.kb = kb
        self.job_store = jobs
        self.store = ExploreStore(kb.db)
        self.science = science
        self.directory = directory
        self.recorder = recorder
        self._finding_mark = finding_mark
        self.publication_dates = publication_dates
        self.deciders = deciders
        self.novelty = novelty
        self.claims = claims
        self.search_rules = search_rules
        self.reading = reading
        self._today = today
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._gates: dict[str, asyncio.Future[bool]] = {}

    # -- readiness ------------------------------------------------------------------------------------

    def _ensure_ready(self) -> None:
        if self.kb.view().state == "not_configured":
            raise ContractFailure(503, "not_ready")

    def _client(self) -> ScienceClient:
        if self.science is None:
            raise ContractFailure(503, "not_ready")
        return self.science

    # -- ExploreService / FunnelRunner: runs -------------------------------------------------------

    async def start(self, body: KbFunnelStart, *, free_only: bool = False) -> KbFunnelRun:
        return await self._start("explore", None, None, body, free_only=free_only)

    async def start_for_task(
        self, task_id: str, title: str, body: KbFunnelStart, *, free_only: bool = False
    ) -> KbFunnelRun:
        return await self._start("research", task_id, title, body, free_only=free_only)

    async def run(self, run_id: str) -> KbFunnelRun:
        self._ensure_ready()
        return await disk_call(self._snapshot, run_id)

    async def pause(self, run_id: str) -> KbFunnelRun:
        self._ensure_ready()
        job = await disk_call(self._job, run_id)
        if job.state not in ("running", "queued"):
            raise _Conflict("This run is not running.")
        await self._halt(run_id)
        job = await disk_call(self._job, run_id)
        if job.state in ("running", "queued"):
            await self._stop(run_id, "user_pause")
        return await disk_call(self._snapshot, run_id)

    async def resume(self, run_id: str, body: KbContinue) -> KbFunnelRun:
        self._ensure_ready()
        job = await disk_call(self._job, run_id)
        checkpoint = job.checkpoint
        if job.state != "paused" or checkpoint is None:
            raise _Conflict("Only a paused run can continue.")
        if (checkpoint.id, checkpoint.revision) != (body.checkpoint_id, body.revision):
            raise _Conflict("This run changed since; reload it.")
        self._client()
        budget = job.budget
        if job.stop_reason == "budget":
            budget = KbRunBudget(
                unit="candidate",
                limit=BUDGET_LIMIT,
                used=0,
                remaining=BUDGET_LIMIT,
                total_used=budget.total_used,
                batch=budget.batch + 1,
                free_only=budget.free_only,
            )
        await disk_call(
            self.job_store.progress, run_id, stage=job.stage, budget=budget, counters=job.counters
        )
        self._spawn(
            run_id, choice=body.decision_choice if job.stop_reason == "decision_model_required" else None
        )
        return await disk_call(self._snapshot, run_id)

    async def cancel(self, run_id: str) -> KbFunnelRun:
        self._ensure_ready()
        job = await disk_call(self._job, run_id)
        if job.state in ("done", "cancelled", "error"):
            raise _Conflict("This run has already finished.")
        await self._halt(run_id)
        await disk_call(self.job_store.stop, run_id, "cancelled")
        return await disk_call(self._snapshot, run_id)

    async def jobs(self, active: bool = True) -> KbJobs:
        """Active jobs of every owner (Explore progress line, tray status), or the latest ones."""
        self._ensure_ready()
        return await disk_call(self._summaries, active)

    async def waiting(self, run_id: str) -> list[str]:
        """B6: works a ``free_only`` run left for "Check novelty" (a new run takes them as candidates)."""
        await disk_call(self._job, run_id)
        return await disk_call(self._waiting, run_id)

    async def settled(self, run_id: str) -> KbFunnelRun:
        """Wait until the background work of a run has stopped (tests, B3's final summary)."""
        task = self._tasks.get(run_id)
        if task is not None:
            with contextlib.suppress(asyncio.CancelledError):
                await asyncio.shield(task)
        return await disk_call(self._snapshot, run_id)

    # -- findings --------------------------------------------------------------------------------------

    async def findings(
        self,
        area_id: str | None = None,
        task_id: str | None = None,
        include_covered: bool = False,
        cursor: str | None = None,
        limit: int = 30,
    ) -> KbFindings:
        self._ensure_ready()
        offset = _offset(cursor)
        return await disk_call(
            self._findings, area_id, task_id, include_covered, offset, max(1, min(limit, 100))
        )

    async def finding(self, finding_id: str) -> KbFinding:
        self._ensure_ready()
        row = await disk_call(self._finding_row, finding_id)
        return (await disk_call(self._findings_of, [row]))[0]

    def new_by_area(self) -> dict[str, int]:
        """Blocking: findings not yet in the library, per area (B4's tile count)."""
        return self.store.new_by_area()

    async def explore(self, finding_id: str, body: KbExploreStart) -> KbExploring:
        self._ensure_ready()
        finding = await self.finding(finding_id)
        return await self.reading.explore(finding, body, self._client())

    async def add_to_wiki(self, finding_id: str, body: KbFindingImport) -> KbFindingImported:
        self._ensure_ready()
        finding = await self.finding(finding_id)
        return await self.reading.add_to_wiki(finding, body, self._client())

    async def exploring(self) -> KbExploringList:
        self._ensure_ready()
        return await self.reading.list()

    # -- lifecycle -------------------------------------------------------------------------------------

    async def on_start(self) -> list[str]:
        """App start: runs paused by Quit (``app_exit``, set by ``JobStore.recover``) go on by themselves with
        their free steps only (user decision B2-7 A): collecting, rules, and decisions with a local model. A
        paid step (cloud decisions, novelty, paid access checks) never starts without the user — the run
        pauses again with ``app_exit`` and waits for Continue."""
        if self.science is None or self.kb.view().state == "not_configured":
            return []
        resumed: list[str] = []
        for job in await disk_call(self.job_store.active):
            if (
                job.owner in _RUN_OWNERS
                and job.stop_reason == "app_exit"
                and await disk_call(self.store.run, job.id) is not None
            ):
                await disk_call(
                    self.job_store.progress, job.id, stage=job.stage, budget=job.budget, counters=job.counters
                )
                self._spawn(job.id, free_steps_only=True)
                resumed.append(job.id)
        return resumed

    async def aclose(self) -> None:
        """Quit: running runs pause with ``app_exit`` (they resume next launch)."""
        for run_id in list(self._tasks):
            await self._halt(run_id)
            with contextlib.suppress(KnowledgeError):
                job = await disk_call(self._job, run_id)
                if job.state == "running":
                    await self._stop(run_id, "app_exit")

    # -- start ------------------------------------------------------------------------------------------

    async def _start(
        self,
        owner: KbJobOwner,
        task_id: str | None,
        title: str | None,
        body: KbFunnelStart,
        *,
        free_only: bool,
    ) -> KbFunnelRun:
        self._ensure_ready()
        self._client()
        area_path: Sequence[str] = ()
        if body.area_id is not None:
            area_path = await disk_call(self.directory.area_path, body.area_id)
            if not area_path:
                raise NotFound("This area wasn't found.")
        options = await disk_call(self._area_options, body.area_id)
        name = (
            title
            or body.query
            or (area_path[-1] if area_path else None)
            or ("Check novelty" if body.candidate_ids else "Find what's new")
        )
        budget = KbRunBudget(
            unit="candidate",
            limit=BUDGET_LIMIT,
            used=0,
            remaining=BUDGET_LIMIT,
            total_used=0,
            batch=1,
            free_only=free_only,
        )
        job = await disk_call(self.job_store.create, owner, name, "collect", budget)
        request = {
            **body.model_dump(mode="json"),
            "free_only": free_only,
            "area_options": options,
            "today": self._today().isoformat(),
        }
        await disk_call(self.store.create_run, job.id, area_id=body.area_id, task_id=task_id, request=request)
        if owner == "research":
            await self._task_signal(job.id, "research_started")
        gate: asyncio.Future[bool] = asyncio.get_running_loop().create_future()
        self._gates[job.id] = gate
        task = self._spawn(job.id)
        try:
            waits: set[asyncio.Future[Any]] = {gate, task}
            await asyncio.wait(waits, return_when=asyncio.FIRST_COMPLETED)
        finally:
            self._gates.pop(job.id, None)
        if gate.done() and gate.result() is False:
            with contextlib.suppress(asyncio.CancelledError):
                await task
            await disk_call(self.job_store.delete, job.id)
            raise ContractFailure(403, "consent_required")
        gate.cancel()
        return await disk_call(self._snapshot, job.id)

    def _area_options(self, area_id: str | None) -> list[str]:
        """Areas the decision model may choose from: the run's area, else pinned and recently active ones."""
        if area_id is not None:
            return [area_id]
        chosen = [*self.directory.pinned(), *self.directory.recently_active(limit=8)]
        return list(dict.fromkeys(chosen))[:8]

    # -- the driver ------------------------------------------------------------------------------------

    def _spawn(
        self, run_id: str, *, choice: DecisionChoice | None = None, free_steps_only: bool = False
    ) -> asyncio.Task[None]:
        task = asyncio.get_running_loop().create_task(
            self._drive(run_id, choice, free_steps_only=free_steps_only), name=f"explore-{run_id}"
        )
        self._tasks[run_id] = task
        task.add_done_callback(
            lambda done: self._tasks.pop(run_id, None) if self._tasks.get(run_id) is done else None
        )
        return task

    async def _halt(self, run_id: str) -> None:
        task = self._tasks.get(run_id)
        if task is None or task.done():
            return
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task

    async def _drive(
        self, run_id: str, choice: DecisionChoice | None, *, free_steps_only: bool = False
    ) -> None:
        try:
            run = await disk_call(self._run_row, run_id)
            await self._collect(run)
            await self._rules(run)
            if not await self._decide(run, choice, free_steps_only=free_steps_only):
                return
            if run.request.get("free_only"):
                await self._finish(run)
                return
            if free_steps_only:  # resumed after Quit: the paid steps wait for the user's Continue
                await self._stop(run_id, "app_exit")
                return
            if not await self._novelty(run):
                return
            await self._enrich(run)
            await self._finish(run)
        except _Refused:
            return
        except asyncio.CancelledError:
            raise
        except ScienceStop as stop:
            retry = stop.retry_at.isoformat() if stop.retry_at is not None else None
            await self._stop(run_id, stop.stop_reason, retry_at=retry)
        except NoveltyUnavailable:
            await self._stop(run_id, "provider_unavailable")
        except Exception as error:
            logger.error("Explore run %s failed: %s", run_id, type(error).__name__)
            with contextlib.suppress(Exception):
                await self._stop(run_id, "failed")

    async def _science(self, run_id: str, call: Awaitable[T]) -> T:
        """Every science request goes through here: the first answer of a new run opens its gate."""
        gate = self._gates.get(run_id)
        try:
            result = await call
        except ScienceConsentRequired as error:
            if gate is not None and not gate.done():
                gate.set_result(False)
                raise _Refused() from error
            raise
        if gate is not None and not gate.done():
            gate.set_result(True)
        return result

    async def _stop(self, run_id: str, reason: KbStopReason, *, retry_at: str | None = None) -> None:
        job = await disk_call(self._job, run_id)
        completed, pending = await disk_call(self._progress_ids, run_id, job.stage)
        await disk_call(
            self.job_store.checkpoint,
            run_id,
            stage=job.stage,
            cursor=pending[0] if pending else None,
            completed_ids=completed,
            pending_ids=pending,
        )
        await disk_call(self.job_store.stop, run_id, reason, retry_at=retry_at)
        if STATE_OF[reason] == "paused" and reason != "app_exit":
            await self._task_signal(run_id, "research_paused")

    async def _progress(
        self, run: RunRow, stage: KbRunStage, budget: KbRunBudget | None = None
    ) -> KbExploreJob:
        job = await disk_call(self._job, run.id)
        counters = await disk_call(self._counters, run.id)
        return await disk_call(
            self.job_store.progress, run.id, stage=stage, budget=budget or job.budget, counters=counters
        )

    # -- stage 1: collect --------------------------------------------------------------------------------

    async def _collect(self, run: RunRow) -> None:
        done = set(await disk_call(self.job_store.completed, run.id, "collect"))
        if _COLLECT_DONE in done:
            return
        await self._progress(run, "collect")
        request = run.request
        science = self._client()
        window = _window(request)
        if request.get("candidate_ids"):
            await self._collect_ids(run, list(request["candidate_ids"]), done)
        else:
            channels = list(request.get("channels") or ())
            seeds: list[tuple[Seed, KbScienceWork]] = []
            if {"continues", "branches"} & set(channels):
                seeds = await self._seeds(run, done)
            topics = await disk_call(self.directory.topics, run.area_id) if run.area_id else ()
            today = date.fromisoformat(str(request.get("today") or self._today().isoformat()))
            for channel in sorted(channels, key=lambda item: _CHANNEL_ORDER.get(item, 9)):
                marker = f"@channel:{channel}"
                if marker in done:
                    continue
                results: KbScienceResults | None = None
                if channel == "continues" and seeds:
                    published = await disk_call(
                        self.publication_dates.dates, [seed.material_id for seed, _ in seeds]
                    )
                    since = (
                        window.from_date
                        if window is not None
                        else continues_since([seed for seed, _ in seeds], published, today)
                    )
                    results = await self._science(
                        run.id, science.citing([work.id for _, work in seeds], since=since, run_id=run.id)
                    )
                elif channel == "branches" and (seeds or topics):
                    seed_topics = (
                        topics or list(dict.fromkeys(t for _, work in seeds for t in work.topic_ids))[:30]
                    )
                    since = (window or default_window(today)).from_date
                    results = await self._science(
                        run.id,
                        science.neighbours(
                            [work.id for _, work in seeds], seed_topics, since=since, run_id=run.id
                        ),
                    )
                elif channel == "search" and (request.get("query") or topics):
                    query = str(request.get("query") or "").strip()
                    payload = KbSciencePayload(topics=[query] if query else list(topics)[:30])
                    search = KbScienceSearch(
                        payload=payload, dates=window or default_window(today), limit=CHANNEL_LIMIT
                    )
                    results = await self._science(run.id, science.search(search, run_id=run.id))
                if results is not None:
                    await disk_call(
                        self._record_works,
                        run.id,
                        cast(KbFindingChannel, channel),
                        results.works,
                        seeds,
                        done,
                    )
                    _raise_partial(results)
                await disk_call(self.job_store.complete, run.id, marker, "collect", "{}")
                done.add(marker)
                await self._progress(run, "collect")
        await disk_call(self.job_store.complete, run.id, _COLLECT_DONE, "collect", "{}")
        await self._progress(run, "collect")

    async def _collect_ids(self, run: RunRow, ids: list[str], done: set[str]) -> None:
        """ "Check novelty" on candidates a free run left waiting: their works are already known here."""
        missing: list[str] = []
        for work_id in ids:
            if work_id in done:
                continue
            earlier = await disk_call(
                self.job_store.earlier_result, work_id, "collect", owners=_VERDICT_OWNERS, exclude_job=run.id
            )
            if earlier is not None:
                await disk_call(self.job_store.complete, run.id, work_id, "collect", earlier)
                done.add(work_id)
            else:
                missing.append(work_id)
        if missing:
            search = KbScienceSearch(payload=KbSciencePayload(ids=missing[:30]), limit=min(100, len(missing)))
            results = await self._science(run.id, self._client().search(search, run_id=run.id))
            await disk_call(self._record_works, run.id, "search", results.works, [], done)
            _raise_partial(results)

    async def _seeds(self, run: RunRow, done: set[str]) -> list[tuple[Seed, KbScienceWork]]:
        seeds = await disk_call(self._seed_sources, run.area_id)
        found: list[tuple[Seed, KbScienceWork]] = []
        for seed in seeds:
            key = f"@seed:{seed.material_id}"
            if key in done:
                raw = await disk_call(self.job_store.result, run.id, key, "collect")
                stored = json.loads(raw or "{}")
                if stored.get("work"):
                    found.append((seed, KbScienceWork.model_validate(stored["work"])))
                continue
            ref = ScienceRef(material_id=seed.material_id, doi=seed.doi, arxiv_id=seed.arxiv_id)
            work = await self._science(run.id, self._client().resolve(ref, run_id=run.id))
            await disk_call(
                self.job_store.complete,
                run.id,
                key,
                "collect",
                _json({"work": _dump(work) if work is not None else None}),
            )
            done.add(key)
            if work is not None:
                found.append((seed, work))
        return found

    def _seed_sources(self, area_id: str | None) -> list[Seed]:
        if area_id is not None:
            records = [
                r for mid in self.directory.materials(area_id) if (r := self.kb.material_repo.get(mid))
            ]
        else:
            records = self.kb.material_repo.list_all()
        records.sort(key=lambda record: (record.created_at, record.id), reverse=True)
        seeds = [seed for record in records if (seed := seed_of(record)) is not None]
        return seeds[:SEED_LIMIT]

    def _record_works(
        self,
        run_id: str,
        channel: KbFindingChannel,
        works: Sequence[KbScienceWork],
        seeds: Sequence[tuple[Seed, KbScienceWork]],
        done: set[str],
    ) -> None:
        seed_ids = {key: seed for seed, work in seeds for key in (work.id, work.provider_id)}
        roots = {ref for _, work in seeds for ref in work.referenced_ids}
        own = {work.id for _, work in seeds}
        for work in works[:CHANNEL_LIMIT]:
            if work.id in done or work.id in own:
                continue
            cites = list(
                {
                    seed_ids[ref].material_id: seed_ids[ref] for ref in work.referenced_ids if ref in seed_ids
                }.values()
            )
            data = {
                "channel": channel,
                "work": _dump(work),
                "cites": [{"material_id": seed.material_id, "title": seed.title} for seed in cites],
                "shared": len(roots & set(work.referenced_ids)) if channel == "branches" else 0,
            }
            self.job_store.complete(run_id, work.id, "collect", _json(data))
            done.add(work.id)

    # -- stage 2: rules ---------------------------------------------------------------------------------

    async def _rules(self, run: RunRow) -> None:
        await self._progress(run, "rules")
        await disk_call(self._apply_rules, run)
        await self._progress(run, "rules")

    def _apply_rules(self, run: RunRow) -> None:
        collected = self._candidates(run.id)
        ruled = set(self.job_store.completed(run.id, "rules"))
        pending = [cid for cid in collected if cid not in ruled]
        if not pending:
            return
        found_before = self.store.found_work_ids(pending, task_id=run.task_id)
        explicit = run.request.get("dates") is not None
        window = _window(run.request)
        today = date.fromisoformat(str(run.request.get("today") or self._today().isoformat()))
        rules = self.search_rules()
        for cid in pending:
            data = collected[cid]
            work = KbScienceWork.model_validate(data["work"])
            material_id = None
            reason: str | None = None
            if cid in found_before:
                reason = "found_before"
            elif (material_id := in_library(self.kb, work)) is not None:
                reason = "in_library"
            elif (
                data["channel"] != "continues"
                and not in_window(work, window or default_window(today), explicit=explicit)
            ) or (explicit and not in_window(work, window, explicit=True)):
                reason = "outside_dates"
            elif blocked_by_rules(work, rules):
                reason = "search_rules"
            self.job_store.complete(
                run.id,
                cid,
                "rules",
                _json({"kept": reason is None, "reason": reason, "material_id": material_id}),
            )

    # -- stage 3: decision ------------------------------------------------------------------------------

    async def _decide(
        self, run: RunRow, choice: DecisionChoice | None, *, free_steps_only: bool = False
    ) -> bool:
        pending = await disk_call(self._pending_decisions, run.id)
        if not pending:
            return True
        await self._progress(run, "decision")
        free_only = bool(run.request.get("free_only")) or free_steps_only
        if choice is not None and not free_only and not await self.deciders.choose(choice):
            await self._stop(run.id, "decision_model_required")
            return False
        layer = self.deciders.layer() if self.deciders.ready() else None
        if free_only and (layer is None or layer.id != "local"):
            return True  # free steps only: the works wait undecided for "Check novelty"
        if layer is None:
            await self._stop(run.id, "decision_model_required")
            return False
        await disk_call(self.job_store.set_decision_provider, run.id, layer.id)
        options = await disk_call(self._option_labels, run)
        collected = await disk_call(self._candidates, run.id)
        for start in range(0, len(pending), DECISION_BATCH):
            chunk = pending[start : start + DECISION_BATCH]
            asked: list[str] = []
            for cid in chunk:
                earlier = await disk_call(
                    self.job_store.earlier_result, cid, "decision", owners=_VERDICT_OWNERS, exclude_job=run.id
                )
                reused = json.loads(earlier) if earlier else None
                if reused is not None and (
                    not reused.get("on_topic")
                    or reused.get("area_id") in options.values()
                    or not run.request.get("area_options")
                ):
                    await disk_call(
                        self.job_store.complete, run.id, cid, "decision", _json({**reused, "reused": True})
                    )
                else:
                    asked.append(cid)
            if asked:
                works = [KbScienceWork.model_validate(collected[cid]["work"]) for cid in asked]
                labels = [await disk_call(self._labels_for, work, options) for work in works]
                questions = [
                    ChoiceQuestion(
                        state=untrusted_block("work", work_state(work)),
                        question=_DECISION_QUESTION,
                        options=[*label_map, OFF_TOPIC],
                    )
                    for work, label_map in zip(works, labels, strict=True)
                ]
                answers = await layer.ask_many(questions)
                for cid, label_map, answer in zip(asked, labels, answers, strict=True):
                    if (
                        isinstance(answer, ChoiceAnswer)
                        and answer.option != OFF_TOPIC
                        and answer.option in label_map
                    ):
                        verdict = {"on_topic": True, "area_id": label_map[answer.option], "reason": "decided"}
                    elif isinstance(answer, ChoiceAnswer):
                        verdict = {"on_topic": False, "area_id": None, "reason": "off_topic"}
                    else:
                        verdict = {"on_topic": False, "area_id": None, "reason": "undecided"}
                    await disk_call(self.job_store.complete, run.id, cid, "decision", _json(verdict))
            await self._progress(run, "decision")
        return True

    def _option_labels(self, run: RunRow) -> dict[str, str | None]:
        """label → area id for the run's areas (names made unique by their path)."""
        labels: dict[str, str | None] = {}
        for area_id in run.request.get("area_options") or ():
            path = list(self.directory.area_path(area_id))
            if not path:
                continue
            label = path[-1] if path[-1] not in labels else " › ".join(path)
            labels[label] = area_id
        if not labels:
            labels[ON_TOPIC] = run.area_id
        return labels

    def _labels_for(self, work: KbScienceWork, options: Mapping[str, str | None]) -> dict[str, str | None]:
        """The run's options plus the area the work's own topics point to (science works carry them)."""
        labels = dict(options)
        hint = self.directory.area_for_topics(work.topic_ids) if work.topic_ids else None
        if hint is not None and hint not in labels.values():
            path = list(self.directory.area_path(hint))
            if path:
                labels = {(path[-1] if path[-1] not in labels else " › ".join(path)): hint, **labels}
                labels.pop(ON_TOPIC, None)
        return labels

    def _pending_decisions(self, run_id: str) -> list[str]:
        decided = set(self.job_store.completed(run_id, "decision"))
        return [cid for cid in self._kept(run_id) if cid not in decided]

    # -- stage 4: novelty -------------------------------------------------------------------------------

    async def _novelty(self, run: RunRow) -> bool:
        job = await self._progress(run, "novelty")
        budget = job.budget
        pending = await disk_call(self._pending_novelty, run.id)
        pending = [cid for cid in pending if not await disk_call(self._reuse_novelty, run, cid)]
        await self._progress(run, "novelty")
        collected = await disk_call(self._candidates, run.id)
        while pending:
            if budget.remaining == 0:
                await self._stop(run.id, "budget")
                return False
            batch = pending[: min(NOVELTY_BATCH, budget.remaining)]
            works = [KbScienceWork.model_validate(collected[cid]["work"]) for cid in batch]
            theses = await self.novelty.check(works)
            for cid, work, found in zip(batch, works, theses, strict=True):
                await disk_call(self._record_novelty, run, cid, work, list(found), False)
            used = budget.used + len(batch)
            budget = KbRunBudget(
                unit="candidate",
                limit=budget.limit,
                used=used,
                remaining=budget.limit - used,
                total_used=budget.total_used + len(batch),
                batch=budget.batch,
                free_only=budget.free_only,
            )
            await self._progress(run, "novelty", budget)
            pending = pending[len(batch) :]
        return True

    def _pending_novelty(self, run_id: str) -> list[str]:
        done = set(self.job_store.completed(run_id, "novelty"))
        decisions = {cid: json.loads(raw) for cid, raw in self.job_store.results(run_id, "decision").items()}
        collected = self._candidates(run_id)
        on_topic = [cid for cid, verdict in decisions.items() if verdict.get("on_topic") and cid not in done]
        return sorted(
            on_topic,
            key=lambda cid: (
                _CHANNEL_ORDER.get(collected[cid]["channel"], 9),
                -int(collected[cid]["work"].get("cited_by_count") or 0),
            ),
        )

    def _reuse_novelty(self, run: RunRow, cid: str) -> bool:
        """Open question 4: an earlier verdict on the same work stands unless a page it cited changed."""
        earlier = self.job_store.earlier_result(cid, "novelty", owners=_VERDICT_OWNERS, exclude_job=run.id)
        if earlier is None:
            return False
        verdict = json.loads(earlier)
        pages: dict[str, str] = verdict.get("pages") or {}
        if verdict.get("label") is None or self.claims.fingerprints(list(pages)) != pages:
            return False
        work = KbScienceWork.model_validate(self._candidates(run.id)[cid]["work"])
        theses = [KbThesis.model_validate(item) for item in verdict.get("theses") or ()]
        self._record_novelty(run, cid, work, theses, True)
        return True

    def _record_novelty(
        self, run: RunRow, cid: str, work: KbScienceWork, theses: list[KbThesis], reused: bool
    ) -> None:
        data = self._candidates(run.id)[cid]
        channel = cast(KbFindingChannel, data["channel"])
        label = finding_label(theses, channel)
        refs = finding_refs(theses)
        finding_id = None
        if label is not None:
            area_id = json.loads(self.job_store.result(run.id, cid, "decision") or "{}").get("area_id")
            covered = sum(1 for thesis in theses if thesis.label == "covered")
            details = {
                "work": _dump(work),
                "area_path": list(self.directory.area_path(area_id)) if area_id else [],
                "wiki_refs": [_dump(ref) for ref in refs],
                "cites_materials": data.get("cites") or [],
                "shared_source_count": int(data.get("shared") or 0),
                "repeat_hint": (
                    f"{covered} of {len(theses)} points repeat your wiki — Brief tour will skip them"
                    if 0 < covered < len(theses)
                    else None
                ),
                "text_available": "unchecked",
            }
            finding_id = self.store.add_finding(
                run_id=run.id,
                task_id=run.task_id,
                area_id=area_id,
                work_id=work.id,
                channel=channel,
                label=label,
                reason=reason_for(label, refs),
                theses=[_dump(t) for t in theses],
                details=details,
            )
        verdict = {
            "label": label,
            "theses": [_dump(t) for t in theses],
            "finding_id": finding_id,
            "pages": self.claims.fingerprints([ref.page_id for ref in refs]),
            "reused": reused,
        }
        self.job_store.complete(run.id, cid, "novelty", _json(verdict))

    # -- stage 5: ready ---------------------------------------------------------------------------------

    async def _enrich(self, run: RunRow) -> None:
        """Paid works worth reading get B1's one-time check for a free copy (decision 3c″)."""
        await self._progress(run, "ready")
        done = set(await disk_call(self.job_store.completed, run.id, "ready"))
        for row in await disk_call(self.store.run_findings, run.id):
            work = KbScienceWork.model_validate(row.details["work"])
            if row.id in done or row.label not in _USEFUL or not work.access.paid:
                continue
            access = await self._science(
                run.id, self._client().paid_access(work, useful_because=row.reason, run_id=run.id)
            )
            await disk_call(
                self.store.update_details, row.id, {"work": {**row.details["work"], "access": _dump(access)}}
            )
            await disk_call(self.job_store.complete, run.id, row.id, "ready", "{}")

    async def _finish(self, run: RunRow) -> None:
        await self._progress(run, "ready")
        job = await disk_call(self.job_store.stop, run.id, "completed")
        owner = job.owner
        if owner == "explore" and not run.request.get("free_only"):
            counters = job.counters
            await disk_call(
                self.kb.notify,
                "explore_finished",
                "Search finished",
                body=f"{counters.new} new · {counters.covered} repeat what you have",
                payload={"job_id": run.id, "task_id": run.task_id, "area_id": run.area_id},
            )
        await self._task_signal(run.id, "research_completed")

    async def _task_signal(self, run_id: str, predicate: str) -> None:
        """Research runs: the task's facts that only the runner sees (started, paused, completed)."""
        run = await disk_call(self.store.run, run_id)
        if run is None or run.task_id is None:
            return
        draft = SignalDraft(
            subject=_LOCAL_USER,
            predicate=predicate,
            object=KbSignalEntity(kind="research_task", id=run.task_id),
            origin="task_event",
            evidence_id=run_id,
        )
        try:
            await disk_call(self.recorder.record, draft)
        except Exception as error:  # a fact that can't be written never stops the run
            logger.warning("Signal %s for run %s not recorded: %s", predicate, run_id, type(error).__name__)

    # -- derived state (blocking) -----------------------------------------------------------------------

    def _job(self, run_id: str) -> KbExploreJob:
        job = self.job_store.get(run_id)
        if job is None or job.owner not in _RUN_OWNERS or self.store.run(run_id) is None:
            raise NotFound("This run wasn't found.")
        return job

    def _run_row(self, run_id: str) -> RunRow:
        run = self.store.run(run_id)
        if run is None:
            raise NotFound("This run wasn't found.")
        return run

    def _candidates(self, run_id: str) -> dict[str, dict[str, Any]]:
        return {
            cid: json.loads(raw)
            for cid, raw in self.job_store.results(run_id, "collect").items()
            if not cid.startswith("@")
        }

    def _kept(self, run_id: str) -> list[str]:
        return [
            cid for cid, raw in self.job_store.results(run_id, "rules").items() if json.loads(raw).get("kept")
        ]

    def _counters(self, run_id: str) -> KbRunCounters:
        decisions = [json.loads(raw) for raw in self.job_store.results(run_id, "decision").values()]
        novelty = [json.loads(raw) for raw in self.job_store.results(run_id, "novelty").values()]
        return KbRunCounters(
            checked=len(self._candidates(run_id)),
            after_rules=len(self._kept(run_id)),
            decided=len(decisions),
            on_topic=sum(1 for verdict in decisions if verdict.get("on_topic")),
            novelty_checked=len(novelty),
            new=sum(1 for verdict in novelty if verdict.get("label") not in (None, "covered")),
            covered=sum(1 for verdict in novelty if verdict.get("label") == "covered"),
        )

    def _progress_ids(self, run_id: str, stage: str) -> tuple[list[str], list[str]]:
        """Finished and waiting work of the stage a run stopped in (its checkpoint)."""
        finished = self.job_store.completed(run_id, cast(KbRunStage, stage))
        done = sorted(cid for cid in finished if not cid.startswith("@"))
        if stage == "decision":
            pending = self._pending_decisions(run_id)
        elif stage == "novelty":
            pending = self._pending_novelty(run_id)
        elif stage == "rules":
            ruled = set(self.job_store.completed(run_id, "rules"))
            pending = [cid for cid in self._candidates(run_id) if cid not in ruled]
        else:
            pending = []
        return done, pending

    def _waiting(self, run_id: str) -> list[str]:
        decided = {cid: json.loads(raw) for cid, raw in self.job_store.results(run_id, "decision").items()}
        checked = set(self.job_store.completed(run_id, "novelty"))
        return [
            cid
            for cid in self._kept(run_id)
            if cid not in checked and (cid not in decided or decided[cid].get("on_topic"))
        ]

    def _snapshot(self, run_id: str) -> KbFunnelRun:
        job = self._job(run_id)
        run = self._run_row(run_id)
        request = run.request
        return KbFunnelRun.model_validate(
            {
                **job.model_dump(),
                "area_id": run.area_id,
                "task_id": run.task_id,
                "query": str(request.get("query") or ""),
                "channels": list(request.get("channels") or ()),
                "active_area_ids": list(request.get("area_options") or ()),
            }
        )

    def _summaries(self, active: bool) -> KbJobs:
        jobs = list(self.job_store.active()) if active else list(self.job_store.recent(limit=50))
        runs = self.store.runs([job.id for job in jobs])
        summaries = []
        for job in jobs:
            run = runs.get(job.id)
            summaries.append(
                KbJobSummary(
                    id=job.id,
                    owner=job.owner,
                    title=self.job_store.title(job.id) or "",
                    state=job.state,
                    stage=job.stage,
                    stop_reason=job.stop_reason,
                    budget=job.budget,
                    task_id=run.task_id if run else None,
                    chat_id=None,
                    area_id=run.area_id if run else None,
                    updated_at=job.updated_at,
                )
            )
        return KbJobs(jobs=summaries)

    def _finding_row(self, finding_id: str) -> FindingRow:
        row = self.store.finding(finding_id)
        if row is None:
            raise NotFound("This finding wasn't found.")
        return row

    def _findings_of(self, rows: Sequence[FindingRow]) -> list[KbFinding]:
        material_marks = self.directory.read_marks([row.material_id for row in rows if row.material_id])
        findings = []
        for row in rows:
            mark: KbReadMarkValue | None
            if row.material_id is not None:
                mark = material_marks.get(row.material_id)
            else:
                mark = self._finding_mark(row.id).value
            details = row.details
            findings.append(
                KbFinding.model_validate(
                    {
                        "id": row.id,
                        "run_id": row.run_id,
                        "task_id": row.task_id,
                        "area_id": row.area_id,
                        "channel": row.channel,
                        "label": row.label,
                        "work": details["work"],
                        "area_path": details.get("area_path") or [],
                        "reason": row.reason,
                        "wiki_refs": details.get("wiki_refs") or [],
                        "theses": row.theses,
                        "cites_materials": details.get("cites_materials") or [],
                        "shared_source_count": int(details.get("shared_source_count") or 0),
                        "repeat_hint": details.get("repeat_hint"),
                        "read_mark": mark,
                        "material_id": row.material_id,
                        "text_available": details.get("text_available") or "unchecked",
                        "created_at": row.created_at,
                    }
                )
            )
        return findings

    def _findings(
        self, area_id: str | None, task_id: str | None, include_covered: bool, offset: int, limit: int
    ) -> KbFindings:
        rows, more, covered = self.store.findings(
            area_id=area_id, task_id=task_id, include_covered=include_covered, offset=offset, limit=limit
        )
        findings = self._findings_of(rows)
        task_ids = list(dict.fromkeys(row.task_id for row in rows if row.task_id is not None))
        task_runs = self.store.task_runs(task_ids)
        groups: dict[str | None, KbFindingGroup] = {}
        for finding in findings:
            group = groups.get(finding.task_id)
            if group is None:
                job = self.job_store.get(task_runs[finding.task_id]) if finding.task_id in task_runs else None
                group = KbFindingGroup(
                    task_id=finding.task_id,
                    task_title=self.job_store.title(job.id) if job is not None else None,
                    task_state=job.state if job is not None else None,
                    updated_at=job.updated_at if job is not None else None,
                    findings=[],
                )
                groups[finding.task_id] = group
            group.findings.append(finding)
        hint = sum(1 for finding in findings if _needs_key(finding))
        checked = self.store.latest_checked(area_id=area_id, task_id=task_id)
        return KbFindings(
            groups=list(groups.values()),
            covered_count=covered,
            next_cursor=str(offset + limit) if more else None,
            checked_at=datetime.fromisoformat(checked.replace("Z", "+00:00")) if checked else None,
            full_text_key_hint_count=hint,
        )


_DECISION_QUESTION = (
    "Which of these areas of the user's library does this scientific work belong to? "
    "Choose the last option if it fits none of them."
)


def _window(request: Mapping[str, Any]) -> KbDateWindow | None:
    dates = request.get("dates")
    return KbDateWindow.model_validate(dates) if dates else None


def _raise_partial(results: KbScienceResults) -> None:
    """A page that came back with a stop reason: what it holds is kept, then the run pauses honestly."""
    if results.stop_reason == "openalex_daily_limit":
        raise ScienceDailyLimit(results.retry_at)
    if results.stop_reason == "provider_unavailable":
        raise ScienceUnavailable(results.retry_at)


def _needs_key(finding: KbFinding) -> bool:
    """A free OpenAlex key would give the full text: TEI exists, no other open text does."""
    kinds = {location.kind for location in finding.work.locations}
    return (
        finding.text_available != "full_text" and "tei" in kinds and not kinds & {"arxiv_html", "open_page"}
    )


def _offset(cursor: str | None) -> int:
    if cursor is None:
        return 0
    if not cursor.isdigit() or len(cursor) > 9:
        raise ContractFailure(422, "invalid_request")
    return int(cursor)


__all__ = ["Deciders", "DecisionChoice", "ExploreFunnel", "KbMaterialRef", "KbPublicationDate"]
