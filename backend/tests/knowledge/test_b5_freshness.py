"""Slice B5 tests: real publication dates, N7-5 library date filter, and manual link checks."""

from __future__ import annotations

from collections.abc import Collection, Sequence
from datetime import UTC, date, datetime, timedelta
from typing import Any, cast

import httpx
import pytest

from skaz.knowledge.api.schemas_areas import KbReadMarkValue
from skaz.knowledge.api.schemas_explore_common import (
    KbCheckpoint,
    KbDateWindow,
    KbExploreJob,
    KbJobOwner,
    KbMaterialRef,
    KbPublicationDate,
    KbRunBudget,
    KbRunCounters,
    KbRunStage,
    KbStopReason,
)
from skaz.knowledge.api.schemas_freshness import KbLibraryDateQuery, KbLinkCheckStart
from skaz.knowledge.api.schemas_repeats import KbMaterialRepeats
from skaz.knowledge.areas.protocols import AreaDirectory
from skaz.knowledge.errors import NotFound
from skaz.knowledge.freshness import FreshnessService
from skaz.knowledge.library.layout import SERVICE_DIR
from skaz.knowledge.markdown.source import FragmentInput, Origin
from skaz.knowledge.science.protocols import ScienceClient, ScienceConsentRequired, ScienceRef
from skaz.knowledge.service import KnowledgeService
from skaz.knowledge.sources.fetch import SafeFetcher


class FakeScienceClient:
    def __init__(
        self,
        publications: dict[str, KbPublicationDate] | None = None,
        *,
        error: Exception | None = None,
    ) -> None:
        self.publications = publications or {}
        self.error = error
        self.calls: list[ScienceRef] = []

    async def publication(self, ref: ScienceRef, *, run_id: str | None = None) -> KbPublicationDate:
        self.calls.append(ref)
        if self.error is not None:
            raise self.error
        for key in (ref.doi, ref.arxiv_id, ref.material_id):
            if key and key in self.publications:
                return self.publications[key]
        return KbPublicationDate(
            year=None, date=None, month=None, precision="unknown", origin="unknown", evidence_url=None
        )


class FakeJobStore:
    """In-memory implementation of ``JobStore`` protocol for testing B5 in isolation."""

    def __init__(self) -> None:
        self.jobs: dict[str, KbExploreJob] = {}
        self.completed_work: dict[tuple[str, str], dict[str, str]] = {}
        self._seq = 0

    def create(
        self, owner: KbJobOwner, title: str, stage: KbRunStage, budget: KbRunBudget
    ) -> KbExploreJob:
        self._seq += 1
        job_id = f"job-{self._seq}"
        now = datetime(2026, 11, 9, 10, 0, tzinfo=UTC)
        job = KbExploreJob(
            id=job_id,
            owner=owner,
            state="running",
            stage=stage,
            stop_reason=None,
            budget=budget,
            counters=KbRunCounters(
                checked=0,
                after_rules=0,
                decided=0,
                on_topic=0,
                novelty_checked=0,
                new=0,
                covered=0,
            ),
            checkpoint=None,
            decision_provider="local",
            decision_choices=[],
            retry_at=None,
            created_at=now,
            updated_at=now,
        )
        self.jobs[job_id] = job
        return job

    def get(self, job_id: str) -> KbExploreJob | None:
        return self.jobs.get(job_id)

    def active(self) -> Sequence[KbExploreJob]:
        return [j for j in self.jobs.values() if j.state in ("queued", "running", "paused")]


    # 0.4.0 review round: the fix batch FX-B replaces this fake with the real SqliteJobStore (R2-09).
    def claim_paused(self, job_id: str, *, checkpoint_id: str, revision: int,
                     budget: KbRunBudget | None = None) -> KbExploreJob:
        raise AssertionError("not used by these tests")

    def advance(self, job_id: str, *, stage: KbRunStage, budget: KbRunBudget,
                counters: KbRunCounters) -> KbExploreJob:
        raise AssertionError("not used by these tests")

    def progress(
        self, job_id: str, *, stage: KbRunStage, budget: KbRunBudget, counters: KbRunCounters
    ) -> KbExploreJob:
        job = self.jobs[job_id]
        updated = job.model_copy(
            update={
                "state": "running",
                "stop_reason": None,
                "stage": stage,
                "budget": budget,
                "counters": counters,
                "updated_at": datetime(2026, 11, 9, 10, 5, tzinfo=UTC),
            }
        )
        self.jobs[job_id] = updated
        return updated

    def stop(
        self, job_id: str, reason: KbStopReason, *, retry_at: str | None = None
    ) -> KbExploreJob:
        job = self.jobs[job_id]
        if reason == "completed":
            state = "done"
            checkpoint = None
        elif reason == "cancelled":
            state = "cancelled"
            checkpoint = job.checkpoint
        elif reason == "failed":
            state = "error"
            checkpoint = job.checkpoint
        else:
            state = "paused"
            checkpoint = job.checkpoint
        updated = job.model_copy(
            update={
                "state": state,
                "stop_reason": reason,
                "checkpoint": checkpoint,
                "retry_at": retry_at,
                "updated_at": datetime(2026, 11, 9, 10, 10, tzinfo=UTC),
            }
        )
        self.jobs[job_id] = updated
        return updated

    def checkpoint(
        self,
        job_id: str,
        *,
        stage: KbRunStage,
        cursor: str | None,
        completed_ids: Sequence[str],
        pending_ids: Sequence[str],
    ) -> KbCheckpoint:
        job = self.jobs[job_id]
        rev = (job.checkpoint.revision + 1) if job.checkpoint is not None else 1
        cp = KbCheckpoint(
            id=f"cp-{job_id}-{rev}",
            revision=rev,
            stage=stage,
            cursor=cursor,
            completed_ids=list(completed_ids),
            pending_ids=list(pending_ids),
            saved_at=datetime(2026, 11, 9, 10, 6, tzinfo=UTC),
        )
        self.jobs[job_id] = job.model_copy(update={"checkpoint": cp})
        return cp

    def complete(self, job_id: str, candidate_id: str, stage: KbRunStage, result_json: str) -> None:
        bucket = self.completed_work.setdefault((job_id, stage), {})
        if candidate_id in bucket:
            raise ValueError(f"Duplicate completed work: {candidate_id}")
        bucket[candidate_id] = result_json

    def completed(self, job_id: str, stage: KbRunStage) -> Collection[str]:
        return set(self.completed_work.get((job_id, stage), {}).keys())

    def recover(self) -> Sequence[str]:
        return []


class FakeMarkWriter:
    def __init__(self) -> None:
        self.gone_calls: list[tuple[str, str]] = []
        self.back_calls: list[str] = []
        self.marks_by_material: dict[str, list[str]] = {}

    def link_gone(self, material_id: str, evidence_url: str) -> str:
        self.gone_calls.append((material_id, evidence_url))
        mark_id = f"mark-gone-{material_id}"
        ids = self.marks_by_material.setdefault(material_id, [])
        if mark_id not in ids:
            ids.append(mark_id)
        return mark_id

    def link_back(self, material_id: str) -> None:
        self.back_calls.append(material_id)
        self.marks_by_material.pop(material_id, None)

    def mark_ids(self, material_ids: Sequence[str]) -> dict[str, list[str]]:
        return {mid: list(self.marks_by_material.get(mid, [])) for mid in material_ids}


class FakeAreaDirectory:
    def __init__(self, marks: dict[str, KbReadMarkValue] | None = None) -> None:
        self.marks = marks or {}

    def read_marks(self, material_ids: Sequence[str]) -> dict[str, KbReadMarkValue]:
        return {tid: self.marks[tid] for tid in material_ids if tid in self.marks}


class FakeRepeatSummaries:
    def __init__(self, data: dict[str, KbMaterialRepeats] | None = None) -> None:
        self.data = data or {}

    def summaries(self, material_ids: Sequence[str]) -> dict[str, KbMaterialRepeats]:
        return {mid: self.data[mid] for mid in material_ids if mid in self.data}


def _add_material(
    kb: KnowledgeService,
    *,
    title: str,
    folder_id: str | None = None,
    kind: str = "web",
    origin: dict[str, Any] | None = None,
    html: str | None = None,
    text: str = "Sample fragment text.",
) -> str:
    target_folder = folder_id or kb.folders()[0].id
    origin_model = Origin.model_validate(origin) if origin is not None else None
    created = kb.create_material(
        target_folder,
        title=title,
        kind=kind,  # type: ignore[arg-type]
        status="ready",
        origin=origin_model,
        fragments=[FragmentInput(text=text)],
    )
    if html is not None:
        skaz_dir = created.directory / SERVICE_DIR
        skaz_dir.mkdir(parents=True, exist_ok=True)
        (skaz_dir / "original.html").write_text(html, encoding="utf-8")
    return created.manifest.id


async def test_publication_not_found_raises_404(ready: KnowledgeService) -> None:
    svc = FreshnessService(ready)
    with pytest.raises(NotFound):
        await svc.publication("missing-material")


async def test_publication_resolves_science_doi_and_arxiv_and_caches(
    ready: KnowledgeService,
) -> None:
    science = FakeScienceClient(
        {
            "10.1145/3600000.3600001": KbPublicationDate(
                year=2025,
                month=5,
                date=date(2025, 5, 20),
                precision="day",
                origin="crossref",
                evidence_url="https://doi.org/10.1145/3600000.3600001",
            ),
            "2403.05123": KbPublicationDate(
                year=2024,
                month=3,
                date=date(2024, 3, 14),
                precision="day",
                origin="arxiv",
                evidence_url="https://arxiv.org/abs/2403.05123v2",
            ),
        }
    )
    svc = FreshnessService(ready, science=cast(ScienceClient, science))

    doi_mat = _add_material(
        ready,
        title="DOI paper",
        kind="pdf",
        origin={"type": "url", "url": "https://doi.org/10.1145/3600000.3600001"},
    )
    arxiv_mat = _add_material(
        ready,
        title="arXiv paper",
        kind="pdf",
        origin={"type": "url", "url": "https://arxiv.org/abs/2403.05123v2"},
    )

    pub_doi = await svc.publication(doi_mat)
    assert pub_doi.material_id == doi_mat
    assert pub_doi.publication.precision == "day"
    assert pub_doi.publication.year == 2025
    assert pub_doi.publication.date == date(2025, 5, 20)
    assert pub_doi.publication.origin == "crossref"

    pub_arxiv = await svc.publication(arxiv_mat)
    assert pub_arxiv.publication.precision == "day"
    assert pub_arxiv.publication.year == 2024
    assert pub_arxiv.publication.origin == "arxiv"
    assert science.calls[-1].arxiv_id == "2403.05123"
    assert science.calls[-1].version == "v2"

    # Second call reads from material_publications cache without calling ScienceClient again.
    call_count = len(science.calls)
    pub_cached = await svc.publication(doi_mat)
    assert pub_cached.publication == pub_doi.publication
    assert len(science.calls) == call_count

    # Synchronous PublicationDates protocol also returns cached dates.
    batch = svc.dates([doi_mat, arxiv_mat])
    assert batch[doi_mat].year == 2025
    assert batch[arxiv_mat].year == 2024


async def test_publication_from_page_metadata_partial_precision_and_never_import_date(
    ready: KnowledgeService,
) -> None:
    svc = FreshnessService(
        ready,
        science=cast(ScienceClient, FakeScienceClient(error=ScienceConsentRequired())),
    )

    day_mat = _add_material(
        ready,
        title="Day article",
        origin={
            "type": "url",
            "url": "https://example.org/day-post",
            "fetched_at": "2026-11-09T10:00:00Z",
        },
        html=(
            '<html><head><meta property="article:published_time" '
            'content="2024-08-19T14:22:00Z"></head><body><p>Body</p></body></html>'
        ),
    )
    month_mat = _add_material(
        ready,
        title="Month article",
        origin={"type": "url", "url": "https://example.org/month-post"},
        html=(
            '<html><head><meta name="citation_publication_date" content="2023/11">'
            "</head><body><p>Body</p></body></html>"
        ),
    )
    year_mat = _add_material(
        ready,
        title="Year article",
        origin={"type": "url", "url": "https://example.org/year-post"},
        html=(
            '<html><head><script type="application/ld+json">'
            '{"@type":"Article","datePublished":"2021"}'
            "</script></head><body><p>Body</p></body></html>"
        ),
    )
    undated_recording = _add_material(
        ready,
        title="Voice note",
        kind="audio",
        origin={"type": "recording", "created_at": "2026-11-09T10:00:00Z"},
    )
    undated_web = _add_material(
        ready,
        title="Undated page",
        origin={
            "type": "url",
            "url": "https://arxiv.org/abs/2403.05123v1",
            "fetched_at": "2026-11-09T10:00:00Z",
        },
        html="<html><head><title>No date meta</title></head><body><p>Body</p></body></html>",
    )

    res_day = await svc.publication(day_mat)
    assert res_day.publication.precision == "day"
    assert res_day.publication.year == 2024
    assert res_day.publication.month == 8
    assert res_day.publication.date == date(2024, 8, 19)
    assert res_day.publication.origin == "page"
    assert res_day.publication.evidence_url == "https://example.org/day-post"

    res_month = await svc.publication(month_mat)
    assert res_month.publication.precision == "month"
    assert res_month.publication.year == 2023
    assert res_month.publication.month == 11
    assert res_month.publication.date is None
    assert res_month.publication.origin == "page"

    res_year = await svc.publication(year_mat)
    assert res_year.publication.precision == "year"
    assert res_year.publication.year == 2021
    assert res_year.publication.month is None
    assert res_year.publication.date is None
    assert res_year.publication.origin == "page"

    # Import date / fetched_at is NEVER used as publication date.
    res_rec = await svc.publication(undated_recording)
    assert res_rec.publication.precision == "unknown"
    assert res_rec.publication.origin == "unknown"
    assert res_rec.publication.year is None
    assert res_rec.publication.date is None

    # ScienceStop (no consent) falls back gracefully to unknown when page has no date meta.
    res_undated = await svc.publication(undated_web)
    assert res_undated.publication.precision == "unknown"
    assert res_undated.publication.year is None


async def test_filter_dates_window_unknown_modes_folder_pagination_and_enrichment(
    ready: KnowledgeService,
) -> None:
    folder_a = ready.create_folder("Area A").id
    folder_b = ready.create_folder("Area B").id

    mat_2025 = _add_material(
        ready,
        title="Paper 2025-04-10",
        folder_id=folder_a,
        origin={"type": "url", "url": "https://example.org/p2025"},
        html='<html><head><meta name="date" content="2025-04-10"></head><body><p>A</p></body></html>',
    )
    mat_2024_month = _add_material(
        ready,
        title="Paper 2024-11",
        folder_id=folder_a,
        origin={"type": "url", "url": "https://example.org/p2024m"},
        html='<html><head><meta name="date" content="2024-11"></head><body><p>B</p></body></html>',
    )
    mat_2024_year = _add_material(
        ready,
        title="Paper 2024 year only",
        folder_id=folder_a,
        origin={"type": "url", "url": "https://example.org/p2024y"},
        html='<html><head><meta name="date" content="2024"></head><body><p>C</p></body></html>',
    )
    mat_2022 = _add_material(
        ready,
        title="Paper 2022 old",
        folder_id=folder_a,
        origin={"type": "url", "url": "https://example.org/p2022"},
        html='<html><head><meta name="date" content="2022-05-01"></head><body><p>D</p></body></html>',
    )
    mat_unknown = _add_material(
        ready,
        title="Lecture Recording",
        folder_id=folder_a,
        kind="audio",
        origin={"type": "recording", "created_at": "2025-06-01T10:00:00Z"},
    )
    _add_material(
        ready,
        title="Other Folder 2025",
        folder_id=folder_b,
        origin={"type": "url", "url": "https://example.org/other"},
        html='<html><head><meta name="date" content="2025-01-15"></head><body><p>E</p></body></html>',
    )

    marks = FakeMarkWriter()
    marks.link_gone(mat_2025, "https://example.org/p2025")
    areas = FakeAreaDirectory({mat_2025: "useful_method"})
    repeats = FakeRepeatSummaries(
        {
            mat_2025: KbMaterialRepeats(
                material_id=mat_2025,
                status="checked",
                percent=75,
                repeated=3,
                total=4,
                from_materials=[KbMaterialRef(material_id="mat-old", title="Earlier Source")],
                paragraphs=[],
                checked_at=datetime(2026, 11, 9, 10, 0, tzinfo=UTC),
            )
        }
    )

    svc = FreshnessService(
        ready,
        mark_writer=marks,
        mark_reader=marks,
        area_directory=cast(AreaDirectory, areas),
        repeat_summaries=repeats,
    )

    # 1. Full 2024-2025 window with unknown="exclude" in folder_a
    res_excl = await svc.filter_dates(
        KbLibraryDateQuery(
            dates=KbDateWindow(
                from_date=date(2024, 1, 1), to_date=date(2025, 12, 31), unknown="exclude"
            ),
            folder_id=folder_a,
        )
    )
    assert [m.material_id for m in res_excl.materials] == [
        mat_2025,
        mat_2024_month,
        mat_2024_year,
    ]
    assert res_excl.unknown_date == []
    assert res_excl.next_cursor is None

    # Check enrichment on mat_2025
    first = res_excl.materials[0]
    assert first.read_mark == "useful_method"
    assert first.repeat_status == "checked"
    assert first.repeated_percent == 75
    assert first.repeats_source_titles == ["Earlier Source"]
    assert first.freshness_mark_ids == [f"mark-gone-{mat_2025}"]

    # 2. Same window with unknown="separate"
    res_sep = await svc.filter_dates(
        KbLibraryDateQuery(
            dates=KbDateWindow(
                from_date=date(2024, 1, 1), to_date=date(2025, 12, 31), unknown="separate"
            ),
            folder_id=folder_a,
        )
    )
    assert [m.material_id for m in res_sep.materials] == [
        mat_2025,
        mat_2024_month,
        mat_2024_year,
    ]
    assert [m.material_id for m in res_sep.unknown_date] == [mat_unknown]

    # 3. Sub-year window (from 2024-06-01): year-only 2024 is NOT assumed to be >= June 2024
    res_subyear = await svc.filter_dates(
        KbLibraryDateQuery(
            dates=KbDateWindow(
                from_date=date(2024, 6, 1), to_date=date(2025, 12, 31), unknown="exclude"
            ),
            folder_id=folder_a,
        )
    )
    assert [m.material_id for m in res_subyear.materials] == [mat_2025, mat_2024_month]

    # 4. Pagination with limit=2 and cursor
    page1 = await svc.filter_dates(
        KbLibraryDateQuery(
            dates=KbDateWindow(
                from_date=date(2024, 1, 1), to_date=date(2025, 12, 31), unknown="exclude"
            ),
            folder_id=folder_a,
            limit=2,
        )
    )
    assert [m.material_id for m in page1.materials] == [mat_2025, mat_2024_month]
    assert page1.next_cursor is not None

    page2 = await svc.filter_dates(
        KbLibraryDateQuery(
            dates=KbDateWindow(
                from_date=date(2024, 1, 1), to_date=date(2025, 12, 31), unknown="exclude"
            ),
            folder_id=folder_a,
            limit=2,
            cursor=page1.next_cursor,
        )
    )
    assert [m.material_id for m in page2.materials] == [mat_2024_year]
    assert page2.next_cursor is None
    assert mat_2022 not in [m.material_id for m in page1.materials + page2.materials]


async def test_link_check_outcomes_and_two_step_one_day_confirmation(
    ready: KnowledgeService,
) -> None:
    folder = ready.create_folder("Links Folder").id
    mat_ok = _add_material(
        ready,
        title="OK Link",
        folder_id=folder,
        origin={"type": "url", "url": "https://ok.example.org/doc"},
    )
    mat_404 = _add_material(
        ready,
        title="404 Link",
        folder_id=folder,
        origin={"type": "url", "url": "https://gone404.example.org/doc"},
    )
    mat_410 = _add_material(
        ready,
        title="410 Link",
        folder_id=folder,
        origin={"type": "url", "url": "https://gone410.example.org/doc"},
    )
    mat_dns = _add_material(
        ready,
        title="Dead Domain Link",
        folder_id=folder,
        origin={"type": "url", "url": "https://nodomain.example.org/doc"},
    )
    mat_403 = _add_material(
        ready,
        title="Forbidden Link",
        folder_id=folder,
        origin={"type": "url", "url": "https://forbidden.example.org/doc"},
    )
    mat_429 = _add_material(
        ready,
        title="Rate Limited Link",
        folder_id=folder,
        origin={"type": "url", "url": "https://ratelimit.example.org/doc"},
    )
    mat_timeout = _add_material(
        ready,
        title="Timeout Link",
        folder_id=folder,
        origin={"type": "url", "url": "https://timeout.example.org/doc"},
    )
    mat_private = _add_material(
        ready,
        title="Private Address",
        folder_id=folder,
        origin={"type": "url", "url": "http://127.0.0.1/internal"},
    )

    status_by_host = {
        "ok.example.org": 200,
        "gone404.example.org": 404,
        "gone410.example.org": 410,
        "forbidden.example.org": 403,
        "ratelimit.example.org": 429,
    }

    async def fake_resolver(host: str) -> list[str]:
        if host == "nodomain.example.org":
            return []
        return ["93.184.216.34"]

    def handle_request(request: httpx.Request) -> httpx.Response:
        host = request.headers.get("Host", request.url.host)
        if host == "timeout.example.org":
            raise httpx.ReadTimeout("timed out", request=request)
        status = status_by_host.get(host, 500)
        return httpx.Response(status, text="body")

    fetcher = SafeFetcher(
        transport=httpx.MockTransport(handle_request),
        resolver=fake_resolver,
    )
    current_time = datetime(2026, 11, 9, 10, 0, tzinfo=UTC)
    marks = FakeMarkWriter()
    jobs = FakeJobStore()
    svc = FreshnessService(
        ready,
        job_store=jobs,
        mark_writer=marks,
        fetcher=fetcher,
        clock=lambda: current_time,
    )

    # First check at T0: 404, 410, and no_domain are suspected_gone, NOT confirmed_gone!
    check1 = await svc.check_links(KbLinkCheckStart(folder_id=folder))
    assert check1.state == "done"
    obs1 = {o.material_id: o for o in check1.observations}

    assert obs1[mat_ok].outcome == "ok"
    assert obs1[mat_ok].status_code == 200
    assert obs1[mat_ok].reason is None

    for mid, expected_reason, expected_code in (
        (mat_404, "http_404", 404),
        (mat_410, "http_410", 410),
        (mat_dns, "no_domain", None),
    ):
        assert obs1[mid].outcome == "suspected_gone"
        assert obs1[mid].reason == expected_reason
        assert obs1[mid].status_code == expected_code
        assert obs1[mid].first_gone_at == current_time
        assert obs1[mid].confirm_after == current_time + timedelta(days=1)

    assert obs1[mat_403].outcome == "could_not_check"
    assert obs1[mat_403].reason == "http_403"
    assert obs1[mat_403].status_code == 403
    assert obs1[mat_403].first_gone_at is None

    assert obs1[mat_429].outcome == "could_not_check"
    assert obs1[mat_429].reason == "http_429"
    assert obs1[mat_429].status_code == 429

    assert obs1[mat_timeout].outcome == "could_not_check"
    assert obs1[mat_timeout].reason == "timeout"
    assert obs1[mat_timeout].status_code is None

    assert obs1[mat_private].outcome == "could_not_check"
    assert obs1[mat_private].reason == "other"

    assert marks.gone_calls == []

    # Second check 12 hours later (< 1 day): still suspected_gone, no marks written.
    t0 = current_time
    current_time = t0 + timedelta(hours=12)
    check2 = await svc.check_links(
        KbLinkCheckStart(material_ids=[mat_404, mat_410, mat_dns])
    )
    obs2 = {o.material_id: o for o in check2.observations}
    for mid in (mat_404, mat_410, mat_dns):
        assert obs2[mid].outcome == "suspected_gone"
        assert obs2[mid].first_gone_at == t0
        assert obs2[mid].confirm_after == t0 + timedelta(days=1)
    assert marks.gone_calls == []

    # Third check 25 hours after T0 (>= 1 day): confirmed_gone and FreshnessMarkWriter.link_gone called!
    current_time = t0 + timedelta(hours=25)
    check3 = await svc.check_links(
        KbLinkCheckStart(material_ids=[mat_404, mat_410, mat_dns, mat_403])
    )
    obs3 = {o.material_id: o for o in check3.observations}
    for mid in (mat_404, mat_410, mat_dns):
        assert obs3[mid].outcome == "confirmed_gone"
        assert obs3[mid].first_gone_at == t0
        assert obs3[mid].confirm_after == t0 + timedelta(days=1)
    assert obs3[mat_403].outcome == "could_not_check"
    assert {mid for mid, _url in marks.gone_calls} == {mat_404, mat_410, mat_dns}

    # Fourth check: mat_404 comes back (200 OK) -> link_back is called!
    status_by_host["gone404.example.org"] = 200
    current_time = t0 + timedelta(hours=26)
    check4 = await svc.check_links(KbLinkCheckStart(material_ids=[mat_404]))
    assert check4.observations[0].outcome == "ok"
    assert mat_404 in marks.back_calls


async def test_link_check_batch_budget_pause_continue_and_http_routes(
    kb_app: Any, kb_client: httpx.AsyncClient
) -> None:
    runtime = kb_app.state.runtime
    assert getattr(runtime, "kb_freshness", None) is not None
    kb: KnowledgeService = runtime.kb
    kb.connect(None)

    folder = kb.create_folder("Batch Folder").id
    m1 = _add_material(
        kb,
        title="Link 1",
        folder_id=folder,
        origin={"type": "url", "url": "https://example.org/1"},
        html='<html><head><meta name="date" content="2025-02-01"></head><body><p>1</p></body></html>',
    )
    m2 = _add_material(
        kb,
        title="Link 2",
        folder_id=folder,
        origin={"type": "url", "url": "https://example.org/2"},
    )
    m3 = _add_material(
        kb,
        title="Link 3",
        folder_id=folder,
        origin={"type": "url", "url": "https://example.org/3"},
    )

    async def fake_resolver(_host: str) -> list[str]:
        return ["93.184.216.34"]

    fetcher = SafeFetcher(
        transport=httpx.MockTransport(lambda _req: httpx.Response(200, text="ok")),
        resolver=fake_resolver,
    )
    jobs = FakeJobStore()
    marks = FakeMarkWriter()
    runtime.kb_freshness = FreshnessService(
        kb,
        job_store=jobs,
        mark_writer=marks,
        fetcher=fetcher,
        link_batch_limit=2,
    )

    # 1. GET publication route
    pub_resp = await kb_client.get(f"/kb/materials/{m1}/publication")
    assert pub_resp.status_code == 200
    assert pub_resp.json()["publication"]["year"] == 2025

    # 2. POST filter_dates route
    filter_resp = await kb_client.post(
        "/kb/materials/by-publication",
        json={
            "dates": {"from_date": "2025-01-01", "to_date": "2025-12-31", "unknown": "separate"},
            "folder_id": folder,
        },
    )
    assert filter_resp.status_code == 200
    body = filter_resp.json()
    assert [m["material_id"] for m in body["materials"]] == [m1]
    assert {m["material_id"] for m in body["unknown_date"]} == {m2, m3}

    # 3. Start link check with batch limit 2 on 3 materials -> pauses after 2 links with stop_reason="budget"
    start_resp = await kb_client.post("/kb/freshness/link-checks", json={"folder_id": folder})
    assert start_resp.status_code == 200
    check_data = start_resp.json()
    check_id = check_data["id"]
    assert check_data["state"] == "paused"
    assert check_data["stop_reason"] == "budget"
    assert check_data["budget"]["limit"] == 2
    assert check_data["budget"]["used"] == 2
    assert check_data["budget"]["remaining"] == 0
    assert check_data["budget"]["total_used"] == 2
    assert check_data["budget"]["batch"] == 1
    assert len(check_data["observations"]) == 2
    cp = check_data["checkpoint"]
    assert cp is not None
    assert cp["revision"] == 1
    assert cp["completed_ids"] == [m1, m2]
    assert cp["pending_ids"] == [m3]

    # 4. GET link check
    get_resp = await kb_client.get(f"/kb/freshness/link-checks/{check_id}")
    assert get_resp.status_code == 200
    assert get_resp.json()["id"] == check_id

    # 5. Stale checkpoint revision returns 409 conflict
    conflict_resp = await kb_client.post(
        f"/kb/freshness/link-checks/{check_id}/continue",
        json={"checkpoint_id": cp["id"], "revision": 99},
    )
    assert conflict_resp.status_code == 409
    assert conflict_resp.json() == {"code": "conflict"}

    # 6. Continue with valid checkpoint completes remaining link m3
    cont_resp = await kb_client.post(
        f"/kb/freshness/link-checks/{check_id}/continue",
        json={"checkpoint_id": cp["id"], "revision": 1},
    )
    assert cont_resp.status_code == 200
    done_data = cont_resp.json()
    assert done_data["state"] == "done"
    assert done_data["stop_reason"] == "completed"
    assert done_data["budget"]["batch"] == 2
    assert done_data["budget"]["used"] == 1
    assert done_data["budget"]["remaining"] == 1
    assert done_data["budget"]["total_used"] == 3
    assert [o["material_id"] for o in done_data["observations"]] == [m1, m2, m3]

    # 7. Pausing or continuing a finished check returns 409 conflict
    pause_done = await kb_client.post(f"/kb/freshness/link-checks/{check_id}/pause")
    assert pause_done.status_code == 409
    assert pause_done.json() == {"code": "conflict"}

    cont_done = await kb_client.post(
        f"/kb/freshness/link-checks/{check_id}/continue",
        json={"checkpoint_id": cp["id"], "revision": 1},
    )
    assert cont_done.status_code == 409
    assert cont_done.json() == {"code": "conflict"}


@pytest.mark.parametrize("missing", ["job_store", "mark_writer"])
async def test_link_check_without_its_stores_is_not_ready_and_starts_nothing(
    kb_app: Any, kb_client: httpx.AsyncClient, missing: str
) -> None:
    # No silent stand-in: without B2's JobStore a check would vanish on restart, without B6's mark writer a
    # confirmed "gone" would be dropped. The route answers not_ready and no job is created.
    runtime = kb_app.state.runtime
    kb: KnowledgeService = runtime.kb
    kb.connect(None)
    folder = kb.create_folder("Unwired").id
    _add_material(kb, title="Link", folder_id=folder, origin={"type": "url", "url": "https://example.org/x"})

    async def fake_resolver(_host: str) -> list[str]:
        return ["93.184.216.34"]

    requests: list[httpx.Request] = []

    def transport(req: httpx.Request) -> httpx.Response:
        requests.append(req)
        return httpx.Response(200, text="ok")

    jobs = FakeJobStore()
    wired: dict[str, Any] = {"job_store": jobs, "mark_writer": FakeMarkWriter()}
    wired.pop(missing)
    runtime.kb_freshness = FreshnessService(
        kb,
        fetcher=SafeFetcher(transport=httpx.MockTransport(transport), resolver=fake_resolver),
        **wired,
    )

    resp = await kb_client.post("/kb/freshness/link-checks", json={"folder_id": folder})
    assert resp.status_code == 503
    assert resp.json()["code"] == "not_ready"
    assert requests == []
    assert jobs.active() == []
