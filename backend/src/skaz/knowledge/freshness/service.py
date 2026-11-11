"""``runtime.kb_freshness``: publication dates, N7-5 date filter and manual link checks (0.4.0 B5)."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from collections.abc import Callable, Mapping, Sequence
from dataclasses import replace
from datetime import UTC, datetime
from functools import partial
from pathlib import Path
from typing import Any, cast

from ...native_io import disk_call
from ..api.contract_routes import ContractFailure
from ..api.schemas_areas import KbAreaMaterial, KbReadMarkValue
from ..api.schemas_explore_common import (
    KbContinue,
    KbExploreJob,
    KbPublicationDate,
    KbRunBudget,
    KbRunCounters,
    KbStopReason,
)
from ..api.schemas_freshness import (
    KbDatedMaterials,
    KbLibraryDateQuery,
    KbLinkCheck,
    KbLinkCheckStart,
    KbLinkObservation,
    KbMaterialPublication,
)
from ..api.schemas_repeats import KbMaterialRepeats
from ..areas.protocols import AreaDirectory
from ..errors import KnowledgeError, NameRejected, NotFound
from ..explore.jobs import ClaimLost
from ..explore.protocols import JobStore
from ..maintenance.protocols import FreshnessMarkReader, FreshnessMarkWriter
from ..markdown.source import MaterialKind
from ..repeats.protocols import RepeatSummaries
from ..science.protocols import ScienceClient, ScienceStop
from ..service import KnowledgeService
from ..sources.fetch import SafeFetcher
from ..store.database import MAX_DB_INT
from ..store.records import MaterialRecord
from .dates import (
    UNKNOWN_PUBLICATION,
    extract_local_publication,
    extract_science_ref,
    publication_in_window,
    publication_sort_key,
)
from .links import RawLinkProbe, evaluate_observation, material_check_url, probe_link
from .store import FreshnessStore, LinkCheckScope, LinkTarget

logger = logging.getLogger(__name__)

DEFAULT_LINK_BATCH_LIMIT = 100
MAX_PAGE_LIST = 200


def _zero_counters(checked: int = 0) -> KbRunCounters:
    return KbRunCounters(
        checked=checked,
        after_rules=0,
        decided=0,
        on_topic=0,
        novelty_checked=0,
        new=0,
        covered=0,
    )


class _Conflict(KnowledgeError):
    status_code = 409


def _parse_cursor(cursor: str | None) -> int:
    if cursor is None:
        return 0
    text = cursor.strip()
    if not text.isdigit():
        raise NameRejected("Invalid pagination cursor.")
    value = int(text)
    if value < 0 or value > MAX_DB_INT:
        raise NameRejected("Invalid pagination cursor.")
    return value


class FreshnessService:
    """Implements ``freshness.protocols.FreshnessService`` and ``PublicationDates``."""

    def __init__(
        self,
        kb: KnowledgeService,
        *,
        science: ScienceClient | None = None,
        job_store: JobStore | None = None,
        mark_writer: FreshnessMarkWriter | None = None,
        mark_reader: FreshnessMarkReader | None = None,
        area_directory: AreaDirectory | None = None,
        repeat_summaries: RepeatSummaries | None = None,
        fetcher: SafeFetcher | None = None,
        clock: Callable[[], datetime] | None = None,
        link_batch_limit: int = DEFAULT_LINK_BATCH_LIMIT,
        runtime: Any = None,
    ) -> None:
        self._kb = kb
        self._store = FreshnessStore(kb.db)
        self._science = science
        self._job_store = job_store
        self._mark_writer = mark_writer
        self._mark_reader = mark_reader
        self._area_directory = area_directory
        self._repeat_summaries = repeat_summaries
        self._fetcher = fetcher or SafeFetcher()
        self._clock = clock or (lambda: datetime.now(UTC))
        self._link_batch_limit = max(1, min(link_batch_limit, 500))
        self._runtime = runtime
        #: The one background worker per running check, and the lock its transitions share (R2-03/04/06).
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._closing = False

    @property
    def _resolved_science(self) -> ScienceClient | None:
        if self._science is not None:
            return self._science
        if self._runtime is not None:
            candidate = getattr(self._runtime, "kb_science", None)
            if candidate is not None and hasattr(candidate, "publication"):
                return candidate  # type: ignore[no-any-return]
        return None

    @property
    def _resolved_job_store(self) -> JobStore:
        """B2's ``JobStore`` (``runtime.kb_jobs``). No silent stand-in: an in-memory store would lose a
        check on restart, so until it is wired every job route answers ``not_ready``."""
        if self._job_store is not None:
            return self._job_store
        candidate = getattr(self._runtime, "kb_jobs", None) if self._runtime is not None else None
        if candidate is None:
            raise ContractFailure(503, "not_ready")
        return candidate  # type: ignore[no-any-return]

    @property
    def _resolved_mark_writer(self) -> FreshnessMarkWriter:
        """B6's mark writer (``runtime.kb_maintenance``). Without it a confirmed "gone" would be dropped
        silently, so a link check does not start (``not_ready``)."""
        if self._mark_writer is not None:
            return self._mark_writer
        candidate = getattr(self._runtime, "kb_maintenance", None) if self._runtime is not None else None
        if candidate is None:
            raise ContractFailure(503, "not_ready")
        return candidate  # type: ignore[no-any-return]

    @property
    def _resolved_mark_reader(self) -> FreshnessMarkReader | None:
        if self._mark_reader is not None:
            return self._mark_reader
        if self._runtime is not None:
            candidate = getattr(self._runtime, "kb_maintenance", None)
            if candidate is not None and hasattr(candidate, "mark_ids"):
                return candidate  # type: ignore[no-any-return]
        return None

    @property
    def _resolved_area_directory(self) -> AreaDirectory | None:
        if self._area_directory is not None:
            return self._area_directory
        if self._runtime is not None:
            candidate = getattr(self._runtime, "kb_areas", None)
            if candidate is not None and hasattr(candidate, "read_marks"):
                return candidate  # type: ignore[no-any-return]
        return None

    @property
    def _resolved_repeat_summaries(self) -> RepeatSummaries | None:
        if self._repeat_summaries is not None:
            return self._repeat_summaries
        if self._runtime is not None:
            candidate = getattr(self._runtime, "kb_repeats", None)
            if candidate is not None and hasattr(candidate, "summaries"):
                return candidate  # type: ignore[no-any-return]
        return None

    def _ensure_ready(self) -> Path:
        if self._kb.view().state == "not_configured":
            raise ContractFailure(503, "not_ready")
        return self._kb.require().root

    def _root_or_none(self) -> Path | None:
        try:
            return self._kb.require().root
        except KnowledgeError:
            return None

    def dates(self, material_ids: Sequence[str]) -> Mapping[str, KbPublicationDate]:
        """Blocking ``PublicationDates`` implementation; callers run it through ``disk_call``."""
        ids = list(dict.fromkeys(material_ids))
        if not ids:
            return {}
        stored = self._store.get_publications(ids)
        result: dict[str, KbPublicationDate] = {}
        root = self._root_or_none()
        for mid in ids:
            cached = stored.get(mid)
            if cached is not None and cached.precision != "unknown":
                result[mid] = cached
                continue
            record = self._kb.material_repo.get(mid)
            if record is None:
                result[mid] = cached or UNKNOWN_PUBLICATION
                continue
            local_pub = extract_local_publication(record, root)
            if local_pub.precision != "unknown":
                self._store.save_publication(mid, local_pub)
                result[mid] = local_pub
            else:
                if cached is None and self._resolved_science is None:
                    self._store.save_publication(mid, UNKNOWN_PUBLICATION)
                result[mid] = cached or UNKNOWN_PUBLICATION
        return result

    def latest_observation(self, material_id: str) -> KbLinkObservation | None:
        """Blocking: the latest "Check links" answer for one material, "couldn't check" included (B6)."""
        return self._store.latest_observation(material_id)

    async def publication(self, material_id: str) -> KbMaterialPublication:
        await disk_call(self._ensure_ready)
        record = await disk_call(self._kb.material_repo.get, material_id)
        if record is None:
            raise NotFound("This material wasn't found.")
        pub = await self._resolve_publication(record)
        return KbMaterialPublication(material_id=material_id, publication=pub)

    async def filter_dates(self, body: KbLibraryDateQuery) -> KbDatedMaterials:
        await disk_call(self._ensure_ready)
        offset = _parse_cursor(body.cursor)
        records = await disk_call(self._kb.material_repo.list_all, folder_id=body.folder_id)

        pubs_by_id: dict[str, KbPublicationDate] = {}
        for record in records:
            pubs_by_id[record.id] = await self._resolve_publication(record)

        dated_matches: list[tuple[MaterialRecord, KbPublicationDate]] = []
        unknown_matches: list[tuple[MaterialRecord, KbPublicationDate]] = []

        for record in records:
            pub = pubs_by_id[record.id]
            if pub.precision == "unknown":
                if body.dates.unknown == "separate":
                    unknown_matches.append((record, pub))
            elif publication_in_window(pub, body.dates):
                dated_matches.append((record, pub))

        dated_matches.sort(
            key=lambda item: publication_sort_key(item[1], item[0].created_at),
            reverse=True,
        )
        unknown_matches.sort(key=lambda item: (item[0].created_at, item[0].id), reverse=True)

        page_slice = dated_matches[offset : offset + body.limit]
        next_cursor = (
            str(offset + body.limit) if (offset + body.limit) < len(dated_matches) else None
        )
        unknown_slice = unknown_matches[:MAX_PAGE_LIST] if body.dates.unknown == "separate" else []

        all_ids = [r.id for r, _ in page_slice] + [r.id for r, _ in unknown_slice]
        enrichment = await disk_call(self._load_material_enrichment, all_ids)

        return KbDatedMaterials(
            materials=[
                self._to_area_material(record, pub, enrichment) for record, pub in page_slice
            ],
            unknown_date=[
                self._to_area_material(record, pub, enrichment) for record, pub in unknown_slice
            ],
            next_cursor=next_cursor,
        )

    async def check_links(self, body: KbLinkCheckStart) -> KbLinkCheck:
        """Stores the job and its scope, starts ONE tracked background worker and answers at once with the
        running job: a folder of slow links never holds the request (0.4.0 review R2-03)."""
        await disk_call(self._ensure_ready)
        if self._closing:
            raise ContractFailure(503, "not_ready")
        scope_ids, targets = await disk_call(self._resolve_link_targets, body)
        job_store = self._resolved_job_store
        self._resolved_mark_writer  # noqa: B018 (fail before a job exists, not halfway through)
        initial_budget = KbRunBudget(
            unit="link",
            limit=self._link_batch_limit,
            used=0,
            remaining=self._link_batch_limit,
            total_used=0,
            batch=1,
            free_only=True,
        )
        job = await disk_call(
            job_store.create, "links", "Check links", "links", initial_budget
        )
        scope = LinkCheckScope(
            check_id=job.id,
            folder_id=body.folder_id,
            material_ids=scope_ids,
            targets=targets,
            checkpoint=None,
        )
        await disk_call(self._store.save_link_check, scope)
        self._spawn(job.id, batch_number=1, prior_total_used=0)
        return await self.link_check(job.id)

    async def link_check(self, check_id: str) -> KbLinkCheck:
        await disk_call(self._ensure_ready)
        job, scope = await disk_call(self._load_check, check_id)
        observations = await disk_call(self._store.list_observations, check_id)
        return self._build_link_check(job, scope, observations)

    async def settled(self, check_id: str) -> KbLinkCheck:
        """Waits until the background worker of a check has stopped (tests, shutdown)."""
        task = self._tasks.get(check_id)
        if task is not None:
            with contextlib.suppress(asyncio.CancelledError):
                await asyncio.shield(task)
        return await self.link_check(check_id)

    async def pause(self, check_id: str) -> KbLinkCheck:
        """Paused at once, with a checkpoint. A probe already in flight still finishes and is recorded; the
        worker's progress write (``JobStore.advance``) never undoes the pause, and it stops there (R2-04)."""
        await disk_call(self._ensure_ready)
        async with self._lock(check_id):
            job, scope = await disk_call(self._load_check, check_id)
            if job.state not in ("running", "queued"):
                raise _Conflict("This link check is not running.")
            stopped, updated_scope = await disk_call(self._checkpoint_and_stop, check_id, scope, "user_pause")
        observations = await disk_call(self._store.list_observations, check_id)
        return self._build_link_check(stopped, updated_scope, observations)

    async def resume(self, check_id: str, body: KbContinue) -> KbLinkCheck:
        """Continue: claims the paused checkpoint atomically (``JobStore.claim_paused``) and starts the
        worker only when the claim wins; a second Continue with the same checkpoint is 409 (R2-06)."""
        await disk_call(self._ensure_ready)
        if self._closing:
            raise ContractFailure(503, "not_ready")
        # A worker paused mid-probe stops right after that probe: wait for it, never run two at once.
        await self._wait_worker(check_id)
        async with self._lock(check_id):
            job, _scope = await disk_call(self._load_check, check_id)
            if job.state != "paused":
                raise _Conflict("Only a paused link check can continue.")
            if self._running(check_id):
                raise ClaimLost()
            budget = KbRunBudget(
                unit="link",
                limit=job.budget.limit,
                used=0,
                remaining=job.budget.limit,
                total_used=job.budget.total_used,
                batch=job.budget.batch + 1,
                free_only=True,
            )
            await disk_call(
                partial(
                    self._resolved_job_store.claim_paused,
                    check_id,
                    checkpoint_id=body.checkpoint_id,
                    revision=body.revision,
                    budget=budget,
                )
            )
            self._spawn(check_id, batch_number=budget.batch, prior_total_used=budget.total_used)
        return await self.link_check(check_id)

    async def aclose(self) -> None:
        """Quit: each worker stops; its check pauses with ``app_exit`` and a checkpoint (free work only, so
        Continue may pick it up after the next start; ``JobStore.recover`` covers a crash)."""
        self._closing = True
        for check_id, task in list(self._tasks.items()):
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
            async with self._lock(check_id):
                with contextlib.suppress(KnowledgeError):
                    job, scope = await disk_call(self._load_check, check_id)
                    if job.state in ("running", "queued"):
                        await disk_call(self._checkpoint_and_stop, check_id, scope, "app_exit")

    async def _resolve_publication(self, record: MaterialRecord) -> KbPublicationDate:
        cached = await disk_call(self._store.get_publication, record.id)
        if cached is not None and cached.precision != "unknown":
            return cached

        root = await disk_call(self._root_or_none)
        science = self._resolved_science
        if science is not None:
            fragments = await disk_call(self._store.first_fragments, record.id)
            ref = await disk_call(extract_science_ref, record, root, fragments)
            if ref.doi is not None or ref.arxiv_id is not None:
                try:
                    resolved = await science.publication(ref)
                except ScienceStop:
                    resolved = UNKNOWN_PUBLICATION
                if resolved.precision != "unknown":
                    await disk_call(self._store.save_publication, record.id, resolved)
                    return resolved

        local_pub = await disk_call(extract_local_publication, record, root)
        if local_pub.precision != "unknown" or science is None:
            await disk_call(self._store.save_publication, record.id, local_pub)
        return local_pub

    def _load_material_enrichment(
        self, material_ids: Sequence[str]
    ) -> tuple[
        dict[str, int],
        Mapping[str, KbReadMarkValue],
        Mapping[str, KbMaterialRepeats],
        Mapping[str, Sequence[str]],
    ]:
        if not material_ids:
            return {}, {}, {}, {}
        wiki_counts = self._store.wiki_page_counts(material_ids)
        read_marks: Mapping[str, KbReadMarkValue] = (
            self._resolved_area_directory.read_marks(material_ids)
            if self._resolved_area_directory is not None
            else {}
        )
        repeats: Mapping[str, KbMaterialRepeats] = (
            self._resolved_repeat_summaries.summaries(material_ids)
            if self._resolved_repeat_summaries is not None
            else {}
        )
        freshness_marks: Mapping[str, Sequence[str]] = (
            self._resolved_mark_reader.mark_ids(material_ids)
            if self._resolved_mark_reader is not None
            else {}
        )
        return wiki_counts, read_marks, repeats, freshness_marks

    @staticmethod
    def _to_area_material(
        record: MaterialRecord,
        publication: KbPublicationDate,
        enrichment: tuple[
            dict[str, int],
            Mapping[str, KbReadMarkValue],
            Mapping[str, KbMaterialRepeats],
            Mapping[str, Sequence[str]],
        ],
    ) -> KbAreaMaterial:
        wiki_counts, read_marks, repeats, freshness_marks = enrichment
        rep = repeats.get(record.id)
        return KbAreaMaterial(
            material_id=record.id,
            title=record.title,
            kind=cast(MaterialKind, record.kind),
            publication=publication,
            wiki_pages=wiki_counts.get(record.id, 0),
            read_mark=read_marks.get(record.id),
            repeat_status=rep.status if rep is not None else "not_checked",
            repeated_percent=rep.percent if rep is not None else None,
            repeats_source_titles=(
                [item.title for item in rep.from_materials] if rep is not None else []
            ),
            freshness_mark_ids=list(freshness_marks.get(record.id, ())),
        )

    def _resolve_link_targets(
        self, body: KbLinkCheckStart
    ) -> tuple[tuple[str, ...], tuple[LinkTarget, ...]]:
        records: list[MaterialRecord] = []
        if body.folder_id is not None:
            folder = self._kb.folder_repo.get(body.folder_id)
            if folder is None:
                raise NotFound("This folder wasn't found.")
            folder_records = self._kb.material_repo.list_all(folder_id=body.folder_id)
            folder_records.sort(key=lambda r: (r.created_at, r.id))
            records.extend(folder_records)
        elif body.material_ids is not None:
            for mid in dict.fromkeys(body.material_ids):
                rec = self._kb.material_repo.get(mid)
                if rec is None:
                    raise NotFound("This material wasn't found.")
                records.append(rec)

        scope_ids = tuple(r.id for r in records)
        targets = tuple(
            LinkTarget(material_id=r.id, url=url)
            for r in records
            if (url := material_check_url(r)) is not None
        )
        return scope_ids, targets

    def _load_check(self, check_id: str) -> tuple[KbExploreJob, LinkCheckScope]:
        scope = self._store.get_link_check(check_id)
        job = self._resolved_job_store.get(check_id)
        if scope is None or job is None:
            raise NotFound("This link check wasn't found.")
        return job, scope

    # -- the worker ------------------------------------------------------------------------------

    def _lock(self, check_id: str) -> asyncio.Lock:
        """Pause, Continue and the worker's own final transitions of one check, one at a time."""
        return self._locks.setdefault(check_id, asyncio.Lock())

    def _running(self, check_id: str) -> bool:
        task = self._tasks.get(check_id)
        return task is not None and not task.done()

    async def _wait_worker(self, check_id: str) -> None:
        task = self._tasks.get(check_id)
        if task is not None and not task.done():
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await asyncio.shield(task)

    def _spawn(self, check_id: str, *, batch_number: int, prior_total_used: int) -> None:
        if self._running(check_id):
            raise ClaimLost()  # never two workers for one check
        task = asyncio.get_running_loop().create_task(
            self._work(check_id, batch_number=batch_number, prior_total_used=prior_total_used),
            name=f"link-check-{check_id}",
        )
        self._tasks[check_id] = task
        task.add_done_callback(
            lambda done: self._tasks.pop(check_id, None) if self._tasks.get(check_id) is done else None
        )

    def _checkpoint_and_stop(
        self, check_id: str, scope: LinkCheckScope, reason: KbStopReason
    ) -> tuple[KbExploreJob, LinkCheckScope]:
        """Blocking: a checkpoint of what is done and pending, then the stop (paused for these reasons)."""
        job_store = self._resolved_job_store
        completed_set = set(job_store.completed(check_id, "links"))
        all_target_ids = [t.material_id for t in scope.targets]
        completed_ids = [mid for mid in all_target_ids if mid in completed_set]
        pending_ids = [mid for mid in all_target_ids if mid not in completed_set]
        cp = job_store.checkpoint(
            check_id,
            stage="links",
            cursor=pending_ids[0] if pending_ids else None,
            completed_ids=completed_ids,
            pending_ids=pending_ids,
        )
        stopped = job_store.stop(check_id, reason)
        updated_scope = replace(scope, checkpoint=cp)
        self._store.save_link_check(updated_scope)
        return stopped, updated_scope

    def _record(self, check_id: str, target: LinkTarget, probe: RawLinkProbe) -> None:
        """Blocking: one finished link, all of it (observation, mark, finished work) in one thread call, so
        a Quit that cancels the worker meanwhile never leaves half of a unit."""
        checked_at = self._clock()
        observation, mark_action = evaluate_observation(
            material_id=target.material_id,
            url=target.url,
            probe=probe,
            checked_at=checked_at,
            prior_first_gone_at=self._store.active_first_gone_at(target.material_id),
        )
        self._store.add_observation(check_id, observation)
        mark_writer = self._resolved_mark_writer
        if mark_action == "link_gone":
            mark_writer.link_gone(target.material_id, target.url)
        elif mark_action == "link_back":
            mark_writer.link_back(target.material_id)
        obs_json = json.dumps(observation.model_dump(mode="json"), separators=(",", ":"))
        self._resolved_job_store.complete(check_id, target.material_id, "links", obs_json)

    async def _work(self, check_id: str, *, batch_number: int, prior_total_used: int) -> None:
        try:
            await self._run_link_batch(check_id, batch_number=batch_number, prior_total_used=prior_total_used)
        except asyncio.CancelledError:
            raise
        except Exception as error:  # ids only: a URL or a page never goes to the log
            logger.error("Link check %s failed: %s", check_id, type(error).__name__)
            with contextlib.suppress(Exception):
                async with self._lock(check_id):
                    job = await disk_call(self._resolved_job_store.get, check_id)
                    if job is not None and job.state in ("running", "queued"):
                        await disk_call(self._resolved_job_store.stop, check_id, "failed")

    async def _run_link_batch(self, check_id: str, *, batch_number: int, prior_total_used: int) -> None:
        """The one worker of a check: probes the pending links of this batch. Progress goes through
        ``JobStore.advance``, which never undoes a Pause; the worker stops as soon as the job is no longer
        running. Its own final transitions (budget, completed) happen under the check's lock."""
        job_store = self._resolved_job_store
        job, scope = await disk_call(self._load_check, check_id)
        limit = job.budget.limit
        completed_set = set(await disk_call(job_store.completed, check_id, "links"))
        pending_targets = [t for t in scope.targets if t.material_id not in completed_set]

        for done_here, target in enumerate(pending_targets):
            current = await disk_call(job_store.get, check_id)
            if self._closing or current is None or current.state != "running":
                return  # paused, cancelled or Quit: whoever stopped it wrote the state and checkpoint
            if done_here >= limit:
                async with self._lock(check_id):
                    latest = await disk_call(job_store.get, check_id)
                    if latest is not None and latest.state == "running":
                        await disk_call(self._checkpoint_and_stop, check_id, scope, "budget")
                return
            probe = await probe_link(self._fetcher, target.url)
            await disk_call(self._record, check_id, target, probe)
            used = done_here + 1
            total_used = prior_total_used + used
            budget = KbRunBudget(
                unit="link",
                limit=limit,
                used=used,
                remaining=limit - used,
                total_used=total_used,
                batch=batch_number,
                free_only=True,
            )
            job = await disk_call(
                partial(
                    job_store.advance,
                    check_id,
                    stage="links",
                    budget=budget,
                    counters=_zero_counters(total_used),
                )
            )
            if job.state != "running":
                return  # a Pause landed while the probe was in flight: it stays in force (R2-04)

        async with self._lock(check_id):
            latest = await disk_call(job_store.get, check_id)
            if latest is None or latest.state != "running":
                return
            await disk_call(job_store.stop, check_id, "completed")
            await disk_call(self._store.save_link_check, replace(scope, checkpoint=None))

    @staticmethod
    def _build_link_check(
        job: KbExploreJob,
        scope: LinkCheckScope,
        observations: Sequence[Any],
    ) -> KbLinkCheck:
        payload = job.model_dump()
        if payload.get("checkpoint") is None and scope.checkpoint is not None and job.state != "done":
            payload["checkpoint"] = scope.checkpoint
        payload["owner"] = "links"
        payload["observations"] = list(observations)[:MAX_PAGE_LIST]
        return KbLinkCheck.model_validate(payload)


def build_freshness_service(runtime: Any) -> FreshnessService:
    """Create ``FreshnessService`` wired to ``runtime`` (resolving sibling 0.4.0 services lazily)."""
    return FreshnessService(runtime.kb, runtime=runtime)
