"""``AreasService`` implementation for SKAZ 0.4.0 (B4; EX2: the map of the user's own topics).

EX2: ``map`` reads stored state only — never a model, never the network. Materials get their topic from the
wiki agent (at the end of ingest, or the "Sort materials" job the user starts); each topic's hidden OpenAlex
label is made in the background when topics change (``mapping``).
"""

from __future__ import annotations

import logging
from collections import Counter
from collections.abc import Callable, Mapping, Sequence
from typing import TYPE_CHECKING, Literal, TypeVar, cast

from ...native_io import disk_call
from ..api.contract_routes import ContractFailure
from ..api.schemas_areas import (
    KbArea,
    KbAreaCreate,
    KbAreaMap,
    KbAreaMaterial,
    KbAreaMaterials,
    KbAreaMerge,
    KbAreaUpdate,
    KbFactualSignal,
    KbMaterialTopic,
    KbMaterialTopicSet,
    KbReadMark,
    KbReadMarkUpdate,
    KbSignals,
    KbTopicLabelling,
)
from ..api.schemas_explore_common import KbAcknowledged, KbPublicationDate, KbReadMarkValue
from ..decisions.protocol import DecisionLayer
from ..errors import NotFound
from ..markdown.source import MaterialKind
from ..science.protocols import ScienceClient
from ..service import KnowledgeService
from .labelling import MaterialLabeller, TopicLabels, TopicSorting
from .mapping import TopicMapper, TopicSearch
from .protocols import AreaDirectory, SignalDraft, SignalRecorder, TopicDirectory
from .signals import SignalStore
from .store import AreasStore
from .topics import TopicStore

if TYPE_CHECKING:
    from ..api.schemas_repeats import KbMaterialRepeats
    from ..explore.protocols import ExploreService
    from ..freshness.protocols import PublicationDates
    from ..ingest.protocols import TopicLabeller
    from ..ingest.service import IngestService
    from ..maintenance.protocols import FreshnessMarkReader
    from ..repeats.protocols import RepeatSummaries
    from ..wiki.jobs import WikiJobs

logger = logging.getLogger(__name__)
T = TypeVar("T")
_UNKNOWN_PUBLICATION = KbPublicationDate(
    year=None,
    date=None,
    month=None,
    precision="unknown",
    origin="unknown",
    evidence_url=None,
)


def _given(provider: T | Callable[[], T | None] | None) -> T | None:
    """An explicit dependency: the object itself, or a provider called now (wired later in the runtime).
    Never guessed from attributes (Wave 2+ notes; review R1-08)."""
    return provider() if callable(provider) else provider


class ExploreAreasService:
    """``AreasService``; ``.directory`` is the ``AreaDirectory`` and ``.recorder`` the ``SignalRecorder``."""

    def __init__(
        self,
        kb: KnowledgeService,
        *,
        science: ScienceClient | Callable[[], ScienceClient | None] | None = None,
        decisions: DecisionLayer | Callable[[], DecisionLayer | None] | None = None,
        publication_dates: PublicationDates | Callable[[], PublicationDates | None] | None = None,
        repeat_summaries: RepeatSummaries | Callable[[], RepeatSummaries | None] | None = None,
        freshness_marks: FreshnessMarkReader | Callable[[], FreshnessMarkReader | None] | None = None,
        explore: ExploreService | Callable[[], ExploreService | None] | None = None,
        finding_exists: Callable[[str], bool] | None = None,
        new_findings_by_area: Callable[[], Mapping[str, int]] | None = None,
        ingest: IngestService | Callable[[], IngestService | None] | None = None,
        wiki_jobs: WikiJobs | Callable[[], WikiJobs | None] | None = None,
        topic_search: Callable[[], TopicSearch | None] | None = None,
    ) -> None:
        """``science`` is no longer read by the map (EX2: no taxonomy on GET); the hidden topic label uses
        ``topic_search`` (B1's free OpenAlex ``/topics`` search) and ``decisions``. ``ingest`` and
        ``wiki_jobs`` run the "Sort materials" job on the wiki agent."""
        self.kb = kb
        self._signals = SignalStore(kb.db)
        self.recorder: SignalRecorder = self._signals
        self.store = AreasStore(kb, self._signals)
        self.directory: AreaDirectory = self.store
        #: EX2: the largest topics and their main concepts (X2's "All your topics" plan).
        self.topic_directory: TopicDirectory = self.store
        self._science = science
        self._decisions = decisions
        self._publication_dates = publication_dates
        self._repeat_summaries = repeat_summaries
        self._freshness_marks = freshness_marks
        self._explore = explore
        self._finding_exists = finding_exists
        self._new_findings_by_area = new_findings_by_area
        self._ingest = ingest
        self._wiki_jobs = wiki_jobs
        self.topic_store: TopicStore = self.store.topic_store
        self.mapper = TopicMapper(
            self.topic_store,
            search=lambda: topic_search() if topic_search is not None else None,
            decisions=lambda: _given(self._decisions),
        )
        labels = TopicLabels(self.topic_store)
        #: ``IngestService.topics``: the material's topic at the end of its wiki processing.
        self.labeller: TopicLabeller = MaterialLabeller(labels, self.mapper.schedule)
        self.sorting = TopicSorting(
            kb,
            labels,
            ingest=lambda: _given(self._ingest),
            wiki_jobs=lambda: _given(self._wiki_jobs),
            after_new_topics=self.mapper.schedule,
        )

    def _ensure_ready(self) -> None:
        """No library yet → ``not_ready`` (like every 0.4.0 slice), not an empty map that looks like a
        result."""
        if self.kb.view().state == "not_configured":
            raise ContractFailure(503, "not_ready")

    # -- Convenience delegation for SignalRecorder & non-colliding AreaDirectory methods --

    def record(self, draft: SignalDraft) -> KbFactualSignal:
        return self.recorder.record(draft)

    def area_for_topics(self, topic_ids: Sequence[str]) -> str | None:
        return self.directory.area_for_topics(topic_ids)

    def area_path(self, area_id: str) -> Sequence[str]:
        return self.directory.area_path(area_id)

    def topics(self, area_id: str) -> Sequence[str]:
        return self.directory.topics(area_id)

    def pinned(self) -> Sequence[str]:
        return self.directory.pinned()

    def recently_active(self, limit: int = 10) -> Sequence[str]:
        return self.directory.recently_active(limit=limit)

    def read_marks(self, material_ids: Sequence[str]) -> Mapping[str, KbReadMarkValue]:
        return self.directory.read_marks(material_ids)

    def move_finding_mark_to_material(self, finding_id: str, material_id: str) -> KbReadMark | None:
        return self.store.move_finding_mark_to_material(finding_id, material_id)

    # -- Internal helpers for protocol queries -------------------------------

    async def _fetch_publication_dates(
        self, material_ids: Sequence[str] | None = None
    ) -> Mapping[str, KbPublicationDate]:
        pub_reader = _given(self._publication_dates)
        if pub_reader is None:
            return {}
        if material_ids is None:
            records = await disk_call(self.kb.material_repo.list_all)
            material_ids = [r.id for r in records]
        if not material_ids:
            return {}
        return await disk_call(pub_reader.dates, material_ids)

    async def _fetch_new_findings_counts(self) -> Mapping[str, int]:
        if self._new_findings_by_area is not None:
            return await disk_call(self._new_findings_by_area)
        explore = _given(self._explore)
        if explore is None:
            return {}
        try:
            findings_resp = await explore.findings(include_covered=False, limit=100)
        except Exception:
            return {}
        counts: Counter[str] = Counter()
        for group in findings_resp.groups:
            for finding in group.findings:
                if finding.area_id and finding.label != "covered":
                    counts[finding.area_id] += 1
        return dict(counts)

    async def _verify_finding_exists(self, finding_id: str) -> str | None:
        """Returns linked ``material_id`` if the finding was already imported to the wiki."""
        if self._finding_exists is not None:
            exists = await disk_call(self._finding_exists, finding_id)
            if not exists:
                raise NotFound("Finding not found.")
            return None
        explore = _given(self._explore)
        if explore is not None:
            finding = await explore.finding(finding_id)
            return finding.material_id
        return None

    # -- AreasService Protocol -----------------------------------------------

    async def map(self, parent_id: str | None = None, include_hidden: bool = False) -> KbAreaMap:
        """Stored state only: no model call, no network (EX2)."""
        self._ensure_ready()
        labelling = await disk_call(self.sorting.state)
        pub_dates = await self._fetch_publication_dates()
        finding_counts = await self._fetch_new_findings_counts()
        return await disk_call(
            self.store.build_map,
            parent_id,
            include_hidden=include_hidden,
            publication_dates=pub_dates,
            new_findings_by_area=finding_counts,
            labelling=labelling,
        )

    async def create(self, body: KbAreaCreate) -> KbArea:
        self._ensure_ready()
        pub_dates = await self._fetch_publication_dates()
        finding_counts = await self._fetch_new_findings_counts()
        area = await disk_call(
            self.store.create_custom,
            body,
            publication_dates=pub_dates,
            new_findings_by_area=finding_counts,
        )
        self.mapper.schedule()
        return area

    async def update(self, area_id: str, body: KbAreaUpdate) -> KbArea:
        self._ensure_ready()
        pub_dates = await self._fetch_publication_dates()
        finding_counts = await self._fetch_new_findings_counts()
        area = await disk_call(
            self.store.update_area,
            area_id,
            body,
            publication_dates=pub_dates,
            new_findings_by_area=finding_counts,
        )
        if body.name is not None:
            self.mapper.schedule()  # a renamed topic gets its hidden label again
        return area

    async def delete(self, area_id: str) -> KbAcknowledged:
        self._ensure_ready()
        return await disk_call(self.store.delete_area, area_id)

    async def opened(self, area_id: str) -> KbAcknowledged:
        self._ensure_ready()
        return await disk_call(self.store.record_opened, area_id)

    async def materials(
        self, area_id: str, cursor: str | None = None, limit: int = 30
    ) -> KbAreaMaterials:
        self._ensure_ready()
        if limit < 1 or limit > 100:
            raise ContractFailure(422, "invalid_request")
        await disk_call(self.store.get_area_row, area_id)
        all_material_ids = list(await disk_call(self.store.materials, area_id))
        if not all_material_ids:
            if cursor is not None:
                raise ContractFailure(422, "invalid_request")
            return KbAreaMaterials(materials=[], not_checked_count=0, next_cursor=None)

        start_idx = 0
        if cursor is not None:
            if cursor in all_material_ids:
                start_idx = all_material_ids.index(cursor) + 1
            elif cursor.isdigit():
                start_idx = int(cursor)
                if start_idx > len(all_material_ids):
                    raise ContractFailure(422, "invalid_request")
            else:
                raise ContractFailure(422, "invalid_request")

        page_ids = all_material_ids[start_idx : start_idx + limit]
        has_more = (start_idx + limit) < len(all_material_ids)
        next_cursor = page_ids[-1] if has_more and page_ids else None

        repeat_reader = _given(self._repeat_summaries)
        repeats_map: Mapping[str, KbMaterialRepeats] = (
            await disk_call(repeat_reader.summaries, all_material_ids)
            if repeat_reader is not None
            else {}
        )
        not_checked_count = len(
            [
                mid
                for mid in all_material_ids
                if mid not in repeats_map or repeats_map[mid].status == "not_checked"
            ]
        )

        pub_dates = await self._fetch_publication_dates(page_ids)
        freshness_reader = _given(self._freshness_marks)
        freshness_map: Mapping[str, Sequence[str]] = (
            await disk_call(freshness_reader.mark_ids, page_ids)
            if freshness_reader is not None and page_ids
            else {}
        )
        marks_map = await disk_call(self.store.read_marks, page_ids)
        wiki_counts = await disk_call(self.store.wiki_page_counts_for_materials, page_ids)
        concept_counts = await disk_call(self.store.concept_counts_for_materials, page_ids)
        records_by_id = {
            r.id: r for r in await disk_call(self.kb.material_repo.list_all) if r.id in set(page_ids)
        }

        items: list[KbAreaMaterial] = []
        for mid in page_ids:
            rec = records_by_id.get(mid)
            if rec is None:
                continue
            rep = repeats_map.get(mid)
            repeat_status: Literal["checked", "not_checked"] = (
                rep.status if rep is not None else "not_checked"
            )
            repeated_percent = rep.percent if rep is not None else None
            repeats_titles = [m.title for m in rep.from_materials] if rep is not None else []
            items.append(
                KbAreaMaterial(
                    material_id=mid,
                    title=rec.title,
                    kind=cast(MaterialKind, rec.kind),
                    publication=pub_dates.get(mid, _UNKNOWN_PUBLICATION),
                    wiki_pages=wiki_counts.get(mid, 0),
                    concepts=concept_counts.get(mid, 0),
                    read_mark=marks_map.get(mid),
                    repeat_status=repeat_status,
                    repeated_percent=repeated_percent,
                    repeats_source_titles=repeats_titles,
                    freshness_mark_ids=list(freshness_map.get(mid, ())),
                )
            )

        return KbAreaMaterials(
            materials=items,
            not_checked_count=not_checked_count,
            next_cursor=next_cursor,
        )

    async def read_mark(self, material_id: str) -> KbReadMark:
        self._ensure_ready()
        return await disk_call(self.store.get_material_read_mark, material_id)

    async def set_read_mark(self, material_id: str, body: KbReadMarkUpdate) -> KbReadMark:
        self._ensure_ready()
        return await disk_call(self.store.set_material_read_mark, material_id, body)

    async def remove_read_mark(self, material_id: str) -> KbReadMark:
        self._ensure_ready()
        return await disk_call(self.store.remove_material_read_mark, material_id)

    async def set_finding_mark(self, finding_id: str, body: KbReadMarkUpdate) -> KbReadMark:
        self._ensure_ready()
        linked_material_id = await self._verify_finding_exists(finding_id)
        if linked_material_id is not None:
            return await disk_call(self.store.set_material_read_mark, linked_material_id, body)
        return await disk_call(self.store.set_finding_read_mark, finding_id, body)

    async def remove_finding_mark(self, finding_id: str) -> KbReadMark:
        self._ensure_ready()
        has_provider = self._finding_exists is not None or _given(self._explore) is not None
        linked_material_id = await self._verify_finding_exists(finding_id)
        if linked_material_id is not None:
            return await disk_call(self.store.remove_material_read_mark, linked_material_id)
        return await disk_call(
            self.store.remove_finding_read_mark,
            finding_id,
            require_existing_mark=not has_provider,
        )

    # -- EX2: own topics ----------------------------------------------------------

    async def sort_topics(self) -> KbTopicLabelling:
        """The user's click: the wiki agent sorts unsorted wiki materials (~20 per call), or a sorting
        paused at a usage limit continues. No wiki agent → 503 ``not_ready`` (the map says why)."""
        self._ensure_ready()
        return await self.sorting.start()

    async def merge(self, area_id: str, body: KbAreaMerge) -> KbArea:
        self._ensure_ready()
        await disk_call(self.topic_store.merge, area_id, body.into_id)
        self.mapper.schedule()  # the merged topic gets its hidden label again
        pub_dates = await self._fetch_publication_dates()
        finding_counts = await self._fetch_new_findings_counts()
        return await disk_call(
            self.store.get_area,
            body.into_id,
            publication_dates=pub_dates,
            new_findings_by_area=finding_counts,
        )

    async def set_material_topic(self, material_id: str, body: KbMaterialTopicSet) -> KbMaterialTopic:
        """The user's move wins over the agent's label; re-processing the material keeps it."""
        self._ensure_ready()
        return await disk_call(self.topic_store.move, material_id, body.area_id)

    async def map_topics(self, area_ids: Sequence[str] | None = None) -> int:
        """Make the missing hidden labels now (X2 may call it before a search inside a topic)."""
        return await self.mapper.map_pending(area_ids)

    async def signals(self, cursor: str | None = None, limit: int = 50) -> KbSignals:
        self._ensure_ready()
        return await disk_call(self._signals.list_signals, cursor=cursor, limit=limit)
