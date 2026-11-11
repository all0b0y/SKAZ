"""``runtime.kb_maintenance``: the weekly check, N1 marks and their actions (0.4.0 B6).

Implements ``MaintenanceService`` (routes), ``FreshnessMarkReader``/``FreshnessMarkWriter`` (B4, B5) and
``WeeklyScheduler`` (app start). The weekly check runs on the backend and only asks the science bases and
reads the wiki — never a source's own site (decision 3f). Every step is free:

1. wiki — disagreements the wiki already found where one source is provably newer → "newer and
   contradicts" on the older statement (local, no model call);
2. N1 — new versions and retractions of library sources with a DOI or arXiv id (B1's ``updates``);
3. Explore — a ``free_only`` funnel run per pinned area (B2) → "N candidates waiting · Check novelty";
   the paid novelty check runs only when the user clicks (a new run with ``candidate_ids``).

Each finished unit is recorded through ``JobStore.complete`` before the next starts, so a pause, a stop or
Quit never repeats work. Quit pauses the check (``app_exit``); it resumes by itself at the next start — it
holds no paid step, so the user decision "after Quit only free steps resume" holds as it is. A missed week
runs at the next start. Logs carry ids and states only.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from collections.abc import Awaitable, Callable, Mapping, Sequence
from datetime import UTC, datetime, timedelta
from functools import partial
from typing import Any, Literal, cast

from ...native_io import disk_call
from ..api.contract_routes import ContractFailure
from ..api.schemas_explore import KbFunnelRun, KbFunnelStart
from ..api.schemas_explore_common import (
    KbContinue,
    KbExploreJob,
    KbRunBudget,
    KbRunCounters,
    KbStopReason,
)
from ..api.schemas_freshness import KbLinkObservation
from ..api.schemas_maintenance import (
    KbCheckNotification,
    KbFreshnessAction,
    KbFreshnessActionResult,
    KbFreshnessMark,
    KbFreshnessMarks,
    KbWeeklyCheck,
    KbWeeklySettings,
    KbWeeklySettingsUpdate,
)
from ..areas.protocols import AreaDirectory
from ..errors import KnowledgeError, NotFound
from ..explore.jobs import ClaimLost
from ..freshness.protocols import PublicationDates
from ..ids import utc_now_ms
from ..science.protocols import ScienceConsentRequired, ScienceRef, ScienceStop
from ..service import KnowledgeService
from ..sources.material_info import wiki_states
from .deps import IngestStarter, LinkIntake, LinkObservations, WeeklyFunnel, WeeklyJobs, WeeklyScience
from .marks import (
    link_gone_evidence,
    newer_evidence,
    provably_newer,
    statement_filter,
    to_model,
    update_evidence,
)
from .protocols import WEEKLY_CHECK_STARTED_BODY
from .refs import science_ref, versioned_link
from .store import CheckExists, CheckRow, MaintenanceStore, MarkRow, parse_stamp, stamp

logger = logging.getLogger(__name__)

WEEK = timedelta(days=7)
#: Library sources per ``ScienceClient.updates`` call (ids only leave SKAZ).
N1_BATCH = 25
#: The scheduler looks again at least this often (a laptop may sleep through a timer).
TICK_S = 3600.0
TITLE = "Weekly check"
TITLE_NO_PINNED = "Weekly check · sources only, no pinned areas"
CHANNELS: list[Literal["continues", "branches", "search"]] = ["continues", "branches", "search"]
STARTED = "weekly_check_started"
FINISHED = "weekly_check_finished"
_NOT_IN_WIKI = frozenset({"not_in_wiki", "failed"})
_ACTIVE = ("queued", "running", "paused")
_NOVELTY_OWNERS: tuple[Literal["explore", "research"], ...] = ("explore", "research")


class _Conflict(KnowledgeError):
    status_code = 409


class _ChildStopped(Exception):
    """A pinned area's funnel run paused (daily limit, consent, provider, Quit): the check pauses the same."""

    def __init__(self, reason: KbStopReason, retry_at: datetime | None) -> None:
        super().__init__(reason)
        self.reason = reason
        self.retry_at = retry_at


def _counters(checked: int) -> KbRunCounters:
    return KbRunCounters(
        checked=checked, after_rules=0, decided=0, on_topic=0, novelty_checked=0, new=0, covered=0
    )


def _budget(done: int, total: int) -> KbRunBudget:
    limit = max(1, total, done)
    return KbRunBudget(
        unit="material",
        limit=limit,
        used=done,
        remaining=limit - done,
        total_used=done,
        batch=1,
        free_only=True,
    )


def _json(data: Mapping[str, Any]) -> str:
    return json.dumps(data, separators=(",", ":"), sort_keys=True)


def finished_body(candidates: int, versions: int, retractions: int, newer: int) -> str:
    """CONTRACT "Notification kinds": "14 candidates waiting · Check novelty" / "2 newer source versions · 1
    retraction" (both when both were found)."""
    parts: list[str] = []
    if candidates:
        parts.append(f"{candidates} candidate{'s' if candidates != 1 else ''} waiting")
    if versions:
        parts.append(f"{versions} newer source version{'s' if versions != 1 else ''}")
    if retractions:
        parts.append(f"{retractions} retraction{'s' if retractions != 1 else ''}")
    if newer:
        parts.append(f"{newer} newer source{'s' if newer != 1 else ''} disagree{'s' if newer == 1 else ''}")
    if candidates and len(parts) == 1:
        parts.append("Check novelty")
    return " · ".join(parts)


class Maintenance:
    def __init__(
        self,
        kb: KnowledgeService,
        *,
        jobs: WeeklyJobs,
        science: WeeklyScience,
        funnel: WeeklyFunnel,
        areas: AreaDirectory,
        dates: PublicationDates,
        links: LinkObservations,
        sources: LinkIntake,
        ingest: IngestStarter,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
        sleep: Callable[[float], Awaitable[Any]] = asyncio.sleep,
        tick_s: float = TICK_S,
    ) -> None:
        self.kb = kb
        self.jobs = jobs
        self.science = science
        self.funnel = funnel
        self.areas = areas
        self.dates = dates
        self.links = links
        self.sources = sources
        self.ingest = ingest
        self.store = MaintenanceStore(kb.db, kb.settings)
        self._clock = clock
        self._sleep = sleep
        self._tick_s = tick_s
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._plans: dict[str, list[str]] = {}
        self._lock = asyncio.Lock()
        self._wake: asyncio.Event | None = None
        self._timer: asyncio.Task[None] | None = None
        self._closing = False

    # -- readiness ------------------------------------------------------------------------------------

    def _configured(self) -> bool:
        return self.kb.view().state != "not_configured"

    def _ensure_ready(self) -> None:
        if not self._configured():
            raise ContractFailure(503, "not_ready")

    def _now(self) -> datetime:
        return self._clock()

    # -- FreshnessMarkWriter / FreshnessMarkReader (blocking) ----------------------------------------

    def link_gone(self, material_id: str, evidence_url: str) -> str:
        mark_id, _fresh = self.store.upsert(
            material_id, "link_gone", "link_gone", link_gone_evidence(evidence_url, stamp(self._now()))
        )
        return mark_id

    def link_back(self, material_id: str) -> None:
        self.store.remove_unkept(material_id, "link_gone")

    def mark_ids(self, material_ids: Sequence[str]) -> Mapping[str, Sequence[str]]:
        found: dict[str, list[str]] = {}
        for mark in self.store.marks_of(material_ids):
            found.setdefault(mark.material_id, []).append(mark.id)
        return found

    # -- marks (routes) -------------------------------------------------------------------------------

    async def marks(self, material_id: str) -> KbFreshnessMarks:
        self._ensure_ready()
        return await disk_call(self._material_marks, material_id)

    async def page_marks(self, page_id: str) -> KbFreshnessMarks:
        self._ensure_ready()
        return await disk_call(self._page_marks, page_id)

    async def act(self, mark_id: str, body: KbFreshnessAction) -> KbFreshnessActionResult:
        self._ensure_ready()
        mark = await disk_call(self._mark_row, mark_id)
        if body.action not in (mark.evidence.get("actions") or ()):
            raise ContractFailure(409, "conflict")
        if body.action == "keep_marked":
            await disk_call(self.store.keep, mark_id)
            return KbFreshnessActionResult(mark=await disk_call(self._model, mark_id), ingest_job_id=None)
        return await self._replace(mark)

    async def _replace(self, mark: MarkRow) -> KbFreshnessActionResult:
        """Replace with vN: the material's own arXiv link, at the new version, through the link intake; the
        wiki takes it when it had the replaced copy. The old copy stays, marked, until the user deletes it.

        Resumable (0.4.0 review R2-07): the downloaded copy is remembered (``replaced_by``) before the wiki
        step, and "Replace with vN" stays offered until that step is durably queued. A retry after a failure
        or Quit reuses the downloaded copy and only does the missing step."""
        record = await disk_call(self.kb.material_repo.get, mark.material_id)
        version = mark.evidence.get("version")
        link = versioned_link(record, str(version)) if record is not None and version else None
        if record is None or link is None:
            raise ContractFailure(409, "conflict")
        in_wiki = await disk_call(self._in_wiki, record.id)
        material_id = await disk_call(self._downloaded_replacement, mark)
        if material_id is None:
            added = await self.sources.add_link(link, record.folder_id, to_wiki=False)
            material_id = str(added.material_id)
            await disk_call(self.store.update_evidence, mark.id, {"replaced_by": material_id})
        job_id: str | None = None
        if in_wiki and not await disk_call(self._in_wiki, material_id):
            job = await self.ingest.request_ingest(material_id)
            job_id = str(job.id)
        # Only now is the replacement complete (or its wiki job queued): the action is done.
        await disk_call(
            self.store.update_evidence, mark.id, {"actions": ["delete_source", "keep_marked"]}
        )
        logger.info("Mark %s: replacement %s added (ingest %s)", mark.id, material_id, job_id or "none")
        return KbFreshnessActionResult(mark=await disk_call(self._model, mark.id), ingest_job_id=job_id)

    def _downloaded_replacement(self, mark: MarkRow) -> str | None:
        """The copy an earlier "Replace with vN" already downloaded, while it is still in the library."""
        replaced_by = mark.evidence.get("replaced_by")
        if not isinstance(replaced_by, str) or not replaced_by:
            return None
        return replaced_by if self.kb.material_repo.get(replaced_by) is not None else None

    def _in_wiki(self, material_id: str) -> bool:
        state = wiki_states(self.kb.db, [material_id]).get(material_id)
        return state is not None and state.state not in _NOT_IN_WIKI

    def _mark_row(self, mark_id: str) -> MarkRow:
        mark = self.store.mark(mark_id)
        if mark is None or self.kb.material_repo.get(mark.material_id) is None:
            raise NotFound("This mark wasn't found.")
        return mark

    def _model(self, mark_id: str, page_id: str | None = None) -> KbFreshnessMark:
        mark = self._mark_row(mark_id)
        return self._to_model(mark, page_id)

    def _to_model(self, mark: MarkRow, page_id: str | None = None) -> KbFreshnessMark:
        statements = self.store.cited_statements(
            mark.material_id, page_id=page_id, blocks=statement_filter(mark)
        )
        return to_model(mark, statements, self._titles)

    def _titles(self, material_ids: Sequence[str]) -> Mapping[str, str]:
        found: dict[str, str] = {}
        for material_id in material_ids:
            record = self.kb.material_repo.get(material_id)
            if record is not None:
                found[material_id] = record.title
        return found

    def _material_marks(self, material_id: str) -> KbFreshnessMarks:
        if self.kb.material_repo.get(material_id) is None:
            raise NotFound("This material wasn't found.")
        marks = [self._to_model(mark) for mark in self.store.marks_of([material_id])]
        latest: KbLinkObservation | None = self.links.latest_observation(material_id)
        return KbFreshnessMarks(marks=marks, last_link_check=latest)

    def _page_marks(self, page_id: str) -> KbFreshnessMarks:
        if not self.store.page_exists(page_id):
            raise NotFound("This page wasn't found.")
        material_ids = [
            mid
            for mid in self.store.material_ids_on_page(page_id)
            if self.kb.material_repo.get(mid) is not None
        ]
        marks = []
        for mark in self.store.marks_of(material_ids):
            model = self._to_model(mark, page_id)
            if mark.kind == "newer_contradicts" and not model.affected_statements:
                continue  # it sits on a statement of another page
            marks.append(model)
        return KbFreshnessMarks(marks=marks, last_link_check=None)

    # -- settings ---------------------------------------------------------------------------------------

    async def settings(self) -> KbWeeklySettings:
        self._ensure_ready()
        return await disk_call(self._settings)

    async def update_settings(self, body: KbWeeklySettingsUpdate) -> KbWeeklySettings:
        self._ensure_ready()
        await disk_call(self.store.set_enabled, body.enabled, self._now())
        if self._wake is not None:
            self._wake.set()
        return await disk_call(self._settings)

    def _next_due(self) -> datetime | None:
        if not self.store.enabled():
            return None
        base = self.store.enabled_at() or self._now()
        latest = self.store.latest()
        started = parse_stamp(latest.due_at) if latest is not None else None
        if started is not None and started > base:
            base = started
        return base + WEEK

    def _settings(self) -> KbWeeklySettings:
        latest = self.store.latest_completed()
        waiting = self._still_waiting(latest) if latest is not None else []
        next_due = self._next_due()
        return KbWeeklySettings(
            enabled=self.store.enabled(),
            latest_check_id=latest.id if latest is not None else None,
            candidates_waiting=len(waiting),
            last_completed_at=parse_stamp(latest.completed_at) if latest is not None else None,
            next_due_at=next_due,
            missed=next_due is not None and self._now() >= next_due and not self._active_ids(),
        )

    def _still_waiting(self, check: CheckRow) -> list[str]:
        """Candidates no later run has checked for novelty yet ("Check novelty" clears them)."""
        return [
            cid
            for cid in check.candidate_ids
            if self.jobs.earlier_result(cid, "novelty", owners=_NOVELTY_OWNERS, exclude_job=check.id) is None
        ]

    def _active_ids(self) -> list[str]:
        return [job.id for job in self.jobs.active() if job.owner == "weekly"]

    # -- the check (routes) -----------------------------------------------------------------------------

    async def start(self) -> KbWeeklyCheck:
        """ "Check now": refused before any job exists when the science integration is off."""
        self._ensure_ready()
        if not (await self.science.settings()).enabled:
            raise ContractFailure(403, "consent_required")
        check_id = await self._begin("manual", stamp(self._now()))
        return await disk_call(self._snapshot, check_id)

    async def check(self, check_id: str) -> KbWeeklyCheck:
        self._ensure_ready()
        return await disk_call(self._snapshot, check_id)

    async def pause(self, check_id: str) -> KbWeeklyCheck:
        self._ensure_ready()
        job = await disk_call(self._job, check_id)
        if job.state not in ("running", "queued"):
            raise ContractFailure(409, "conflict")
        await self._halt(check_id)
        for run_id in await disk_call(self._open_runs, check_id):
            with contextlib.suppress(KnowledgeError):
                run = await self.funnel.run(run_id)
                if run.state in ("running", "queued"):
                    await self.funnel.pause(run_id)
        job = await disk_call(self._job, check_id)
        if job.state in ("running", "queued"):
            await disk_call(self._stop, check_id, "user_pause", None)
        return await disk_call(self._snapshot, check_id)

    async def resume(self, check_id: str, body: KbContinue) -> KbWeeklyCheck:
        self._ensure_ready()
        await disk_call(self._job, check_id)
        if self._running(check_id):
            raise ContractFailure(409, "conflict")
        # One write claims the paused checkpoint: of two Continues with it only one gets past (R2-06).
        try:
            await disk_call(
                partial(
                    self.jobs.claim_paused,
                    check_id,
                    checkpoint_id=body.checkpoint_id,
                    revision=body.revision,
                )
            )
        except ClaimLost:
            raise ContractFailure(409, "conflict") from None
        self._spawn(check_id)
        return await disk_call(self._snapshot, check_id)

    # -- WeeklyScheduler ----------------------------------------------------------------------------------

    async def on_start(self) -> None:
        """App start: a check paused by the last Quit goes on (all its steps are free); a missed week runs
        now; then the weekly timer starts. B2's ``on_start`` runs first, so its runs are moving already."""
        self._closing = False
        if self._configured():
            for job in await disk_call(self.jobs.active):
                if (
                    job.owner == "weekly"
                    and job.stop_reason == "app_exit"
                    and job.checkpoint is not None
                    and not self._running(job.id)
                ):
                    try:
                        await disk_call(
                            partial(
                                self.jobs.claim_paused,
                                job.id,
                                checkpoint_id=job.checkpoint.id,
                                revision=job.checkpoint.revision,
                            )
                        )
                    except ClaimLost:
                        continue  # a Continue got there first
                    self._spawn(job.id)
            due = await disk_call(self._next_due)
            active = await disk_call(self._active_ids)
            if due is not None and self._now() >= due and not active:
                with contextlib.suppress(ContractFailure):
                    await self._begin("missed_week", stamp(self._now()))
        if self._timer is None or self._timer.done():
            self._wake = asyncio.Event()
            self._timer = asyncio.get_running_loop().create_task(
                self._timer_loop(), name="weekly-check-timer"
            )

    async def aclose(self) -> None:
        """Quit: the timer stops; a running check pauses with ``app_exit`` and resumes next launch."""
        self._closing = True
        if self._timer is not None:
            self._timer.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._timer
            self._timer = None
        for check_id in list(self._tasks):
            await self._halt(check_id)
            with contextlib.suppress(KnowledgeError):
                job = await disk_call(self._job, check_id)
                if job.state in ("running", "queued"):
                    await disk_call(self._stop, check_id, "app_exit", None)

    async def _timer_loop(self) -> None:
        while True:
            try:
                delay = await self._tick()
            except asyncio.CancelledError:
                raise
            except Exception as error:
                logger.error("Weekly check timer failed: %s", type(error).__name__)
                delay = self._tick_s
            wake = self._wake
            if wake is None:
                await self._sleep(delay)
                continue
            wake.clear()
            sleeper = asyncio.ensure_future(self._sleep(delay))
            waiter = asyncio.ensure_future(wake.wait())
            try:
                await asyncio.wait({sleeper, waiter}, return_when=asyncio.FIRST_COMPLETED)
            finally:
                for pending in (sleeper, waiter):
                    pending.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await pending

    async def _tick(self) -> float:
        """Starts the check that is due; returns how long to sleep before looking again."""
        if not self._configured():
            return self._tick_s
        due = await disk_call(self._next_due)
        active = await disk_call(self._active_ids)
        if due is None or active:
            return self._tick_s
        now = self._now()
        if now >= due:
            with contextlib.suppress(ContractFailure):
                await self._begin("scheduled", stamp(due))
            return self._tick_s
        return max(1.0, min(self._tick_s, (due - now).total_seconds()))

    # -- running a check ----------------------------------------------------------------------------------

    async def _begin(self, trigger: Literal["manual", "scheduled", "missed_week"], due_at: str) -> str:
        async with self._lock:
            if await disk_call(self._active_ids):
                raise ContractFailure(409, "conflict")
            pinned = await disk_call(self.areas.pinned)
            title = TITLE if pinned else TITLE_NO_PINNED
            job = await disk_call(self.jobs.create, "weekly", title, "collect", _budget(0, 0))
            try:
                await disk_call(self.store.create_check, job.id, trigger, due_at)
            except CheckExists:
                await disk_call(self.jobs.stop, job.id, "cancelled")  # this week's slot was taken already
                raise ContractFailure(409, "conflict") from None
            notice = await disk_call(
                self.kb.notify,
                STARTED,
                "Weekly check started",
                body=WEEKLY_CHECK_STARTED_BODY,
                payload={"job_id": job.id, "task_id": None},
            )
            await disk_call(self.store.set_counts, job.id, {"notifications": [notice.id]})
            logger.info("Weekly check %s started (%s)", job.id, trigger)
            self._spawn(job.id)
            return job.id

    def _running(self, check_id: str) -> bool:
        task = self._tasks.get(check_id)
        return task is not None and not task.done()

    def _spawn(self, check_id: str) -> asyncio.Task[None]:
        if self._running(check_id):
            raise ContractFailure(409, "conflict")  # never two workers for one check
        task = asyncio.get_running_loop().create_task(self._drive(check_id), name=f"weekly-{check_id}")
        self._tasks[check_id] = task
        task.add_done_callback(
            lambda done: self._tasks.pop(check_id, None) if self._tasks.get(check_id) is done else None
        )
        return task

    async def _halt(self, check_id: str) -> None:
        task = self._tasks.get(check_id)
        if task is None or task.done():
            return
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task

    async def settled(self, check_id: str) -> KbWeeklyCheck:
        """Wait until the background work of a check has stopped (tests)."""
        task = self._tasks.get(check_id)
        if task is not None:
            with contextlib.suppress(asyncio.CancelledError):
                await asyncio.shield(task)
        return await disk_call(self._snapshot, check_id)

    async def _drive(self, check_id: str) -> None:
        try:
            plan = await disk_call(self._plan)
            self._plans[check_id] = [*plan["wiki"], *plan["n1"], *plan["areas"]]
            await self._wiki_step(check_id, plan["wiki"])
            await self._n1_step(check_id, plan["refs"])
            await self._explore_step(check_id, plan["area_ids"])
            await self._finish(check_id)
        except asyncio.CancelledError:
            raise
        except ScienceStop as stop:
            retry = stop.retry_at.isoformat() if stop.retry_at is not None else None
            await disk_call(self._stop, check_id, stop.stop_reason, retry)
        except _ChildStopped as stop:
            retry = stop.retry_at.isoformat() if stop.retry_at is not None else None
            await disk_call(self._stop, check_id, stop.reason, retry)
        except Exception as error:
            logger.error("Weekly check %s failed: %s", check_id, type(error).__name__)
            with contextlib.suppress(Exception):
                await disk_call(self._stop, check_id, "failed", None)

    def _plan(self) -> dict[str, Any]:
        refs: list[ScienceRef] = [
            ref for record in self.kb.material_repo.list_all() if (ref := science_ref(record)) is not None
        ]
        disagreements = self.store.disagreements()
        area_ids = list(dict.fromkeys(self.areas.pinned()))
        return {
            "refs": refs,
            "area_ids": area_ids,
            "wiki": [f"wiki:{item.id}" for item in disagreements],
            "n1": [f"n1:{ref.material_id}" for ref in refs],
            "areas": [f"area:{area_id}" for area_id in area_ids],
        }

    async def _progress(self, check_id: str) -> None:
        await disk_call(self._write_progress, check_id, "collect")

    def _write_progress(self, check_id: str, stage: Literal["collect", "ready"]) -> KbExploreJob:
        plan = self._plans.get(check_id, [])
        done = self.jobs.completed(check_id, "collect")
        used = sum(1 for key in plan if key in done)
        checked = sum(1 for key in done if key.startswith("n1:"))
        # ``advance``: a Pause or Quit that landed meanwhile stays in force (0.4.0 review R2-04).
        return self.jobs.advance(
            check_id, stage=stage, budget=_budget(used, len(plan)), counters=_counters(checked)
        )

    def _stop(self, check_id: str, reason: KbStopReason, retry_at: str | None) -> None:
        job = self._job(check_id)
        done = self.jobs.completed(check_id, "collect")
        plan = self._plans.get(check_id, [])
        pending = [key for key in plan if key not in done]
        self.jobs.checkpoint(
            check_id,
            stage=job.stage,
            cursor=pending[0] if pending else None,
            completed_ids=sorted(key for key in done if not key.startswith("@")),
            pending_ids=pending,
        )
        self.jobs.stop(check_id, reason, retry_at=retry_at)
        logger.info("Weekly check %s stopped: %s", check_id, reason)

    # step 1: disagreements the wiki found, where one source is provably newer

    async def _wiki_step(self, check_id: str, keys: Sequence[str]) -> None:
        done = set(await disk_call(self.jobs.completed, check_id, "collect"))
        if all(key in done for key in keys):
            return
        await self._progress(check_id)
        for item in await disk_call(self.store.disagreements):
            key = f"wiki:{item.id}"
            if key in done:
                continue
            result = await disk_call(self._newer_contradicts, item.page_id, item.block_a, item.block_b)
            await disk_call(self.jobs.complete, check_id, key, "collect", _json(result))
            await self._progress(check_id)

    def _newer_contradicts(self, page_id: str, block_a: str, block_b: str) -> dict[str, Any]:
        material_a = self.store.block_material(page_id, block_a)
        material_b = self.store.block_material(page_id, block_b)
        if material_a is None or material_b is None or material_a == material_b:
            return {"mark": None}
        dates = self.dates.dates([material_a, material_b])
        date_a, date_b = dates.get(material_a), dates.get(material_b)
        if date_a is None or date_b is None:
            return {"mark": None}
        if provably_newer(date_a, date_b):
            newer, older, older_block, newer_block, newer_date = (
                material_a,
                material_b,
                block_b,
                block_a,
                date_a,
            )
        elif provably_newer(date_b, date_a):
            newer, older, older_block, newer_block, newer_date = (
                material_b,
                material_a,
                block_a,
                block_b,
                date_b,
            )
        else:
            return {"mark": None}  # unknown or overlapping dates: nothing provable
        record = self.kb.material_repo.get(newer)
        evidence = newer_evidence(
            record.title if record is not None else "a newer source",
            newer_date,
            page_id,
            older_block,
            stamp(self._now()),
        )
        mark_id, fresh = self.store.upsert(
            older, "newer_contradicts", f"{page_id}:{older_block}:{newer_block}", evidence
        )
        return {"mark": mark_id, "fresh": fresh}

    # step 2: N1 facts from the science bases

    async def _n1_step(self, check_id: str, refs: Sequence[ScienceRef]) -> None:
        done = set(await disk_call(self.jobs.completed, check_id, "collect"))
        pending = [ref for ref in refs if f"n1:{ref.material_id}" not in done]
        if not pending:
            return
        await self._progress(check_id)
        for start in range(0, len(pending), N1_BATCH):
            chunk = pending[start : start + N1_BATCH]
            updates = await self.science.updates(chunk, run_id=check_id)
            by_material = {ref.material_id: ref for ref in chunk}
            found: dict[str, list[dict[str, Any]]] = {ref.material_id: [] for ref in chunk}
            checked_at = stamp(self._now())
            for update in updates:
                ref = by_material.get(update.material_id)
                if ref is None:
                    continue
                evidence = update_evidence(update, ref.version, checked_at)
                mark_id, fresh = await disk_call(
                    self.store.upsert, update.material_id, update.kind, update.kind, evidence
                )
                found[update.material_id].append({"kind": update.kind, "mark": mark_id, "fresh": fresh})
            for ref in chunk:
                await disk_call(
                    self.jobs.complete,
                    check_id,
                    f"n1:{ref.material_id}",
                    "collect",
                    _json({"updates": found[ref.material_id]}),
                )
            await self._progress(check_id)

    # step 3: Explore, free steps only, pinned areas only

    async def _explore_step(self, check_id: str, area_ids: Sequence[str]) -> None:
        for area_id in area_ids:
            done = set(await disk_call(self.jobs.completed, check_id, "collect"))
            key = f"area:{area_id}"
            if key in done:
                continue
            await self._progress(check_id)
            run_id = await disk_call(self._started_run, check_id, area_id)
            if run_id is None:
                try:
                    started = await self.funnel.start(
                        KbFunnelStart(area_id=area_id, channels=CHANNELS), free_only=True
                    )
                except ContractFailure as failure:
                    if failure.code == "consent_required":
                        raise ScienceConsentRequired() from failure
                    if failure.code == "not_found":
                        await disk_call(
                            self.jobs.complete, check_id, key, "collect", _json({"skipped": "gone"})
                        )
                        continue
                    raise
                except NotFound:
                    await disk_call(self.jobs.complete, check_id, key, "collect", _json({"skipped": "gone"}))
                    continue
                run_id = started.id
                await disk_call(
                    self.jobs.complete, check_id, f"@run:{area_id}", "collect", _json({"run_id": run_id})
                )
            run = await self._settle(run_id)
            candidates = await self.funnel.waiting(run_id) if run.state == "done" else []
            if run.state != "done":
                logger.warning(
                    "Weekly check %s: run %s of a pinned area ended %s", check_id, run_id, run.state
                )
            await disk_call(
                self.jobs.complete,
                check_id,
                key,
                "collect",
                _json({"run_id": run_id, "state": run.state, "candidates": list(candidates)}),
            )
            await self._progress(check_id)

    async def _settle(self, run_id: str) -> KbFunnelRun:
        run = await self.funnel.settled(run_id)
        if run.state == "paused" and not self._closing and run.checkpoint is not None:
            # Paused by Quit, by "Pause" on the check, or by an honest stop the user now retries.
            run = await self.funnel.resume(
                run_id, KbContinue(checkpoint_id=run.checkpoint.id, revision=run.checkpoint.revision)
            )
            run = await self.funnel.settled(run_id)
        if run.state == "paused" or (self._closing and run.state in ("running", "queued")):
            raise _ChildStopped(run.stop_reason or "app_exit", run.retry_at)
        return run

    def _started_run(self, check_id: str, area_id: str) -> str | None:
        raw = self.jobs.result(check_id, f"@run:{area_id}", "collect")
        return (str(json.loads(raw).get("run_id") or "") or None) if raw is not None else None

    def _open_runs(self, check_id: str) -> list[str]:
        results = self._results(check_id)
        return [
            str(json.loads(value).get("run_id"))
            for key, value in results.items()
            if key.startswith("@run:") and f"area:{key[5:]}" not in results
        ]

    def _results(self, check_id: str) -> dict[str, str]:
        """Finished units of a check with their results (the job store keeps them; nothing is kept here)."""
        return dict(self.jobs.results(check_id, "collect"))

    async def _finish(self, check_id: str) -> None:
        results = await disk_call(self._results, check_id)
        candidates = list(
            dict.fromkeys(
                cid
                for key, raw in results.items()
                if key.startswith("area:")
                for cid in json.loads(raw).get("candidates") or ()
            )
        )
        await disk_call(self._write_progress, check_id, "ready")
        await disk_call(self.store.finish, check_id, completed_at=utc_now_ms(), candidate_ids=candidates)
        await disk_call(self.jobs.stop, check_id, "completed")
        counts = _found(results)
        logger.info("Weekly check %s completed", check_id)
        if not (
            candidates or counts["new_versions"] or counts["retractions"] or counts["newer_contradictions"]
        ):
            return  # open question 9: the finish notification only when something was found
        notice = await disk_call(
            self.kb.notify,
            FINISHED,
            TITLE,
            body=finished_body(
                len(candidates), counts["new_versions"], counts["retractions"], counts["newer_contradictions"]
            ),
            payload={
                "job_id": check_id,
                "task_id": None,
                "candidates_waiting": len(candidates),
                "new_versions": counts["new_versions"],
                "retractions": counts["retractions"],
                "newer_contradictions": counts["newer_contradictions"],
            },
        )
        row = await disk_call(self.store.check, check_id)
        known = list((row.counts if row is not None else {}).get("notifications") or ())
        await disk_call(self.store.set_counts, check_id, {"notifications": [*known, notice.id]})

    # -- reading a check ------------------------------------------------------------------------------

    def _job(self, check_id: str) -> KbExploreJob:
        job = self.jobs.get(check_id)
        if job is None or job.owner != "weekly" or self.store.check(check_id) is None:
            raise NotFound("This check wasn't found.")
        return job

    def _snapshot(self, check_id: str) -> KbWeeklyCheck:
        job = self._job(check_id)
        row = self.store.check(check_id)
        assert row is not None
        results = self._results(check_id)
        counts = _found(results)
        if row.completed_at is not None:
            candidate_ids = self._still_waiting(row)
        else:
            candidate_ids = list(
                dict.fromkeys(
                    cid
                    for key, raw in results.items()
                    if key.startswith("area:")
                    for cid in json.loads(raw).get("candidates") or ()
                )
            )
        notifications: list[KbCheckNotification] = []
        for notification_id in row.counts.get("notifications") or ():
            record = self.kb.notification_repo.get(str(notification_id))
            if record is None:
                continue
            notifications.append(
                KbCheckNotification(
                    id=record.id,
                    kind=cast(Any, record.kind),
                    job_id=check_id,
                    task_id=None,
                    created_at=datetime.fromisoformat(record.created_at.replace("Z", "+00:00")),
                    message=record.body,
                )
            )
        return KbWeeklyCheck.model_validate(
            {
                **job.model_dump(),
                "trigger": row.trigger,
                "candidates_waiting": len(candidate_ids),
                "candidate_ids": candidate_ids,
                "new_versions": counts["new_versions"],
                "retractions": counts["retractions"],
                "newer_contradictions": counts["newer_contradictions"],
                "notifications": notifications,
            }
        )


def _found(results: Mapping[str, str]) -> dict[str, int]:
    """New facts of one check (a mark already known from an earlier week is not news again)."""
    counts = {"new_versions": 0, "retractions": 0, "newer_contradictions": 0}
    for key, raw in results.items():
        data = json.loads(raw)
        if key.startswith("n1:"):
            for update in data.get("updates") or ():
                if not update.get("fresh"):
                    continue
                if update.get("kind") == "new_version":
                    counts["new_versions"] += 1
                elif update.get("kind") == "retracted":
                    counts["retractions"] += 1
        elif key.startswith("wiki:") and data.get("mark") and data.get("fresh"):
            counts["newer_contradictions"] += 1
    return counts
