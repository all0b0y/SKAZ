"""``runtime.kb_freshness``: publication dates, N7-5 date filter and manual link checks (0.4.0 B5)."""

from __future__ import annotations

import json
from collections.abc import Callable, Mapping, Sequence
from datetime import UTC, datetime
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
)
from ..api.schemas_freshness import (
    KbDatedMaterials,
    KbLibraryDateQuery,
    KbLinkCheck,
    KbLinkCheckStart,
    KbMaterialPublication,
)
from ..api.schemas_repeats import KbMaterialRepeats
from ..areas.protocols import AreaDirectory
from ..errors import KnowledgeError, NameRejected, NotFound
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
from .links import evaluate_observation, material_check_url, probe_link
from .store import FreshnessStore, LinkCheckScope, LinkTarget

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
        self._pause_requested: set[str] = set()

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
        await disk_call(self._ensure_ready)
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
        return await self._run_link_batch(job, scope, batch_number=1, prior_total_used=0)

    async def link_check(self, check_id: str) -> KbLinkCheck:
        await disk_call(self._ensure_ready)
        job, scope = await disk_call(self._load_check, check_id)
        observations = await disk_call(self._store.list_observations, check_id)
        return self._build_link_check(job, scope, observations)

    async def pause(self, check_id: str) -> KbLinkCheck:
        await disk_call(self._ensure_ready)
        job, scope = await disk_call(self._load_check, check_id)
        if job.state not in ("running", "queued"):
            raise _Conflict("This link check is not running.")
        self._pause_requested.add(check_id)
        job_store = self._resolved_job_store
        completed_set = set(await disk_call(job_store.completed, check_id, "links"))
        all_target_ids = [t.material_id for t in scope.targets]
        completed_ids = [mid for mid in all_target_ids if mid in completed_set]
        pending_ids = [mid for mid in all_target_ids if mid not in completed_set]
        cursor = pending_ids[0] if pending_ids else None
        cp = await disk_call(
            job_store.checkpoint,
            check_id,
            stage="links",
            cursor=cursor,
            completed_ids=completed_ids,
            pending_ids=pending_ids,
        )
        stopped = await disk_call(job_store.stop, check_id, "user_pause")
        updated_scope = LinkCheckScope(
            check_id=scope.check_id,
            folder_id=scope.folder_id,
            material_ids=scope.material_ids,
            targets=scope.targets,
            checkpoint=cp,
        )
        await disk_call(self._store.save_link_check, updated_scope)
        observations = await disk_call(self._store.list_observations, check_id)
        return self._build_link_check(stopped, updated_scope, observations)

    async def resume(self, check_id: str, body: KbContinue) -> KbLinkCheck:
        await disk_call(self._ensure_ready)
        job, scope = await disk_call(self._load_check, check_id)
        if job.state != "paused":
            raise _Conflict("Only a paused link check can continue.")
        cp = job.checkpoint or scope.checkpoint
        if cp is None or cp.id != body.checkpoint_id or cp.revision != body.revision:
            raise _Conflict("Checkpoint revision is out of date.")
        self._pause_requested.discard(check_id)
        next_batch = job.budget.batch + 1
        return await self._run_link_batch(
            job,
            scope,
            batch_number=next_batch,
            prior_total_used=job.budget.total_used,
        )

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

    async def _run_link_batch(
        self,
        job: KbExploreJob,
        scope: LinkCheckScope,
        *,
        batch_number: int,
        prior_total_used: int,
    ) -> KbLinkCheck:
        job_store = self._resolved_job_store
        mark_writer = self._resolved_mark_writer
        limit = job.budget.limit
        completed_set = set(await disk_call(job_store.completed, job.id, "links"))
        pending_targets = [t for t in scope.targets if t.material_id not in completed_set]

        used = 0
        total_used = prior_total_used
        budget = KbRunBudget(
            unit="link",
            limit=limit,
            used=0,
            remaining=limit,
            total_used=total_used,
            batch=batch_number,
            free_only=True,
        )
        counters = _zero_counters(total_used)
        job = await disk_call(
            job_store.progress, job.id, stage="links", budget=budget, counters=counters
        )

        for idx, target in enumerate(pending_targets):
            if job.id in self._pause_requested:
                break
            if used >= limit:
                remaining_targets = pending_targets[idx:]
                all_target_ids = [t.material_id for t in scope.targets]
                completed_ids = [mid for mid in all_target_ids if mid in completed_set]
                pending_ids = [t.material_id for t in remaining_targets]
                cp = await disk_call(
                    job_store.checkpoint,
                    job.id,
                    stage="links",
                    cursor=pending_ids[0] if pending_ids else None,
                    completed_ids=completed_ids,
                    pending_ids=pending_ids,
                )
                job = await disk_call(job_store.stop, job.id, "budget")
                updated_scope = LinkCheckScope(
                    check_id=scope.check_id,
                    folder_id=scope.folder_id,
                    material_ids=scope.material_ids,
                    targets=scope.targets,
                    checkpoint=cp,
                )
                await disk_call(self._store.save_link_check, updated_scope)
                observations = await disk_call(self._store.list_observations, job.id)
                return self._build_link_check(job, updated_scope, observations)

            probe = await probe_link(self._fetcher, target.url)
            checked_at = self._clock()
            prior_first_gone = await disk_call(
                self._store.active_first_gone_at, target.material_id
            )
            observation, mark_action = evaluate_observation(
                material_id=target.material_id,
                url=target.url,
                probe=probe,
                checked_at=checked_at,
                prior_first_gone_at=prior_first_gone,
            )
            await disk_call(self._store.add_observation, job.id, observation)
            if mark_action == "link_gone":
                await disk_call(mark_writer.link_gone, target.material_id, target.url)
            elif mark_action == "link_back":
                await disk_call(mark_writer.link_back, target.material_id)

            obs_json = json.dumps(observation.model_dump(mode="json"), separators=(",", ":"))
            await disk_call(job_store.complete, job.id, target.material_id, "links", obs_json)
            completed_set.add(target.material_id)
            used = idx + 1
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
            counters = _zero_counters(total_used)
            job = await disk_call(
                job_store.progress, job.id, stage="links", budget=budget, counters=counters
            )

        if job.id in self._pause_requested:
            self._pause_requested.discard(job.id)
            latest_job, latest_scope = await disk_call(self._load_check, job.id)
            observations = await disk_call(self._store.list_observations, job.id)
            return self._build_link_check(latest_job, latest_scope, observations)

        job = await disk_call(job_store.stop, job.id, "completed")
        done_scope = LinkCheckScope(
            check_id=scope.check_id,
            folder_id=scope.folder_id,
            material_ids=scope.material_ids,
            targets=scope.targets,
            checkpoint=None,
        )
        await disk_call(self._store.save_link_check, done_scope)
        observations = await disk_call(self._store.list_observations, job.id)
        return self._build_link_check(job, done_scope, observations)

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
