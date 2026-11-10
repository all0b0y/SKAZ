"""Slice B6: the weekly check (scheduler, free steps, Quit/resume), N1 marks and actions, notifications.

Fakes stand in for the science client, the funnel, the map, publication dates, link answers and the
intake; the job store is B2's real ``SqliteJobStore`` on the same library database.
"""

from __future__ import annotations

import asyncio
from collections.abc import Mapping, Sequence
from datetime import UTC, date, datetime, timedelta
from types import SimpleNamespace
from typing import Any

import httpx
import pytest

from skaz.knowledge.api.contract_routes import ContractFailure
from skaz.knowledge.api.schemas_explore import KbFunnelRun, KbFunnelStart
from skaz.knowledge.api.schemas_explore_common import (
    KbContinue,
    KbPublicationDate,
    KbRunBudget,
)
from skaz.knowledge.api.schemas_freshness import KbLinkObservation
from skaz.knowledge.api.schemas_maintenance import KbFreshnessAction, KbWeeklySettingsUpdate
from skaz.knowledge.api.schemas_science import KbScienceSettings
from skaz.knowledge.errors import NotFound
from skaz.knowledge.explore.jobs import SqliteJobStore
from skaz.knowledge.maintenance import build_maintenance
from skaz.knowledge.maintenance.protocols import WEEKLY_CHECK_STARTED_BODY
from skaz.knowledge.maintenance.refs import science_ref, versioned_link
from skaz.knowledge.maintenance.service import Maintenance, finished_body
from skaz.knowledge.markdown.source import FragmentInput, Origin
from skaz.knowledge.science.protocols import (
    ScienceConsentRequired,
    ScienceDailyLimit,
    ScienceRef,
    ScienceUpdate,
)
from skaz.knowledge.service import KnowledgeService
from skaz.knowledge.store.records import MaterialRecord

NOW = datetime(2026, 11, 10, 9, 0, tzinfo=UTC)


def _pub(year: int | None, month: int | None = None) -> KbPublicationDate:
    if year is None:
        return KbPublicationDate(
            year=None, date=None, month=None, precision="unknown", origin="unknown", evidence_url=None
        )
    return KbPublicationDate(
        year=year,
        date=None,
        month=month,
        precision="month" if month else "year",
        origin="page",
        evidence_url=None,
    )


class FakeScience:
    def __init__(self, enabled: bool = True) -> None:
        self.enabled = enabled
        self.updates_by_material: dict[str, list[ScienceUpdate]] = {}
        self.error: Exception | None = None
        self.calls: list[list[str]] = []

    async def updates(self, refs: Sequence[ScienceRef], *, run_id: str | None = None) -> list[ScienceUpdate]:
        self.calls.append([ref.material_id for ref in refs])
        if self.error is not None:
            error, self.error = self.error, None
            raise error
        if not self.enabled:
            raise ScienceConsentRequired()
        return [u for ref in refs for u in self.updates_by_material.get(ref.material_id, [])]

    async def settings(self) -> KbScienceSettings:
        return KbScienceSettings(
            enabled=self.enabled,
            consent_at=None,
            openalex_key_configured=False,
            full_text_hint_dismissed=False,
        )


def _run(run_id: str, area_id: str | None, state: str, stop_reason: str | None = None) -> KbFunnelRun:
    budget = KbRunBudget(
        unit="candidate", limit=30, used=0, remaining=30, total_used=0, batch=1, free_only=True
    )
    checkpoint = (
        {
            "id": f"cp-{run_id}",
            "revision": 1,
            "stage": "decision",
            "cursor": None,
            "completed_ids": [],
            "pending_ids": [],
            "saved_at": NOW,
        }
        if state == "paused"
        else None
    )
    return KbFunnelRun.model_validate(
        {
            "id": run_id,
            "owner": "explore",
            "state": state,
            "stage": "decision",
            "stop_reason": stop_reason,
            "budget": budget,
            "counters": {
                "checked": 0,
                "after_rules": 0,
                "decided": 0,
                "on_topic": 0,
                "novelty_checked": 0,
                "new": 0,
                "covered": 0,
            },
            "checkpoint": checkpoint,
            "created_at": NOW,
            "updated_at": NOW,
            "decision_choices": [],
            "decision_provider": None,
            "retry_at": None,
            "area_id": area_id,
            "task_id": None,
            "query": "",
            "channels": ["continues", "branches", "search"],
            "active_area_ids": [],
        }
    )


class FakeFunnel:
    """B2's funnel: each ``start`` makes a run; ``gate`` holds ``settled`` until set (to test Quit)."""

    def __init__(self, waiting: Mapping[str, list[str]] | None = None) -> None:
        self.waiting_by_area = dict(waiting or {})
        self.starts: list[tuple[KbFunnelStart, bool]] = []
        self.runs: dict[str, KbFunnelRun] = {}
        self.gate: asyncio.Event | None = None
        self.next_state: list[tuple[str, str | None]] = []
        self.resumed: list[str] = []
        self.paused: list[str] = []
        self.refuse: str | None = None

    async def start(self, body: KbFunnelStart, *, free_only: bool = False) -> KbFunnelRun:
        if self.refuse is not None:
            raise ContractFailure(403 if self.refuse == "consent_required" else 404, self.refuse)
        self.starts.append((body, free_only))
        run = _run(f"run-{len(self.starts)}", body.area_id, "running")
        self.runs[run.id] = run
        return run

    async def run(self, run_id: str) -> KbFunnelRun:
        return self.runs[run_id]

    async def pause(self, run_id: str) -> KbFunnelRun:
        self.paused.append(run_id)
        self.runs[run_id] = _run(run_id, self.runs[run_id].area_id, "paused", "user_pause")
        return self.runs[run_id]

    async def resume(self, run_id: str, body: KbContinue) -> KbFunnelRun:
        self.resumed.append(run_id)
        self.runs[run_id] = _run(run_id, self.runs[run_id].area_id, "running")
        return self.runs[run_id]

    async def settled(self, run_id: str) -> KbFunnelRun:
        if self.gate is not None:
            await self.gate.wait()
        run = self.runs[run_id]
        if run.state == "running":
            state, reason = self.next_state.pop(0) if self.next_state else ("done", "completed")
            run = _run(run_id, run.area_id, state, reason)
            self.runs[run_id] = run
        return run

    async def waiting(self, run_id: str) -> list[str]:
        return list(self.waiting_by_area.get(self.runs[run_id].area_id or "", []))


class FakeAreas:
    def __init__(self, pinned: Sequence[str] = ()) -> None:
        self._pinned = list(pinned)

    def pinned(self) -> Sequence[str]:
        return self._pinned

    def area_for_topics(self, topic_ids: Sequence[str]) -> str | None:
        return None

    def area_path(self, area_id: str) -> Sequence[str]:
        return ()

    def topics(self, area_id: str) -> Sequence[str]:
        return ()

    def materials(self, area_id: str) -> Sequence[str]:
        return ()

    def recently_active(self, limit: int = 10) -> Sequence[str]:
        return ()

    def read_marks(self, material_ids: Sequence[str]) -> Mapping[str, Any]:
        return {}


class FakeDates:
    def __init__(self) -> None:
        self.by_material: dict[str, KbPublicationDate] = {}

    def dates(self, material_ids: Sequence[str]) -> Mapping[str, KbPublicationDate]:
        return {mid: self.by_material.get(mid, _pub(None)) for mid in material_ids}


class FakeLinks:
    def __init__(self) -> None:
        self.latest: dict[str, KbLinkObservation] = {}

    def latest_observation(self, material_id: str) -> KbLinkObservation | None:
        return self.latest.get(material_id)


class FakeSources:
    def __init__(self, kb: KnowledgeService) -> None:
        self.kb = kb
        self.calls: list[tuple[str, str, bool | None]] = []

    async def add_link(
        self, url: str, folder_id: str, title: str | None = None, *, to_wiki: bool | None = None
    ) -> Any:
        self.calls.append((url, folder_id, to_wiki))
        material = _material(self.kb, "Paper v3", url=url, folder_id=folder_id)
        return SimpleNamespace(material_id=material)


class FakeIngest:
    def __init__(self) -> None:
        self.calls: list[str] = []

    async def request_ingest(self, material_id: str) -> Any:
        self.calls.append(material_id)
        return SimpleNamespace(id="ingest-1")


class Clock:
    def __init__(self, now: datetime = NOW) -> None:
        self.now = now

    def __call__(self) -> datetime:
        return self.now


def _material(
    kb: KnowledgeService,
    title: str,
    *,
    url: str | None = None,
    doi: str | None = None,
    folder_id: str | None = None,
) -> str:
    origin: dict[str, Any] = {"type": "url", "url": url or "https://example.org/x"}
    if doi:
        origin["doi"] = doi
    created = kb.create_material(
        folder_id or kb.folders()[0].id,
        title=title,
        kind="web",
        status="ready",
        origin=Origin.model_validate(origin),
        fragments=[FragmentInput(text="Some text.")],
    )
    return created.manifest.id


def _page(
    kb: KnowledgeService, page_id: str, title: str, blocks: Sequence[tuple[str, Sequence[str]]]
) -> None:
    """A concept page whose statements cite the given materials (rows only, as the index keeps them)."""
    with kb.db.write() as connection:
        connection.execute(
            "INSERT INTO pages(id, kind, title, rel_path, original, language, file_sha256, indexed_at)"
            " VALUES (?, 'concept', ?, ?, NULL, 'en', 'x', '2026-11-01T00:00:00Z')",
            (page_id, title, f"Wiki/{page_id}.md"),
        )
        for ordinal, (block_id, materials) in enumerate(blocks):
            connection.execute(
                "INSERT INTO blocks(page_id, block_id, ordinal, section, kind, owner, hash, text, marked)"
                " VALUES (?, ?, ?, NULL, 'from_source', 'agent', 'h', 'A statement.', 1)",
                (page_id, block_id, ordinal),
            )
            for number, material_id in enumerate(materials):
                connection.execute(
                    "INSERT INTO citations(page_id, block_id, ordinal, material_id, seg, quote)"
                    " VALUES (?, ?, ?, ?, 0, NULL)",
                    (page_id, block_id, number, material_id),
                )


def _disagreement(kb: KnowledgeService, page_id: str, block_a: str, block_b: str) -> None:
    with kb.db.write() as connection:
        connection.execute(
            "INSERT INTO wiki_discrepancies(id, page_id, block_a, block_b, explanation_id, notification_id,"
            " created_at) VALUES (?, ?, ?, ?, NULL, NULL, '2026-11-01T00:00:00Z')",
            (f"dis-{block_a}", page_id, block_a, block_b),
        )


class World:
    def __init__(self, kb: KnowledgeService, *, pinned: Sequence[str] = (), science_on: bool = True) -> None:
        self.kb = kb
        self.jobs = SqliteJobStore(kb.db)
        self.science = FakeScience(science_on)
        self.funnel = FakeFunnel()
        self.areas = FakeAreas(pinned)
        self.dates = FakeDates()
        self.links = FakeLinks()
        self.sources = FakeSources(kb)
        self.ingest = FakeIngest()
        self.clock = Clock()

    def service(self) -> Maintenance:
        service = build_maintenance(
            self.kb,
            jobs=self.jobs,
            science=self.science,
            funnel=self.funnel,
            areas=self.areas,
            dates=self.dates,
            links=self.links,
            sources=self.sources,
            ingest=self.ingest,
        )
        service._clock = self.clock
        return service


def _notices(kb: KnowledgeService, kind: str) -> list[Any]:
    return [record for record in kb.notifications() if record.kind == kind]


# -- refs ------------------------------------------------------------------------------------------------


def _record(origin: dict[str, Any]) -> MaterialRecord:
    return MaterialRecord("m-1", "f", "web", "ready", "T", "d", "s", origin, ("en",), "2026-01-01T00:00:00Z")


def test_arxiv_version_comes_only_from_the_materials_link() -> None:
    ref = science_ref(_record({"type": "url", "url": "https://arxiv.org/abs/2401.01234v2"}))
    assert ref == ScienceRef(material_id="m-1", doi=None, arxiv_id="2401.01234", version="v2")
    # An id without a version (in the link or in the origin) claims no version.
    unversioned = science_ref(_record({"type": "url", "url": "https://arxiv.org/pdf/2401.01234"}))
    assert unversioned is not None and unversioned.version is None
    bare = science_ref(_record({"type": "url", "url": "https://example.org", "arxiv_id": "2401.01234v5"}))
    assert bare is not None and (bare.arxiv_id, bare.version) == ("2401.01234", None)
    doi = science_ref(_record({"type": "url", "url": "https://doi.org/10.1000/ABC.1"}))
    assert doi is not None and doi.doi == "10.1000/abc.1"
    assert science_ref(_record({"type": "url", "url": "https://example.org/blog"})) is None


def test_versioned_link_keeps_the_kind_of_link_the_user_added() -> None:
    pdf = _record({"type": "url", "url": "https://arxiv.org/pdf/2401.01234v2.pdf"})
    assert versioned_link(pdf, "v3") == "https://arxiv.org/pdf/2401.01234v3.pdf"
    abs_page = _record({"type": "url", "url": "https://arxiv.org/abs/hep-th/9901001v1"})
    assert versioned_link(abs_page, "v4") == "https://arxiv.org/abs/hep-th/9901001v4"
    assert versioned_link(_record({"type": "url", "url": "https://arxiv.org/abs/2401.01234"}), "v3") is None
    assert versioned_link(pdf, "3; rm") is None


def test_finished_body_follows_the_contract() -> None:
    assert finished_body(14, 0, 0, 0) == "14 candidates waiting · Check novelty"
    assert finished_body(0, 2, 1, 0) == "2 newer source versions · 1 retraction"
    assert (
        finished_body(1, 1, 0, 1) == "1 candidate waiting · 1 newer source version · 1 newer source disagrees"
    )


async def test_b5_answers_the_latest_link_observation_of_a_material(ready: KnowledgeService) -> None:
    """Cross-ownership read added to B5 for ``KbFreshnessMarks.last_link_check``."""
    from skaz.knowledge.freshness import FreshnessService
    from skaz.knowledge.freshness.store import LinkCheckScope

    material = _material(ready, "Blog")
    jobs = SqliteJobStore(ready.db)
    budget = KbRunBudget(unit="link", limit=100, used=0, remaining=100, total_used=0, batch=1, free_only=True)
    freshness = FreshnessService(ready)
    assert freshness.latest_observation(material) is None
    for day, outcome in ((1, "suspected_gone"), (3, "could_not_check"), (2, "ok")):
        job = jobs.create("links", "Check links", "links", budget)
        freshness._store.save_link_check(LinkCheckScope(job.id, None, (material,), (), None))
        freshness._store.add_observation(
            job.id,
            KbLinkObservation(
                material_id=material,
                url="https://example.org/x",
                outcome=outcome,  # type: ignore[arg-type]
                reason=None,
                status_code=None,
                checked_at=NOW + timedelta(days=day),
                first_gone_at=None,
                confirm_after=None,
            ),
        )
    latest = freshness.latest_observation(material)
    assert latest is not None and (latest.outcome, latest.checked_at) == (
        "could_not_check",
        NOW + timedelta(days=3),
    )
    with ready.db.read() as connection:
        plan = connection.execute(
            "EXPLAIN QUERY PLAN SELECT * FROM freshness_link_observations WHERE material_id = ?"
            " ORDER BY checked_at DESC LIMIT 1",
            (material,),
        ).fetchall()
    assert any("freshness_links_material" in str(tuple(row)) for row in plan)


# -- marks -----------------------------------------------------------------------------------------------


async def test_link_marks_are_written_by_b5_read_by_b4_and_keep_survives_link_back(
    ready: KnowledgeService,
) -> None:
    world = World(ready)
    service = world.service()
    material = _material(ready, "Blog")
    mark_id = service.link_gone(material, "https://example.org/x")
    assert service.link_gone(material, "https://example.org/x") == mark_id  # idempotent
    assert service.mark_ids([material, "other"]) == {material: [mark_id]}
    marks = await service.marks(material)
    assert [(m.kind, m.reason, m.actions) for m in marks.marks] == [
        ("link_gone", "Original link is gone · your copy is kept", ["keep_marked"])
    ]
    service.link_back(material)
    assert service.mark_ids([material]) == {}
    kept = service.link_gone(material, "https://example.org/x")
    await service.act(kept, KbFreshnessAction(action="keep_marked"))
    service.link_back(material)
    assert service.mark_ids([material]) == {material: [kept]}
    assert (await service.marks(material)).marks[0].kept_marked is True


async def test_last_link_check_comes_from_b5(ready: KnowledgeService) -> None:
    world = World(ready)
    material = _material(ready, "Blog")
    observation = KbLinkObservation(
        material_id=material,
        url="https://example.org/x",
        outcome="could_not_check",
        reason="timeout",
        status_code=None,
        checked_at=NOW,
        first_gone_at=None,
        confirm_after=None,
    )
    world.links.latest[material] = observation
    assert (await world.service().marks(material)).last_link_check == observation


async def test_weekly_n1_marks_versions_and_retractions_with_sole_source(ready: KnowledgeService) -> None:
    world = World(ready)
    paper = _material(ready, "Paper", url="https://arxiv.org/abs/2401.01234v2")
    retracted = _material(ready, "Retracted", doi="10.1000/bad")
    lecture = _material(ready, "Lecture")
    _page(ready, "page-1", "Self-check", [("b1", [retracted]), ("b2", [retracted, lecture]), ("b3", [paper])])
    world.science.updates_by_material = {
        paper: [
            ScienceUpdate(
                paper,
                "new_version",
                "https://arxiv.org/abs/2401.01234v3",
                "arXiv 2401.01234v3",
                version="v3",
                replacement_work_id="arxiv-2401_01234",
                publication=KbPublicationDate(
                    year=2026,
                    date=date(2026, 3, 1),
                    month=3,
                    precision="day",
                    origin="arxiv",
                    evidence_url=None,
                ),
            )
        ],
        retracted: [
            ScienceUpdate(
                retracted,
                "retracted",
                "https://doi.org/10.1000/notice",
                "Retraction (Crossref)",
                publication=_pub(2025),
            )
        ],
    }
    service = world.service()
    check = await service.start()
    assert check.owner == "weekly" and check.trigger == "manual" and check.budget.free_only
    done = await service.settled(check.id)
    assert (done.state, done.stop_reason, done.new_versions, done.retractions) == ("done", "completed", 1, 1)
    # Only ids leave: refs carry DOIs/arXiv ids, and the recording-like material is not asked about.
    assert sorted(world.science.calls[0]) == sorted([paper, retracted])

    version = (await service.marks(paper)).marks[0]
    assert (version.kind, version.reason, version.version, version.current_version) == (
        "new_version",
        "v3 is out (2026)",
        "v3",
        "v2",
    )
    assert version.actions == ["replace_version", "keep_marked"]
    gone = (await service.marks(retracted)).marks[0]
    assert (gone.kind, gone.reason, gone.actions) == (
        "retracted",
        "Retracted (2025)",
        ["delete_source", "keep_marked"],
    )
    statements = {
        (s.block_id, s.sole_source, tuple(m.title for m in s.also_supported_by))
        for s in gone.affected_statements
    }
    assert statements == {("b1", True, ()), ("b2", False, ("Lecture",))}
    page = await service.page_marks("page-1")
    assert {m.material_id for m in page.marks} == {paper, retracted} and page.last_link_check is None

    # The same facts next week are not news again: no second finish notification for them.
    world.clock.now = NOW + timedelta(days=7)
    await service.settled((await service.start()).id)
    finished = _notices(ready, "weekly_check_finished")
    assert [n.body for n in finished] == ["1 newer source version · 1 retraction"]
    assert finished[0].payload["new_versions"] == 1 and finished[0].payload["job_id"] == check.id


async def test_newer_and_contradicts_marks_the_older_statement_only_when_provable(
    ready: KnowledgeService,
) -> None:
    world = World(ready)
    old = _material(ready, "Old book")
    new = _material(ready, "New paper")
    unknown = _material(ready, "Undated")
    _page(ready, "page-1", "Topic", [("a", [old]), ("b", [new]), ("c", [unknown])])
    _page(ready, "page-2", "Other", [("x", [old])])
    _disagreement(ready, "page-1", "a", "b")
    _disagreement(ready, "page-1", "c", "b")
    world.dates.by_material = {old: _pub(2019), new: _pub(2024, 5)}
    service = world.service()
    check = await service.settled((await service.start()).id)
    assert check.newer_contradictions == 1
    marks = (await service.marks(old)).marks
    assert [
        (m.kind, m.reason, m.evidence_label, [s.block_id for s in m.affected_statements]) for m in marks
    ] == [("newer_contradicts", "A newer source disagrees (2024)", "New paper", ["a"])]
    assert (await service.marks(unknown)).marks == [] and (await service.marks(new)).marks == []
    assert [m.kind for m in (await service.page_marks("page-1")).marks] == ["newer_contradicts"]
    assert (await service.page_marks("page-2")).marks == []


async def test_actions_keep_and_replace_with_the_new_version(ready: KnowledgeService) -> None:
    world = World(ready)
    folder = ready.create_folder("Papers").id
    paper = _material(ready, "Paper", url="https://arxiv.org/pdf/2401.01234v2.pdf", folder_id=folder)
    world.science.updates_by_material = {
        paper: [
            ScienceUpdate(paper, "new_version", "https://arxiv.org/abs/2401.01234v3", "arXiv", version="v3")
        ]
    }
    service = world.service()
    await service.settled((await service.start()).id)
    mark = (await service.marks(paper)).marks[0]
    with pytest.raises(ContractFailure) as refused:
        await service.act(mark.id, KbFreshnessAction.model_construct(action="delete_source"))
    assert refused.value.code == "conflict"

    result = await service.act(mark.id, KbFreshnessAction(action="replace_version"))
    assert world.sources.calls == [("https://arxiv.org/pdf/2401.01234v3.pdf", folder, False)]
    # The replaced copy was not in the wiki, so the new one isn't added to it either.
    assert result.ingest_job_id is None and world.ingest.calls == []
    assert result.mark.actions == ["delete_source", "keep_marked"]

    service._in_wiki = lambda material_id: True  # type: ignore[method-assign]
    world.sources.calls.clear()
    retried = await service.act(mark.id, KbFreshnessAction(action="keep_marked"))
    assert retried.mark.kept_marked and retried.ingest_job_id is None
    with pytest.raises(NotFound):
        await service.act("mark-missing", KbFreshnessAction(action="keep_marked"))


async def test_replace_goes_to_the_wiki_when_the_old_copy_was_there(ready: KnowledgeService) -> None:
    world = World(ready)
    paper = _material(ready, "Paper", url="https://arxiv.org/abs/2401.01234v1")
    world.science.updates_by_material = {
        paper: [ScienceUpdate(paper, "new_version", None, "arXiv", version="v2")]
    }
    service = world.service()
    service._in_wiki = lambda material_id: True  # type: ignore[method-assign]
    await service.settled((await service.start()).id)
    mark = (await service.marks(paper)).marks[0]
    result = await service.act(mark.id, KbFreshnessAction(action="replace_version"))
    assert result.ingest_job_id == "ingest-1" and len(world.ingest.calls) == 1


async def test_crossref_new_version_without_a_versioned_link_offers_no_replace(
    ready: KnowledgeService,
) -> None:
    world = World(ready)
    paper = _material(ready, "Paper", doi="10.1000/p")
    world.science.updates_by_material = {
        paper: [ScienceUpdate(paper, "new_version", "https://doi.org/10.1000/n", "Updated (Crossref)")]
    }
    service = world.service()
    await service.settled((await service.start()).id)
    mark = (await service.marks(paper)).marks[0]
    assert (mark.reason, mark.actions) == ("A newer version is out", ["keep_marked"])


# -- the weekly check --------------------------------------------------------------------------------------


async def test_explore_part_runs_free_steps_on_pinned_areas_and_waits_for_check_novelty(
    ready: KnowledgeService,
) -> None:
    world = World(ready, pinned=["area-1", "area-2"])
    world.funnel.waiting_by_area = {"area-1": ["W1", "W2"], "area-2": ["W2", "W3"]}
    service = world.service()
    check = await service.start()
    started = _notices(ready, "weekly_check_started")
    assert [(n.title, n.body) for n in started] == [("Weekly check started", WEEKLY_CHECK_STARTED_BODY)]
    done = await service.settled(check.id)
    assert [(body.area_id, free) for body, free in world.funnel.starts] == [
        ("area-1", True),
        ("area-2", True),
    ]
    assert (done.candidates_waiting, done.candidate_ids) == (3, ["W1", "W2", "W3"])
    assert [n.kind for n in done.notifications] == ["weekly_check_started", "weekly_check_finished"]
    finished = _notices(ready, "weekly_check_finished")[0]
    assert finished.body == "3 candidates waiting · Check novelty"
    assert [a.id for a in ready.notification_actions.actions(finished)] == ["check_novelty"]
    assert [a.label for a in ready.notification_actions.actions(started[0])] == ["View check"]

    settings = await service.settings()
    assert (settings.latest_check_id, settings.candidates_waiting) == (check.id, 3)
    # "Check novelty" ran on W1 (a paid run the user started): it no longer waits.
    budget = KbRunBudget(
        unit="candidate", limit=30, used=0, remaining=30, total_used=0, batch=1, free_only=False
    )
    novelty = world.jobs.create("explore", "Check novelty", "novelty", budget)
    world.jobs.complete(novelty.id, "W1", "novelty", '{"label": "new"}')
    assert (await service.settings()).candidates_waiting == 2
    assert (await service.check(check.id)).candidate_ids == ["W2", "W3"]


async def test_nothing_found_sends_only_the_start_notice_and_says_why_without_pins(
    ready: KnowledgeService,
) -> None:
    world = World(ready)
    service = world.service()
    check = await service.start()
    assert check.owner == "weekly"
    done = await service.settled(check.id)
    assert done.state == "done" and world.funnel.starts == []
    assert len(_notices(ready, "weekly_check_started")) == 1
    assert _notices(ready, "weekly_check_finished") == []
    jobs = world.jobs.recent()
    assert (
        jobs[0].id == check.id
        and world.jobs.title(check.id) == "Weekly check · sources only, no pinned areas"
    )


async def test_manual_start_refuses_without_consent_and_while_one_runs(ready: KnowledgeService) -> None:
    world = World(ready, pinned=["area-1"], science_on=False)
    service = world.service()
    with pytest.raises(ContractFailure) as refused:
        await service.start()
    assert (refused.value.status, refused.value.code) == (403, "consent_required")
    assert world.jobs.active() == [] and _notices(ready, "weekly_check_started") == []

    world.science.enabled = True
    world.funnel.gate = asyncio.Event()
    check = await service.start()
    with pytest.raises(ContractFailure) as busy:
        await service.start()
    assert busy.value.code == "conflict"
    world.funnel.gate.set()
    assert (await service.settled(check.id)).state == "done"


async def test_an_honest_stop_pauses_and_continue_never_rechecks_done_work(ready: KnowledgeService) -> None:
    world = World(ready, pinned=["area-1"])
    service = world.service()
    service_mod = __import__("skaz.knowledge.maintenance.service", fromlist=["N1_BATCH"])
    batch = service_mod.N1_BATCH
    papers = [_material(ready, f"P{i}", doi=f"10.1000/p{i}") for i in range(batch + 2)]
    world.science.updates_by_material = {}
    calls = 0

    original = world.science.updates

    async def limited(refs: Sequence[ScienceRef], *, run_id: str | None = None) -> list[ScienceUpdate]:
        nonlocal calls
        calls += 1
        if calls == 2:
            raise ScienceDailyLimit(retry_at=datetime(2026, 11, 11, tzinfo=UTC))
        return await original(refs, run_id=run_id)

    world.science.updates = limited  # type: ignore[method-assign]
    check = await service.settled((await service.start()).id)
    assert (check.state, check.stop_reason) == ("paused", "openalex_daily_limit")
    assert check.retry_at == datetime(2026, 11, 11, tzinfo=UTC)
    assert check.checkpoint is not None and len(check.checkpoint.pending_ids) == 3  # 2 papers + area
    assert world.funnel.starts == []

    with pytest.raises(ContractFailure):
        await service.resume(check.id, KbContinue(checkpoint_id=check.checkpoint.id, revision=99))
    resumed = await service.resume(
        check.id, KbContinue(checkpoint_id=check.checkpoint.id, revision=check.checkpoint.revision)
    )
    assert resumed.state == "running"
    done = await service.settled(check.id)
    assert done.state == "done" and done.counters.checked == len(papers)
    # Every source was asked about exactly once: the batch done before the stop is not asked again.
    asked = [mid for call in world.science.calls for mid in call]
    assert sorted(asked) == sorted(papers) and len(world.science.calls[-1]) == 2


async def test_a_child_run_stop_pauses_the_check_and_continue_resumes_the_run(
    ready: KnowledgeService,
) -> None:
    world = World(ready, pinned=["area-1"])
    world.funnel.waiting_by_area = {"area-1": ["W1"]}
    world.funnel.next_state = [("paused", "provider_unavailable"), ("paused", "provider_unavailable")]
    service = world.service()
    check = await service.settled((await service.start()).id)
    assert (check.state, check.stop_reason) == ("paused", "provider_unavailable")
    assert world.funnel.resumed == ["run-1"]  # retried once, then an honest stop
    assert check.checkpoint is not None
    await service.resume(
        check.id, KbContinue(checkpoint_id=check.checkpoint.id, revision=check.checkpoint.revision)
    )
    done = await service.settled(check.id)
    assert done.state == "done" and done.candidate_ids == ["W1"] and len(world.funnel.starts) == 1


async def test_funnel_consent_refusal_pauses_with_the_settings_link(ready: KnowledgeService) -> None:
    world = World(ready, pinned=["area-1"])
    world.funnel.refuse = "consent_required"
    service = world.service()
    check = await service.settled((await service.start()).id)
    assert (check.state, check.stop_reason) == ("paused", "science_consent_required")


async def test_pause_pauses_the_running_area_run_too(ready: KnowledgeService) -> None:
    world = World(ready, pinned=["area-1"])
    world.funnel.gate = asyncio.Event()
    service = world.service()
    check = await service.start()
    for _ in range(50):
        if world.funnel.starts:
            break
        await asyncio.sleep(0.01)
    paused = await service.pause(check.id)
    assert (paused.state, paused.stop_reason) == ("paused", "user_pause") and world.funnel.paused == ["run-1"]
    with pytest.raises(ContractFailure):
        await service.pause(check.id)
    world.funnel.gate.set()
    assert paused.checkpoint is not None
    await service.resume(
        check.id, KbContinue(checkpoint_id=paused.checkpoint.id, revision=paused.checkpoint.revision)
    )
    done = await service.settled(check.id)
    assert done.state == "done" and world.funnel.resumed == ["run-1"] and len(world.funnel.starts) == 1


async def test_quit_pauses_with_app_exit_and_the_next_start_resumes_by_itself(
    ready: KnowledgeService,
) -> None:
    world = World(ready, pinned=["area-1"])
    world.funnel.waiting_by_area = {"area-1": ["W1"]}
    world.funnel.gate = asyncio.Event()
    service = world.service()
    check = await service.start()
    for _ in range(50):
        if world.funnel.starts:
            break
        await asyncio.sleep(0.01)
    await service.aclose()
    job = world.jobs.get(check.id)
    assert job is not None and (job.state, job.stop_reason) == ("paused", "app_exit")

    world.funnel.gate.set()
    restarted = world.service()
    await restarted.on_start()
    try:
        done = await restarted.settled(check.id)
        assert done.state == "done" and done.candidate_ids == ["W1"]
        assert len(world.funnel.starts) == 1  # the area's run was not started twice
        assert len(_notices(ready, "weekly_check_started")) == 1  # resuming is not a new check
    finally:
        await restarted.aclose()


# -- the scheduler -----------------------------------------------------------------------------------------


async def test_settings_and_due_dates(ready: KnowledgeService) -> None:
    world = World(ready)
    service = world.service()
    off = await service.settings()
    assert (off.enabled, off.next_due_at, off.missed, off.latest_check_id) == (False, None, False, None)
    on = await service.update_settings(KbWeeklySettingsUpdate(enabled=True))
    assert on.enabled and on.next_due_at == NOW + timedelta(days=7) and not on.missed
    world.clock.now = NOW + timedelta(days=8)
    assert (await service.settings()).missed is True


async def test_a_missed_week_runs_at_start_and_the_timer_starts_the_due_one(ready: KnowledgeService) -> None:
    world = World(ready, pinned=["area-1"])
    service = world.service()
    await service.update_settings(KbWeeklySettingsUpdate(enabled=True))
    world.clock.now = NOW + timedelta(days=9)
    await service.on_start()
    try:
        [job] = world.jobs.active()
        missed = await service.settled(job.id)
        assert missed.trigger == "missed_week" and missed.budget.free_only
        assert world.funnel.starts[0][1] is True  # free steps only
        settings = await service.settings()
        assert settings.next_due_at == NOW + timedelta(days=16) and not settings.missed
        assert settings.last_completed_at is not None

        assert await service._tick() > 0  # not due yet: nothing starts
        assert world.jobs.active() == []
        world.clock.now = NOW + timedelta(days=16)
        await service._tick()
        [scheduled] = world.jobs.active()
        done = await service.settled(scheduled.id)
        assert done.trigger == "scheduled"
        assert (await service.settings()).next_due_at == NOW + timedelta(days=23)
    finally:
        await service.aclose()


async def test_disabled_or_unconfigured_never_starts(service: KnowledgeService) -> None:
    world = World(service)
    maintenance = world.service()
    assert await maintenance._tick() == maintenance._tick_s
    for call in (
        maintenance.settings(),
        maintenance.start(),
        maintenance.check("x"),
        maintenance.marks("m"),
        maintenance.page_marks("p"),
        maintenance.update_settings(KbWeeklySettingsUpdate(enabled=True)),
    ):
        with pytest.raises(ContractFailure) as refused:
            await call
        assert refused.value.code == "not_ready"


# -- the real app ------------------------------------------------------------------------------------------


async def test_runtime_wires_maintenance_and_b5_writes_its_marks_here(
    kb_app: Any, kb_client: httpx.AsyncClient
) -> None:
    runtime = kb_app.state.runtime
    assert isinstance(runtime.kb_maintenance, Maintenance)
    assert (
        runtime.kb_maintenance.jobs is runtime.kb_jobs and runtime.kb_maintenance.funnel is runtime.kb_explore
    )
    assert runtime.kb_maintenance.links is runtime.kb_freshness
    response = await kb_client.get("/kb/settings/weekly-check")
    assert (response.status_code, response.json()) == (503, {"code": "not_ready"})

    runtime.kb.connect(None)
    response = await kb_client.get("/kb/settings/weekly-check")
    assert response.status_code == 200 and response.json()["enabled"] is False
    response = await kb_client.put("/kb/settings/weekly-check", json={"enabled": True})
    assert response.status_code == 200 and response.json()["next_due_at"] is not None
    # Science integration is off by default: a manual check is refused before any job exists.
    response = await kb_client.post("/kb/freshness/weekly-checks")
    assert (response.status_code, response.json()) == (403, {"code": "consent_required"})
    material = _material(runtime.kb, "Blog")
    mark_id = runtime.kb_maintenance.link_gone(material, "https://example.org/x")
    response = await kb_client.get(f"/kb/materials/{material}/freshness")
    assert response.status_code == 200
    assert [m["id"] for m in response.json()["marks"]] == [mark_id] and response.json()[
        "last_link_check"
    ] is None
    response = await kb_client.post(f"/kb/freshness/marks/{mark_id}/act", json={"action": "replace_version"})
    assert (response.status_code, response.json()) == (409, {"code": "conflict"})
    response = await kb_client.get("/kb/freshness/weekly-checks/job-missing")
    assert (response.status_code, response.json()) == (404, {"code": "not_found"})
    assert {"weekly_check_started", "weekly_check_finished"} <= set(runtime.kb.notification_actions.kinds)
