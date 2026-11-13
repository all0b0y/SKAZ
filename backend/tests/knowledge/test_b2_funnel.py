"""Slice B2: the funnel (collect → rules → decision → novelty → ready), findings and Add to materials.

Every Protocol B2 consumes is a fake here; no request leaves and no model is called.
"""

from __future__ import annotations

import asyncio
from collections.abc import Mapping, Sequence
from datetime import date, datetime
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from pydantic import ValidationError

from skaz.knowledge.api.contract_routes import ContractFailure
from skaz.knowledge.api.schemas_areas import KbReadMark
from skaz.knowledge.api.schemas_explore import (
    KbFunnelStart,
    KbThesis,
)
from skaz.knowledge.api.schemas_explore_common import (
    KbContinue,
    KbExplorePageRef,
    KbPublicationDate,
    KbRunBudget,
)
from skaz.knowledge.api.schemas_science import (
    KbPaidAccess,
    KbScienceLocation,
    KbSciencePayload,
    KbScienceResults,
    KbScienceSearch,
    KbScienceText,
    KbScienceWork,
)
from skaz.knowledge.areas.protocols import SignalDraft
from skaz.knowledge.decisions.protocol import ChoiceAnswer, ChoiceQuestion, Undecided
from skaz.knowledge.errors import KnowledgeError, NotFound
from skaz.knowledge.explore import register_notifications
from skaz.knowledge.explore.jobs import SqliteJobStore
from skaz.knowledge.explore.novelty import NoveltyUnavailable, WikiClaims
from skaz.knowledge.explore.reading import ReadingDesk
from skaz.knowledge.explore.service import OFF_TOPIC, ExploreFunnel
from skaz.knowledge.markdown.source import FragmentInput, Origin
from skaz.knowledge.permissions.search_rules import ActiveRules
from skaz.knowledge.science.protocols import (
    ScienceConsentRequired,
    ScienceDailyLimit,
    ScienceRef,
)
from skaz.knowledge.service import KnowledgeService
from skaz.knowledge.sources.service import IntakeResult

TODAY = date(2026, 11, 10)
REAL_ABSTRACT = (
    "We study agents that plan with tools and report how routing between experts changes their accuracy "
    "on long tasks."
)
UNKNOWN = KbPublicationDate(year=None, date=None, precision="unknown", origin="unknown", evidence_url=None)


def work(
    n: int,
    *,
    title: str | None = None,
    year: int = 2026,
    doi: str | None = None,
    paid: bool = False,
    abstract: str | None = "An abstract.",
    locations: Sequence[KbScienceLocation] = (),
    topics: Sequence[str] = (),
    refs: Sequence[str] = (),
    cited: int = 0,
) -> KbScienceWork:
    return KbScienceWork(
        id=f"work-{n}",
        provider="openalex",
        provider_id=f"W{n}",
        doi=doi,
        arxiv_id=None,
        title=title or f"Work {n}",
        authors=["A. Author"],
        publication=KbPublicationDate(
            year=year, date=None, precision="year", origin="openalex", evidence_url=None
        ),
        venue=None,
        publication_type="article",
        abstract=abstract,
        topic_ids=list(topics),
        referenced_ids=list(refs),
        cited_by_count=cited,
        locations=list(locations),
        access=KbPaidAccess(
            paid=paid,
            alternatives_checked=False,
            free_alternative_ids=[],
            suggestion_shown_at=None,
            recommendation=None,
            publisher_url=None,
        ),
    )


def results(works: Sequence[KbScienceWork], stop: str | None = None) -> KbScienceResults:
    return KbScienceResults(works=list(works), next_cursor=None, stop_reason=stop)  # type: ignore[arg-type]


class FakeScience:
    def __init__(self) -> None:
        self.search_works: list[KbScienceWork] = []
        self.citing_works: list[KbScienceWork] = []
        self.neighbour_works: list[KbScienceWork] = []
        self.resolved: dict[str, KbScienceWork] = {}
        self.texts: dict[str, KbScienceText] = {}
        #: EX3: works whose open copy does not answer (every other work reads at example.org).
        self.closed: set[str] = set()
        self.error: Exception | None = None
        self.calls: list[tuple[str, Any]] = []

    def _check(self, name: str, arg: Any) -> None:
        self.calls.append((name, arg))
        if self.error is not None:
            raise self.error

    async def search(self, body: KbScienceSearch, *, run_id: str | None = None) -> KbScienceResults:
        self._check("search", body)
        if body.payload.ids:
            return results([w for w in self.search_works if w.id in body.payload.ids])
        return results(self.search_works)

    async def citing(
        self,
        work_ids: Sequence[str],
        *,
        since: date | None = None,
        cursor: str | None = None,
        run_id: str | None = None,
    ) -> KbScienceResults:
        self._check("citing", (list(work_ids), since))
        return results(self.citing_works)

    async def neighbours(
        self,
        work_ids: Sequence[str],
        topic_ids: Sequence[str],
        *,
        since: date | None = None,
        cursor: str | None = None,
        run_id: str | None = None,
    ) -> KbScienceResults:
        self._check("neighbours", (list(work_ids), list(topic_ids)))
        return results(self.neighbour_works)

    async def resolve(self, ref: ScienceRef, *, run_id: str | None = None) -> KbScienceWork | None:
        self._check("resolve", ref)
        return self.resolved.get(ref.doi or "")

    async def read_text(self, work_id: str, *, run_id: str | None = None) -> KbScienceText:
        self._check("read_text", work_id)
        return self.texts[work_id]

    async def open_text_url(self, work_id: str, *, run_id: str | None = None) -> str | None:
        self._check("open_text_url", work_id)
        known = [*self.search_works, *self.citing_works, *self.neighbour_works, *self.resolved.values()]
        paid = any(w.id == work_id and w.access.paid for w in known)
        return None if work_id in self.closed or paid else f"https://example.org/read/{work_id}"

    async def paid_access(
        self, work: KbScienceWork, *, useful_because: str | None, run_id: str | None = None
    ) -> KbPaidAccess:
        self._check("paid_access", work.id)
        return work.access.model_copy(update={"alternatives_checked": True, "recommendation": useful_because})

    async def updates(self, refs: Sequence[ScienceRef], *, run_id: str | None = None) -> Sequence[Any]:
        raise AssertionError("B2 never asks for updates")

    async def publication(self, ref: ScienceRef, *, run_id: str | None = None) -> KbPublicationDate:
        raise AssertionError("B2 never asks for a publication date")

    async def taxonomy(self, parent_id: str | None = None) -> Sequence[Any]:
        raise AssertionError("B2 never asks for the taxonomy")

    def count(self, name: str) -> int:
        return sum(1 for call, _ in self.calls if call == name)


class FakeDirectory:
    def __init__(self) -> None:
        self.paths: dict[str, list[str]] = {"area-ai": ["Computer science", "AI"]}
        self.area_topics: dict[str, list[str]] = {"area-ai": ["T1"]}
        self.area_materials: dict[str, list[str]] = {}
        self.marks: dict[str, Any] = {}

    def area_for_topics(self, topic_ids: Sequence[str]) -> str | None:
        return "area-ai" if "T1" in topic_ids else None

    def area_path(self, area_id: str) -> Sequence[str]:
        return self.paths.get(area_id, [])

    def topics(self, area_id: str) -> Sequence[str]:
        return self.area_topics.get(area_id, [])

    def materials(self, area_id: str) -> Sequence[str]:
        return self.area_materials.get(area_id, [])

    def pinned(self) -> Sequence[str]:
        return ["area-ai"]

    def recently_active(self, limit: int = 10) -> Sequence[str]:
        return []

    def read_marks(self, material_ids: Sequence[str]) -> Mapping[str, Any]:
        return {mid: self.marks[mid] for mid in material_ids if mid in self.marks}


class FakeRecorder:
    def __init__(self) -> None:
        self.drafts: list[SignalDraft] = []

    def record(self, draft: SignalDraft) -> Any:
        self.drafts.append(draft)
        return draft


class FakeLayer:
    def __init__(self, decider_id: str, off_topic: set[str], undecided: set[str] | None = None) -> None:
        self.id = decider_id
        self.off_topic = off_topic
        self.undecided = undecided or set()
        self.asked = 0

    async def ask(self, question: Any) -> Any:
        return (await self.ask_many([question]))[0]

    async def ask_many(self, questions: Sequence[ChoiceQuestion]) -> list[Any]:
        answers: list[Any] = []
        for question in questions:
            self.asked += 1
            title = question.state.split("Title: ", 1)[1].split("\n", 1)[0]
            if title in self.undecided:
                answers.append(Undecided("below threshold"))
            else:
                option = OFF_TOPIC if title in self.off_topic else question.options[0]
                answers.append(ChoiceAnswer(option=option, probabilities={option: 0.9}, confidence=0.9))
        return answers


class FakeDeciders:
    def __init__(self, layer: FakeLayer | None) -> None:
        self._layer = layer
        self.choices: list[str] = []

    def layer(self) -> Any:
        return self._layer

    def ready(self) -> bool:
        return self._layer is not None

    async def choose(self, choice: str) -> bool:
        self.choices.append(choice)
        self._layer = FakeLayer("openrouter_jev" if choice == "openrouter_jev" else "local", set())
        return True


class FakeNovelty:
    def __init__(self, labels: Mapping[str, str] | None = None) -> None:
        self.labels = dict(labels or {})
        self.checked: list[str] = []
        self.gate: asyncio.Event | None = None

    async def check(self, works: Sequence[KbScienceWork]) -> Sequence[Sequence[KbThesis]]:
        if self.gate is not None:
            await self.gate.wait()
        out = []
        for item in works:
            self.checked.append(item.id)
            label = self.labels.get(item.title, "new")
            refs = [] if label in ("new", "branch") else [KbExplorePageRef(page_id="page-1", title="Agents")]
            out.append([KbThesis(text=f"{item.title} claims something", label=label, wiki_refs=refs)])  # type: ignore[arg-type]
        return out


class FakeChats:
    def __init__(self, kb: KnowledgeService | None = None) -> None:
        self.kb = kb
        self.created: list[str] = []
        self.sent: list[tuple[str, Any]] = []

    async def create(self, *, title: str | None = None) -> Any:
        self.created.append(title or "")
        chat_id = f"chat-{len(self.created)}"
        if self.kb is not None:
            with self.kb.db.write() as connection:
                connection.execute(
                    "INSERT INTO chat_threads(id, title, engine, created_at, updated_at) VALUES (?,?,?,?,?)",
                    (chat_id, title or "", "claude_code", "2026-11-10T00:00:00Z", "2026-11-10T00:00:00Z"),
                )
        return SimpleNamespace(chat=SimpleNamespace(id=chat_id))

    async def send(self, chat_id: str, given: Any) -> Any:
        self.sent.append((chat_id, given))
        return None


class FakeSources:
    def __init__(self, kb: KnowledgeService) -> None:
        self.kb = kb
        self.prepared: list[Any] = []

    async def add_prepared(self, prepared: Any, folder_id: str, *, to_wiki: bool) -> IntakeResult:
        self.prepared.append((prepared, folder_id, to_wiki))
        files = self.kb.create_material(
            folder_id,
            prepared.title or prepared.fallback_title,
            prepared.kind,
            prepared.fragments,
            status="ready",
            origin=prepared.origin,
        )
        return IntakeResult(files.manifest.id, files.title, "ready", 0, 0, None)


@pytest.fixture
def parts(ready: KnowledgeService) -> SimpleNamespace:
    register_notifications(ready)
    # EX2: this fixture is an own topic with a stored hidden label, not a taxonomy tile.
    with ready.db.write() as db:
        db.execute(
            "INSERT INTO explore_areas(id,level,name,original_name,mapping_state,mapped_name)"
            " VALUES ('area-ai','custom','AI','AI','mapped','AI')"
        )
        db.execute("INSERT INTO explore_area_topics VALUES ('area-ai','T1')")
    science = FakeScience()
    directory = FakeDirectory()
    recorder = FakeRecorder()
    novelty = FakeNovelty()
    chats = FakeChats(ready)
    sources = FakeSources(ready)
    moved: list[tuple[str, str]] = []
    finding_marks: dict[str, str] = {}
    deciders = FakeDeciders(FakeLayer("local", off_topic={"Off topic"}))
    rules: dict[str, ActiveRules | None] = {"rules": None}
    jobs = SqliteJobStore(ready.db)

    def finding_mark(finding_id: str) -> KbReadMark:
        return KbReadMark(
            material_id=None,
            finding_id=finding_id,
            value=finding_marks.get(finding_id),  # type: ignore[arg-type]
            updated_at=None,
        )

    def move(finding_id: str, material_id: str) -> None:
        moved.append((finding_id, material_id))

    class Dates:
        def dates(self, material_ids: Sequence[str]) -> Mapping[str, KbPublicationDate]:
            return dict.fromkeys(material_ids, UNKNOWN)

    funnel = ExploreFunnel(
        ready,
        jobs,
        directory=directory,
        recorder=recorder,
        finding_mark=finding_mark,
        publication_dates=Dates(),
        deciders=deciders,
        novelty=novelty,
        claims=WikiClaims(ready.db),
        search_rules=lambda: rules["rules"],
        reading=ReadingDesk(ready, chats=chats, sources=sources, move_mark=move),
        area_scope=lambda area_id: (area_id,),
        science=science,
        today=lambda: TODAY,
    )
    return SimpleNamespace(
        kb=ready,
        funnel=funnel,
        jobs=jobs,
        science=science,
        directory=directory,
        recorder=recorder,
        novelty=novelty,
        chats=chats,
        sources=sources,
        moved=moved,
        finding_marks=finding_marks,
        deciders=deciders,
        rules=rules,
    )


async def run_to_end(p: SimpleNamespace, body: KbFunnelStart, **kwargs: Any) -> Any:
    started = await p.funnel.start(body, **kwargs)
    return await p.funnel.settled(started.id)


def add_material(kb: KnowledgeService, title: str, url: str) -> str:
    folder = kb.folders()[0].id
    created = kb.create_material(
        folder,
        title=title,
        kind="web",
        status="ready",
        origin=Origin.model_validate({"type": "url", "url": url}),
        fragments=[FragmentInput(text="Some text.")],
    )
    return created.manifest.id


# -- readiness ---------------------------------------------------------------------------------------------


async def test_no_science_client_or_no_library_is_not_ready(parts: SimpleNamespace, tmp_path: Path) -> None:
    parts.funnel.science = None
    with pytest.raises(ContractFailure) as caught:
        await parts.funnel.start(KbFunnelStart(query="agents"))
    assert (caught.value.status, caught.value.code) == (503, "not_ready")
    assert parts.jobs.active() == []
    service = KnowledgeService(
        tmp_path / "unconnected", documents_dir=tmp_path / "docs", documents_sandbox=tmp_path / "docs"
    )
    funnel = ExploreFunnel(
        service,
        SqliteJobStore(service.db),
        directory=FakeDirectory(),
        recorder=FakeRecorder(),
        finding_mark=lambda f: KbReadMark(material_id=None, finding_id=f, value=None, updated_at=None),
        publication_dates=SimpleNamespace(dates=lambda ids: {}),
        deciders=FakeDeciders(None),
        novelty=FakeNovelty(),
        claims=WikiClaims(service.db),
        search_rules=lambda: None,
        reading=ReadingDesk(
            service, chats=FakeChats(), sources=FakeSources(service), move_mark=lambda f, m: None
        ),
        area_scope=lambda area_id: (area_id,),
        science=FakeScience(),
    )
    for call in (funnel.jobs(), funnel.findings(), funnel.run("job-x")):
        with pytest.raises(ContractFailure) as caught:
            await call
        assert caught.value.code == "not_ready"
    service.close()


# -- the whole funnel --------------------------------------------------------------------------------------


async def test_search_runs_every_stage_and_notifies(parts: SimpleNamespace) -> None:
    add_material(parts.kb, "Already mine", "https://doi.org/10.1000/mine")
    parts.science.search_works = [
        work(1, title="Fresh idea", topics=["T1"]),
        work(2, title="Already mine", doi="10.1000/mine"),
        work(3, title="Off topic"),
        work(4, title="Too old", year=2019),
    ]
    run = await run_to_end(parts, KbFunnelStart(query="llm agents", channels=["search"]))
    assert (run.state, run.stage, run.stop_reason) == ("done", "ready", "completed")
    counters = run.counters
    assert (counters.checked, counters.after_rules, counters.decided, counters.on_topic) == (4, 2, 2, 1)
    assert (counters.novelty_checked, counters.new, counters.covered) == (1, 1, 0)
    assert run.decision_provider == "local"
    assert run.active_area_ids == []  # precise unscoped text does not search the library topics
    search = next(arg for name, arg in parts.science.calls if name == "search")
    assert search.payload.topics == ["llm agents"]  # the search line leaves as a topic (C0-1)
    assert search.payload.dois == [] and search.payload.ids == []
    findings = await parts.funnel.findings()
    (group,) = findings.groups
    (finding,) = group.findings
    assert (finding.label, finding.channel, finding.area_id) == ("new", "search", None)
    assert finding.area_path == []
    assert finding.reason == "New compared with your wiki."
    assert finding.text_available == "unchecked"
    (note,) = [n for n in parts.kb.notifications() if n.kind == "explore_finished"]
    assert (note.title, note.body) == ("Search finished", "1 new · 0 repeat what you have")
    assert note.payload["job_id"] == run.id
    assert parts.kb.notification_actions.actions(note)[0].label == "Open in Explore"


async def test_continues_and_branches_start_from_library_sources(parts: SimpleNamespace) -> None:
    mine = add_material(parts.kb, "Reflexion", "https://doi.org/10.1000/reflexion")
    parts.directory.area_materials["area-ai"] = [mine]
    with parts.kb.db.write() as db:
        db.execute("INSERT INTO explore_area_materials VALUES (?,'area-ai','agent','now')", (mine,))
    seed = work(10, title="Reflexion", doi="10.1000/reflexion", refs=["W99"], topics=["T1"])
    parts.science.resolved["10.1000/reflexion"] = seed
    parts.science.citing_works = [work(11, title="Cites it", refs=["W10"], topics=["T1"], cited=5)]
    parts.science.neighbour_works = [work(12, title="Shares roots", refs=["W99"], topics=["T1"])]
    run = await run_to_end(parts, KbFunnelStart(area_id="area-ai", channels=["continues", "branches"]))
    assert run.state == "done"
    (resolve_ref,) = [arg for name, arg in parts.science.calls if name == "resolve"]
    assert resolve_ref == ScienceRef(material_id=mine, doi="10.1000/reflexion")
    citing_ids, since = next(arg for name, arg in parts.science.calls if name == "citing")
    assert citing_ids == ["work-10"]
    assert since <= TODAY.replace(year=2025)  # at least twelve months back
    findings = {f.work.title: f for g in (await parts.funnel.findings()).groups for f in g.findings}
    assert findings["Cites it"].cites_materials[0].material_id == mine
    assert findings["Shares roots"].label == "branch"
    assert findings["Shares roots"].shared_source_count == 1


async def test_first_request_refused_by_consent_answers_403_and_leaves_nothing(
    parts: SimpleNamespace,
) -> None:
    parts.science.error = ScienceConsentRequired()
    with pytest.raises(ContractFailure) as caught:
        await parts.funnel.start(KbFunnelStart(query="agents", channels=["search"]))
    assert (caught.value.status, caught.value.code) == (403, "consent_required")
    assert parts.jobs.recent() == []


async def test_daily_limit_pauses_honestly_and_continue_retries(parts: SimpleNamespace) -> None:
    parts.science.search_works = [work(1, topics=["T1"])]
    parts.science.error = ScienceDailyLimit(datetime(2026, 11, 11, 0, 0))
    first = await parts.funnel.start(KbFunnelStart(query="agents", channels=["search"]))
    paused = await parts.funnel.settled(first.id)
    assert (paused.state, paused.stop_reason) == ("paused", "openalex_daily_limit")
    assert paused.retry_at is not None and paused.retry_at.day == 11
    parts.science.error = None
    assert paused.checkpoint is not None
    await parts.funnel.resume(
        first.id, KbContinue(checkpoint_id=paused.checkpoint.id, revision=paused.checkpoint.revision)
    )
    done = await parts.funnel.settled(first.id)
    assert done.state == "done" and done.counters.new == 1


async def test_no_decision_model_pauses_after_free_steps_and_the_choice_continues(
    parts: SimpleNamespace,
) -> None:
    parts.deciders._layer = None
    parts.science.search_works = [work(1, topics=["T1"]), work(2)]
    run = await run_to_end(parts, KbFunnelStart(query="agents", channels=["search"]))
    assert (run.state, run.stage, run.stop_reason) == ("paused", "decision", "decision_model_required")
    assert run.decision_choices == ["download_local", "openrouter_jev"]
    assert run.counters.after_rules == 2 and run.counters.decided == 0
    assert parts.novelty.checked == []
    checkpoint = run.checkpoint
    assert checkpoint is not None and checkpoint.pending_ids == ["work-1", "work-2"]
    await parts.funnel.resume(
        run.id,
        KbContinue(
            checkpoint_id=checkpoint.id, revision=checkpoint.revision, decision_choice="openrouter_jev"
        ),
    )
    done = await parts.funnel.settled(run.id)
    assert parts.deciders.choices == ["openrouter_jev"]
    assert done.state == "done" and done.decision_provider == "openrouter_jev"
    assert parts.science.count("search") == 1  # collect was not repeated


async def test_undecided_is_left_out_not_guessed(parts: SimpleNamespace) -> None:
    parts.deciders._layer = FakeLayer("local", off_topic=set(), undecided={"Unclear"})
    parts.science.search_works = [work(1, title="Unclear", topics=["T1"])]
    run = await run_to_end(parts, KbFunnelStart(query="agents", channels=["search"]))
    assert (run.counters.decided, run.counters.on_topic, run.counters.novelty_checked) == (1, 0, 0)


async def test_budget_pauses_at_thirty_and_continue_never_rechecks(parts: SimpleNamespace) -> None:
    parts.science.search_works = [work(n, topics=["T1"]) for n in range(1, 36)]
    run = await run_to_end(parts, KbFunnelStart(query="agents", channels=["search"]))
    assert (run.state, run.stop_reason) == ("paused", "budget")
    assert (run.budget.used, run.budget.remaining, run.budget.batch) == (30, 0, 1)
    assert run.counters.novelty_checked == 30
    checkpoint = run.checkpoint
    assert checkpoint is not None and len(checkpoint.pending_ids) == 5
    with pytest.raises(KnowledgeError) as stale:
        await parts.funnel.resume(
            run.id, KbContinue(checkpoint_id=checkpoint.id, revision=checkpoint.revision + 1)
        )
    assert stale.value.status_code == 409
    await parts.funnel.resume(run.id, KbContinue(checkpoint_id=checkpoint.id, revision=checkpoint.revision))
    done = await parts.funnel.settled(run.id)
    assert done.state == "done"
    assert (done.budget.used, done.budget.batch, done.budget.total_used) == (5, 2, 35)
    assert len(parts.novelty.checked) == 35 == len(set(parts.novelty.checked))
    with pytest.raises(KnowledgeError) as finished:
        await parts.funnel.resume(
            run.id, KbContinue(checkpoint_id=checkpoint.id, revision=checkpoint.revision)
        )
    assert finished.value.status_code == 409


async def test_pause_and_cancel(parts: SimpleNamespace) -> None:
    parts.science.search_works = [work(n, topics=["T1"]) for n in range(1, 4)]
    parts.novelty.gate = asyncio.Event()
    started = await parts.funnel.start(KbFunnelStart(query="agents", channels=["search"]))
    for _ in range(50):
        if (await parts.funnel.run(started.id)).stage == "novelty":
            break
        await asyncio.sleep(0.01)
    paused = await parts.funnel.pause(started.id)
    assert (paused.state, paused.stop_reason) == ("paused", "user_pause")
    with pytest.raises(KnowledgeError) as twice:
        await parts.funnel.pause(started.id)
    assert twice.value.status_code == 409
    parts.novelty.gate.set()
    assert paused.checkpoint is not None
    await parts.funnel.resume(
        started.id, KbContinue(checkpoint_id=paused.checkpoint.id, revision=paused.checkpoint.revision)
    )
    done = await parts.funnel.settled(started.id)
    assert done.counters.novelty_checked == 3 and len(parts.novelty.checked) == 3
    with pytest.raises(KnowledgeError) as finished:
        await parts.funnel.cancel(started.id)
    assert finished.value.status_code == 409
    other = await parts.funnel.start(KbFunnelStart(query="x", channels=["search"]))
    parts.novelty.gate = asyncio.Event()
    cancelled = await parts.funnel.cancel(other.id)
    assert cancelled.state == "cancelled"


async def test_n7_rules_and_explicit_dates(parts: SimpleNamespace) -> None:
    parts.rules["rules"] = ActiveRules(never=("blocked.example",))
    blocked = work(
        1,
        title="Blocked",
        topics=["T1"],
        locations=[KbScienceLocation(url="https://blocked.example/p", kind="publisher", open_access=False)],
    )
    undated = work(2, title="Undated", topics=["T1"]).model_copy(update={"publication": UNKNOWN})
    parts.science.search_works = [blocked, undated, work(3, title="Fine", topics=["T1"])]
    window = {"from_date": "2026-01-01", "unknown": "exclude"}
    run = await run_to_end(
        parts, KbFunnelStart.model_validate({"query": "a", "channels": ["search"], "dates": window})
    )
    assert run.counters.after_rules == 1
    reasons = parts.jobs.results(run.id, "rules")
    assert '"search_rules"' in reasons["work-1"] and '"outside_dates"' in reasons["work-2"]


# -- free steps, Check novelty, reuse ----------------------------------------------------------------------


async def test_free_only_run_leaves_candidates_waiting_and_check_novelty_reuses_them(
    parts: SimpleNamespace,
) -> None:
    parts.deciders._layer = FakeLayer("openrouter_jev", off_topic=set())
    parts.science.search_works = [work(1, topics=["T1"]), work(2, topics=["T1"])]
    weekly = await run_to_end(parts, KbFunnelStart(area_id="area-ai", channels=["search"]), free_only=True)
    assert weekly.state == "done" and weekly.budget.free_only
    assert parts.deciders._layer.asked == 0 and parts.novelty.checked == []
    waiting = await parts.funnel.waiting(weekly.id)
    assert waiting == ["work-1", "work-2"]
    assert [n for n in parts.kb.notifications() if n.kind == "explore_finished"] == []
    searches = parts.science.count("search")
    check = await run_to_end(parts, KbFunnelStart(candidate_ids=waiting))
    assert parts.science.count("search") == searches  # the works were known: no request
    assert check.state == "done" and check.counters.new == 2


async def test_a_search_does_not_offer_an_earlier_work_twice(parts: SimpleNamespace) -> None:
    parts.science.search_works = [work(1, topics=["T1"])]
    await run_to_end(parts, KbFunnelStart(query="agents", channels=["search"]))
    again = await run_to_end(parts, KbFunnelStart(query="agents", channels=["search"]))
    assert again.counters.after_rules == 0  # Explore doesn't show the same work twice


async def test_covered_findings_are_hidden_and_counted(parts: SimpleNamespace) -> None:
    parts.novelty.labels = {"Old news": "covered", "Against": "contradicts"}
    parts.science.search_works = [
        work(1, title="Old news", topics=["T1"]),
        work(2, title="Against", topics=["T1"]),
    ]
    await run_to_end(parts, KbFunnelStart(area_id="area-ai", query="agents", channels=["search"]))
    shown = await parts.funnel.findings()
    assert shown.covered_count == 1
    assert [f.work.title for g in shown.groups for f in g.findings] == ["Against"]
    assert shown.groups[0].findings[0].reason == "Contradicts your wiki on «Agents»."
    everything = await parts.funnel.findings(include_covered=True)
    assert len([f for g in everything.groups for f in g.findings]) == 2
    paged = await parts.funnel.findings(include_covered=True, limit=1)
    assert paged.next_cursor == "1"
    assert parts.funnel.new_by_area() == {"area-ai": 1}


async def test_paid_useful_finding_gets_its_access_check(parts: SimpleNamespace) -> None:
    # EX3: a real abstract keeps a paid work (no open copy answers) instead of dropping it as «no text».
    parts.science.search_works = [work(1, paid=True, topics=["T1"], abstract=REAL_ABSTRACT)]
    await run_to_end(parts, KbFunnelStart(query="agents", channels=["search"]))
    (finding,) = [f for g in (await parts.funnel.findings()).groups for f in g.findings]
    assert parts.science.count("paid_access") == 1
    assert finding.access == "paid"
    assert finding.work.access.alternatives_checked
    assert finding.work.access.recommendation == "New compared with your wiki."


# -- jobs and recovery -------------------------------------------------------------------------------------


async def test_jobs_lists_every_owner_and_unknown_runs_are_not_found(parts: SimpleNamespace) -> None:
    link_budget = KbRunBudget(
        unit="link", limit=100, used=0, remaining=100, total_used=0, batch=1, free_only=True
    )
    links = parts.jobs.create("links", "Check links", "links", link_budget)
    jobs = await parts.funnel.jobs()
    assert [(j.id, j.owner, j.title) for j in jobs.jobs] == [(links.id, "links", "Check links")]
    with pytest.raises(NotFound):
        await parts.funnel.run(links.id)  # not a funnel run
    with pytest.raises(NotFound):
        await parts.funnel.finding("finding-missing")


async def test_quit_pauses_with_app_exit_and_the_next_start_resumes(parts: SimpleNamespace) -> None:
    parts.science.search_works = [work(1, topics=["T1"])]
    parts.novelty.gate = asyncio.Event()
    started = await parts.funnel.start(KbFunnelStart(query="agents", channels=["search"]))
    for _ in range(50):
        if (await parts.funnel.run(started.id)).stage == "novelty":
            break
        await asyncio.sleep(0.01)
    await parts.funnel.aclose()
    assert (await parts.funnel.run(started.id)).stop_reason == "app_exit"
    parts.novelty.gate.set()
    # User decision B2-7 (A): the next start goes on with free steps only; paid novelty waits for Continue.
    assert await parts.funnel.on_start() == [started.id]
    paused = await parts.funnel.settled(started.id)
    assert (paused.state, paused.stop_reason) == ("paused", "app_exit")
    assert parts.novelty.checked == []
    assert paused.checkpoint is not None
    resumed = await parts.funnel.resume(
        started.id, KbContinue(checkpoint_id=paused.checkpoint.id, revision=paused.checkpoint.revision)
    )
    assert resumed.state == "running"
    done = await parts.funnel.settled(started.id)
    assert done.state == "done" and parts.novelty.checked == ["work-1"]


# -- Add to materials -----------------------------------------------------------------------------


async def _one_finding(parts: SimpleNamespace, **kwargs: Any) -> Any:
    parts.science.search_works = [work(1, topics=["T1"], doi="10.1000/new", **kwargs)]
    await run_to_end(parts, KbFunnelStart(query="agents", channels=["search"]))
    return next(f for g in (await parts.funnel.findings()).groups for f in g.findings)


async def test_add_to_materials_full_text_or_abstract_honestly(parts: SimpleNamespace) -> None:
    finding = await _one_finding(parts)
    parts.science.texts["work-1"] = KbScienceText(
        work_id="work-1",
        kind="abstract_only",
        text="An abstract.",
        source_url=None,
        access=finding.work.access,
    )
    parts.finding_marks[finding.id] = "useful_method"
    imported = await parts.funnel.add_to_materials(finding.id)
    assert imported.content == "abstract_only" and imported.to_wiki is False
    ((prepared, folder, to_wiki),) = parts.sources.prepared
    assert to_wiki is False and folder == parts.kb.explore_folder().id
    assert prepared.title == "Work 1 (abstract only)"
    assert prepared.origin.url == "https://doi.org/10.1000/new"
    assert parts.moved == [(finding.id, imported.material_id)]  # the read mark goes with it (B4)
    after = await parts.funnel.finding(finding.id)
    assert after.material_id == imported.material_id and after.text_available == "abstract_only"
    again = await parts.funnel.add_to_materials(finding.id)
    assert again.material_id == imported.material_id and len(parts.sources.prepared) == 1


# -- review fixes (FX-A) -------------------------------------------------------------------------------------


async def _paused_by_daily_limit(parts: SimpleNamespace, works: int = 1) -> Any:
    parts.science.search_works = [work(n, topics=["T1"]) for n in range(1, works + 1)]
    parts.science.error = ScienceDailyLimit(datetime(2026, 11, 11, 0, 0))
    first = await parts.funnel.start(KbFunnelStart(query="agents", channels=["search"]))
    paused = await parts.funnel.settled(first.id)
    assert (paused.state, paused.stop_reason) == ("paused", "openalex_daily_limit")
    parts.science.error = None
    return paused


async def test_two_concurrent_continues_start_one_runner(parts: SimpleNamespace) -> None:
    """Review R1-03: the same checkpoint continued twice at once (two clients, a double click)."""
    paused = await _paused_by_daily_limit(parts)
    assert paused.checkpoint is not None
    body = KbContinue(checkpoint_id=paused.checkpoint.id, revision=paused.checkpoint.revision)
    parts.novelty.gate = asyncio.Event()
    outcomes = await asyncio.gather(
        parts.funnel.resume(paused.id, body), parts.funnel.resume(paused.id, body), return_exceptions=True
    )
    lost = [o for o in outcomes if isinstance(o, BaseException)]
    assert len(lost) == 1 and isinstance(lost[0], KnowledgeError) and lost[0].status_code == 409
    parts.novelty.gate.set()
    done = await parts.funnel.settled(paused.id)
    assert (done.state, done.counters.novelty_checked) == ("done", 1)
    assert parts.novelty.checked == ["work-1"]  # the paid comparison ran once
    assert parts.science.count("search") == 2  # the refused first try and one Continue


async def test_continue_waits_for_the_stopping_runner_and_never_runs_two(parts: SimpleNamespace) -> None:
    """Review R1-03: one runner per run id, even when Continue lands while the old runner is ending."""
    paused = await _paused_by_daily_limit(parts)
    assert paused.checkpoint is not None
    ending = asyncio.get_running_loop().create_future()
    parts.funnel._tasks[paused.id] = ending  # the runner that paused is still finishing
    body = KbContinue(checkpoint_id=paused.checkpoint.id, revision=paused.checkpoint.revision)
    resuming = asyncio.ensure_future(parts.funnel.resume(paused.id, body))
    await asyncio.sleep(0.05)
    assert not resuming.done() and parts.science.count("search") == 1  # no second runner yet
    ending.set_result(None)
    await resuming
    done = await parts.funnel.settled(paused.id)
    assert done.state == "done" and parts.novelty.checked == ["work-1"]


class _Crash(BaseException):
    """The process dies here (power loss, kill): nothing after this line runs."""


async def test_crash_after_novelty_results_never_grants_extra_paid_work(parts: SimpleNamespace) -> None:
    """Review R1-04: completed novelty work and its budget charge are one write."""
    parts.science.search_works = [work(n, topics=["T1"]) for n in range(1, 41)]
    names = ("complete", "complete_charged")
    real = {name: getattr(parts.jobs, name) for name in names if hasattr(parts.jobs, name)}
    written = {"novelty": 0}

    def crashing(name: str) -> Any:
        def call(*args: Any, **kwargs: Any) -> Any:
            result = real[name](*args, **kwargs)
            stage = args[2] if len(args) > 2 else kwargs.get("stage")
            if stage == "novelty":
                written["novelty"] += 1
                if written["novelty"] == 30:
                    raise _Crash()  # right after the 30th result row is saved
            return result

        return call

    for name in real:
        setattr(parts.jobs, name, crashing(name))
    started = await parts.funnel.start(KbFunnelStart(query="agents", channels=["search"]))
    with pytest.raises(_Crash):
        await parts.funnel.settled(started.id)
    for name, method in real.items():
        setattr(parts.jobs, name, method)
    assert parts.jobs.recover() == [started.id]  # next launch
    crashed = await parts.funnel.run(started.id)
    assert crashed.checkpoint is not None
    await parts.funnel.resume(
        started.id, KbContinue(checkpoint_id=crashed.checkpoint.id, revision=crashed.checkpoint.revision)
    )
    paused = await parts.funnel.settled(started.id)
    assert (paused.state, paused.stop_reason) == ("paused", "budget")
    assert (paused.budget.used, paused.budget.remaining, paused.budget.total_used) == (30, 0, 30)
    assert len(parts.novelty.checked) == 30 and paused.counters.novelty_checked == 30


async def test_a_broken_wiki_index_pauses_instead_of_comparing_with_nothing(ready: KnowledgeService) -> None:
    """Review R1-07: a failed claims lookup is not "no claims found"."""
    claims = WikiClaims(ready.db)
    with ready.db.write() as connection:
        connection.execute("DROP TABLE blocks_fts")
    with pytest.raises(NoveltyUnavailable):
        claims.for_text("retrieval augmented agents")
    assert claims.for_text("a b c") == []  # nothing to look for is an honest empty answer


def test_the_search_line_limit_is_the_science_topic_limit() -> None:
    """Review R1-12: a query the funnel accepts always fits the science payload."""
    longest = KbFunnelStart(query="x" * 300)
    assert KbSciencePayload(topics=[longest.query]).topics == [longest.query]
    with pytest.raises(ValidationError):
        KbFunnelStart(query="x" * 301)


async def test_a_too_long_search_line_is_rejected_before_a_run_exists(kb_app: Any, kb_client: Any) -> None:
    runtime = kb_app.state.runtime
    runtime.kb.connect(None)
    response = await kb_client.post("/kb/explore/runs", json={"query": "x" * 301, "channels": ["search"]})
    assert (response.status_code, response.json()) == (422, {"code": "invalid_request"})
    assert runtime.kb_explore.job_store.recent() == []


async def test_add_to_materials_keeps_the_known_area_and_topics(parts: SimpleNamespace) -> None:
    """EX2: retain the chosen own topic as intake metadata for the ingest labelling hook."""
    parts.science.search_works = [work(1, topics=["T1"], doi="10.1000/new")]
    await run_to_end(parts, KbFunnelStart(area_id="area-ai", query="agents", channels=["search"]))
    finding = next(f for g in (await parts.funnel.findings()).groups for f in g.findings)
    assert finding.area_id == "area-ai"
    parts.science.texts["work-1"] = KbScienceText(
        work_id="work-1", kind="abstract_only", text="", source_url=None, access=finding.work.access
    )
    imported = await parts.funnel.add_to_materials(finding.id)
    ((prepared, _folder, _to_wiki),) = parts.sources.prepared
    origin = prepared.origin.model_dump()
    assert (origin["area_id"], origin["topic_ids"]) == ("area-ai", ["T1"])
    assert imported.material_id is not None


async def test_an_own_parent_topic_lists_the_findings_its_tile_counts(parts: SimpleNamespace) -> None:
    """The injected area scope applies to own-topic descendants, independent of hidden taxonomy ids."""
    with parts.kb.db.write() as db:
        db.execute(
            "INSERT INTO explore_areas(id,level,name,original_name)"
            " VALUES ('own-parent','custom','AI tools','AI tools')"
        )
        db.execute("UPDATE explore_areas SET parent_id='own-parent' WHERE id='area-ai'")
    parts.funnel.area_scope = parts.funnel.planner.scope
    parts.novelty.labels = {"Old news": "covered"}
    parts.science.search_works = [work(1, topics=["T1"]), work(2, title="Old news", topics=["T1"])]
    await run_to_end(parts, KbFunnelStart(area_id="area-ai", query="agents", channels=["search"]))
    assert parts.funnel.new_by_area() == {"area-ai": 1}
    for scope in ("own-parent", "area-ai"):
        shown = await parts.funnel.findings(area_id=scope)
        assert [f.work.id for g in shown.groups for f in g.findings] == ["work-1"], scope
        assert shown.covered_count == 1, scope
