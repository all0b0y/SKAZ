"""``AreasService`` implementation for SKAZ 0.4.0 (B4)."""

from __future__ import annotations

from collections import Counter
from collections.abc import Callable, Mapping, Sequence
from typing import TYPE_CHECKING, Literal, TypeVar, cast

from ...native_io import disk_call
from ..agents.prompting import untrusted_block
from ..api.contract_routes import ContractFailure
from ..api.schemas_areas import (
    KbArea,
    KbAreaCreate,
    KbAreaMap,
    KbAreaMaterial,
    KbAreaMaterials,
    KbAreaUpdate,
    KbFactualSignal,
    KbReadMark,
    KbReadMarkUpdate,
    KbSignals,
)
from ..api.schemas_explore_common import KbAcknowledged, KbPublicationDate, KbReadMarkValue
from ..decisions.protocol import ChoiceAnswer, ChoiceQuestion, DecisionLayer, Undecided
from ..errors import NotFound
from ..markdown.source import MaterialKind
from ..science.protocols import ScienceClient, ScienceStop
from ..service import KnowledgeService
from .protocols import AreaDirectory, SignalDraft, SignalRecorder
from .signals import SignalStore
from .store import AreaRow, AreasStore

if TYPE_CHECKING:
    from ..api.schemas_repeats import KbMaterialRepeats
    from ..explore.protocols import ExploreService
    from ..freshness.protocols import PublicationDates
    from ..maintenance.protocols import FreshnessMarkReader
    from ..repeats.protocols import RepeatSummaries

T = TypeVar("T")
OFF_TOPIC_OPTION = "None of these: off-topic"
#: One call to the map asks the decision model about at most this many pages (a batch, as in the funnel).
PLACEMENT_BATCH = 30
PLACEMENT_UNDECIDED_STOP = 5
#: Pages the model called off-topic at a level, kept so the same question is never paid for twice.
_OFF_TOPIC_KEY = "explore.areas.off_topic"
_UNKNOWN_PUBLICATION = KbPublicationDate(
    year=None,
    date=None,
    month=None,
    precision="unknown",
    origin="unknown",
    evidence_url=None,
)


def _resolve(provider: T | Callable[[], T | None] | None, attr: str | None = None) -> T | None:
    obj: object = provider() if callable(provider) else provider
    if obj is None:
        return None
    if attr is not None and not hasattr(obj, attr):
        for nested in ("client", "store", "directory", "recorder", "reader"):
            candidate = getattr(obj, nested, None)
            if candidate is not None and hasattr(candidate, attr):
                return cast(T, candidate)
        return None
    return cast(T, obj)


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
    ) -> None:
        self.kb = kb
        self._signals = SignalStore(kb.db)
        self.recorder: SignalRecorder = self._signals
        self.store = AreasStore(kb, self._signals)
        self.directory: AreaDirectory = self.store
        self._science = science
        self._decisions = decisions
        self._publication_dates = publication_dates
        self._repeat_summaries = repeat_summaries
        self._freshness_marks = freshness_marks
        self._explore = explore
        self._finding_exists = finding_exists
        self._new_findings_by_area = new_findings_by_area

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

    async def _sync_taxonomy_level(self, parent_id: str | None) -> None:
        parent_row: AreaRow | None = None
        if parent_id is not None:
            parent_row = await disk_call(self.store.get_area_row, parent_id)
            if parent_row.level in ("topic", "custom"):
                return
        science = _resolve(self._science, "taxonomy")
        if science is None:
            return
        try:
            if parent_row is None:
                nodes = await science.taxonomy(None)
            else:
                lookup_id = parent_row.taxonomy_id or parent_row.id
                nodes = await science.taxonomy(lookup_id)
                if not nodes and parent_row.taxonomy_id and parent_row.taxonomy_id != parent_row.id:
                    nodes = await science.taxonomy(parent_row.id)
        except ScienceStop:
            return
        if nodes:
            await disk_call(self.store.sync_taxonomy_nodes, parent_id, nodes)

    def _page_prompt_state(self, page_id: str) -> str | None:
        record = self.kb.page_repo.get(page_id)
        if record is None:
            return None
        blocks = self.kb.page_repo.blocks(page_id)
        first = next((b.text for b in blocks if b.text.strip()), "")[:200]
        aliases = f" (aliases: {', '.join(record.aliases)})" if record.aliases else ""
        return f"{record.title}{aliases}: {first}"

    async def _place_pages_at_level(self, parent_id: str | None) -> None:
        await disk_call(self.store.place_pages_from_source_topics)
        children = await disk_call(self.store.children_of, parent_id, include_hidden=False)
        candidates = [c for c in children if c.level != "custom"]
        if not candidates:
            return
        decisions = _resolve(self._decisions, "ask")
        if decisions is None:
            return

        if parent_id is None:
            page_ids = await disk_call(self.store.unplaced_wiki_page_ids)
        else:
            page_ids = await disk_call(self.store.direct_wiki_page_ids, parent_id)
        if not page_ids:
            return

        options = [c.original_name for c in candidates] + [OFF_TOPIC_OPTION]
        by_option = {c.original_name: c.id for c in candidates}
        areas_text = "\n".join(c.original_name for c in candidates)

        level_key = parent_id or ""
        off_topic = await disk_call(self._off_topic_pages, level_key)
        asked = 0
        undecided_in_a_row = 0
        newly_off_topic: list[str] = []
        for page_id in page_ids:
            if page_id in off_topic:
                continue
            if asked >= PLACEMENT_BATCH:
                break
            page_text = await disk_call(self._page_prompt_state, page_id)
            if not page_text:
                continue
            state = "\n".join(
                [
                    untrusted_block("wiki page", page_text),
                    untrusted_block("areas", areas_text),
                ]
            )
            question = ChoiceQuestion(
                state=state,
                question="Which area does this wiki page belong to?",
                options=options,
            )
            asked += 1
            try:
                answer = await decisions.ask(question)
            except Exception:
                answer = Undecided("the decision layer failed")
            undecided_in_a_row = undecided_in_a_row + 1 if isinstance(answer, Undecided) else 0
            if isinstance(answer, ChoiceAnswer) and answer.option == OFF_TOPIC_OPTION:
                newly_off_topic.append(page_id)
            elif isinstance(answer, ChoiceAnswer) and answer.option in by_option:
                chosen_id = by_option[answer.option]
                await disk_call(
                    self.store.assign_page,
                    chosen_id,
                    page_id,
                    replace_area_id=parent_id,
                )
            if undecided_in_a_row >= PLACEMENT_UNDECIDED_STOP:
                break  # the model is unavailable or unsure: do not keep asking on this call
        if newly_off_topic:
            await disk_call(self._remember_off_topic, level_key, newly_off_topic)

    def _off_topic_pages(self, level_key: str) -> set[str]:
        raw = self.kb.settings.get(_OFF_TOPIC_KEY, {})
        pages = raw.get(level_key, []) if isinstance(raw, dict) else []
        return {str(p) for p in pages} if isinstance(pages, list) else set()

    def _remember_off_topic(self, level_key: str, page_ids: Sequence[str]) -> None:
        raw = self.kb.settings.get(_OFF_TOPIC_KEY, {})
        stored: dict[str, list[str]] = dict(raw) if isinstance(raw, dict) else {}
        stored[level_key] = sorted({*stored.get(level_key, []), *page_ids})
        self.kb.settings.set(_OFF_TOPIC_KEY, stored)

    async def _fetch_publication_dates(
        self, material_ids: Sequence[str] | None = None
    ) -> Mapping[str, KbPublicationDate]:
        pub_reader = _resolve(self._publication_dates, "dates")
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
        explore = _resolve(self._explore, "findings")
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
        explore = _resolve(self._explore, "finding")
        if explore is not None:
            finding = await explore.finding(finding_id)
            return finding.material_id
        return None

    # -- AreasService Protocol -----------------------------------------------

    async def map(self, parent_id: str | None = None, include_hidden: bool = False) -> KbAreaMap:
        await self._sync_taxonomy_level(parent_id)
        await self._place_pages_at_level(parent_id)
        pub_dates = await self._fetch_publication_dates()
        finding_counts = await self._fetch_new_findings_counts()
        return await disk_call(
            self.store.build_map,
            parent_id,
            include_hidden=include_hidden,
            publication_dates=pub_dates,
            new_findings_by_area=finding_counts,
        )

    async def create(self, body: KbAreaCreate) -> KbArea:
        pub_dates = await self._fetch_publication_dates()
        finding_counts = await self._fetch_new_findings_counts()
        return await disk_call(
            self.store.create_custom,
            body,
            publication_dates=pub_dates,
            new_findings_by_area=finding_counts,
        )

    async def update(self, area_id: str, body: KbAreaUpdate) -> KbArea:
        pub_dates = await self._fetch_publication_dates()
        finding_counts = await self._fetch_new_findings_counts()
        return await disk_call(
            self.store.update_area,
            area_id,
            body,
            publication_dates=pub_dates,
            new_findings_by_area=finding_counts,
        )

    async def delete(self, area_id: str) -> KbAcknowledged:
        return await disk_call(self.store.delete_area, area_id)

    async def opened(self, area_id: str) -> KbAcknowledged:
        return await disk_call(self.store.record_opened, area_id)

    async def materials(
        self, area_id: str, cursor: str | None = None, limit: int = 30
    ) -> KbAreaMaterials:
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

        repeat_reader = _resolve(self._repeat_summaries, "summaries")
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
        freshness_reader = _resolve(self._freshness_marks, "mark_ids")
        freshness_map: Mapping[str, Sequence[str]] = (
            await disk_call(freshness_reader.mark_ids, page_ids)
            if freshness_reader is not None and page_ids
            else {}
        )
        marks_map = await disk_call(self.store.read_marks, page_ids)
        wiki_counts = await disk_call(self.store.wiki_page_counts_for_materials, page_ids)
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
        return await disk_call(self.store.get_material_read_mark, material_id)

    async def set_read_mark(self, material_id: str, body: KbReadMarkUpdate) -> KbReadMark:
        return await disk_call(self.store.set_material_read_mark, material_id, body)

    async def remove_read_mark(self, material_id: str) -> KbReadMark:
        return await disk_call(self.store.remove_material_read_mark, material_id)

    async def set_finding_mark(self, finding_id: str, body: KbReadMarkUpdate) -> KbReadMark:
        linked_material_id = await self._verify_finding_exists(finding_id)
        if linked_material_id is not None:
            return await disk_call(self.store.set_material_read_mark, linked_material_id, body)
        return await disk_call(self.store.set_finding_read_mark, finding_id, body)

    async def remove_finding_mark(self, finding_id: str) -> KbReadMark:
        has_provider = self._finding_exists is not None or _resolve(self._explore, "finding") is not None
        linked_material_id = await self._verify_finding_exists(finding_id)
        if linked_material_id is not None:
            return await disk_call(self.store.remove_material_read_mark, linked_material_id)
        return await disk_call(
            self.store.remove_finding_read_mark,
            finding_id,
            require_existing_mark=not has_provider,
        )

    async def signals(self, cursor: str | None = None, limit: int = 50) -> KbSignals:
        return await disk_call(self._signals.list_signals, cursor=cursor, limit=limit)
