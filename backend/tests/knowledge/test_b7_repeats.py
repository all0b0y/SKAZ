"""0.4.0 B7 — N3 repeats: what a material repeats, and "Check older materials" with the decision model only.

Fakes only: the decision layer is scripted (never a real model) and ``JobStore`` is a fake that, like B2's,
writes the ``explore_jobs`` row the run table points at. The N2 fixtures (``test_n2_repeats``) provide a real
wiki with merged repeats.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable, Collection, Sequence
from datetime import UTC, datetime
from typing import Any, Literal

import pytest

from skaz.knowledge.api.contract_routes import ContractFailure
from skaz.knowledge.api.schemas_explore_common import (
    KbCheckpoint,
    KbContinue,
    KbExploreJob,
    KbJobOwner,
    KbRunBudget,
    KbRunCounters,
    KbRunStage,
    KbStopReason,
)
from skaz.knowledge.api.schemas_repeats import KbRepeatCheck, KbRepeatCheckStart
from skaz.knowledge.decisions.protocol import (
    Answer,
    ChoiceAnswer,
    ChoiceQuestion,
    Question,
    Undecided,
    YesNoAnswer,
)
from skaz.knowledge.errors import NotFound
from skaz.knowledge.repeats.compare import NONE_OPTION
from skaz.knowledge.repeats.reader import RepeatReader, text_hash
from skaz.knowledge.repeats.service import RepeatsService
from skaz.knowledge.repeats.store import Evidence, Judged, RepeatStore, StatementRef
from skaz.knowledge.service import KnowledgeService
from skaz.knowledge.wiki.overlap import material_overlap
from tests.knowledge.test_n2_overlap import TWO_SECTIONS
from tests.knowledge.test_n2_repeats import UNIT, Case, _case
from tests.knowledge.wiki_support import ENTROPY_TITLE

LONG_AGO = datetime(2026, 1, 1, tzinfo=UTC)
#: A cut-off after "now": every material of the test counts as added before N2.
FUTURE = datetime(2099, 1, 1, tzinfo=UTC)
AREA = "area-1"


# -- fakes -------------------------------------------------------------------------------------


class FakeJobStore:
    """``JobStore`` in memory; writes ``explore_jobs`` rows like B2 (the run table points at them)."""

    def __init__(self, kb: KnowledgeService) -> None:
        self.kb = kb
        self.jobs: dict[str, KbExploreJob] = {}
        self.work: dict[tuple[str, str], dict[str, str]] = {}
        self.created = 0

    def create(self, owner: KbJobOwner, title: str, stage: KbRunStage, budget: KbRunBudget) -> KbExploreJob:
        self.created += 1
        job_id = f"job-{self.created}"
        now = datetime(2026, 11, 9, 10, 0, tzinfo=UTC)
        counters = KbRunCounters(checked=0, after_rules=0, decided=0, on_topic=0, novelty_checked=0, new=0,
                                 covered=0)
        job = KbExploreJob(
            id=job_id, owner=owner, state="running", stage=stage, stop_reason=None, budget=budget,
            counters=counters, checkpoint=None, created_at=now, updated_at=now, decision_choices=[],
            decision_provider=None, retry_at=None)
        with self.kb.db.write() as connection:
            connection.execute(
                "INSERT INTO explore_jobs(id, owner, state, stage, title, budget_json, counters_json, "
                "created_at, updated_at) VALUES (?, ?, 'running', ?, ?, '{}', '{}', ?, ?)",
                (job_id, owner, stage, title, now.isoformat(), now.isoformat()))
        self.jobs[job_id] = job
        return job

    def get(self, job_id: str) -> KbExploreJob | None:
        return self.jobs.get(job_id)

    def active(self) -> Sequence[KbExploreJob]:
        return [job for job in self.jobs.values() if job.state in ("queued", "running", "paused")]

    def progress(self, job_id: str, *, stage: KbRunStage, budget: KbRunBudget,
                 counters: KbRunCounters) -> KbExploreJob:
        job = self.jobs[job_id].model_copy(update={"state": "running", "stop_reason": None, "stage": stage,
                                                    "budget": budget, "counters": counters,
                                                    "decision_choices": []})
        self.jobs[job_id] = job
        return job

    def stop(self, job_id: str, reason: KbStopReason, *, retry_at: str | None = None) -> KbExploreJob:
        state = {"completed": "done", "cancelled": "cancelled", "failed": "error"}.get(reason, "paused")
        choices = ["download_local", "openrouter_jev"] if reason == "decision_model_required" else []
        job = self.jobs[job_id].model_copy(update={"state": state, "stop_reason": reason,
                                                    "decision_choices": choices})
        self.jobs[job_id] = job
        return job

    def checkpoint(self, job_id: str, *, stage: KbRunStage, cursor: str | None, completed_ids: Sequence[str],
                   pending_ids: Sequence[str]) -> KbCheckpoint:
        job = self.jobs[job_id]
        revision = job.checkpoint.revision + 1 if job.checkpoint else 1
        saved = KbCheckpoint(id=f"cp-{job_id}-{revision}", revision=revision, stage=stage, cursor=cursor,
                             completed_ids=list(completed_ids), pending_ids=list(pending_ids),
                             saved_at=datetime(2026, 11, 9, 10, 1, tzinfo=UTC))
        self.jobs[job_id] = job.model_copy(update={"checkpoint": saved})
        return saved

    def complete(self, job_id: str, candidate_id: str, stage: KbRunStage, result_json: str) -> None:
        bucket = self.work.setdefault((job_id, stage), {})
        if candidate_id in bucket:
            raise ValueError("the same work twice")
        bucket[candidate_id] = result_json

    def completed(self, job_id: str, stage: KbRunStage) -> Collection[str]:
        return set(self.work.get((job_id, stage), {}))

    def recover(self) -> Sequence[str]:
        return []


class Layer:
    """A scripted decision layer: picks the first option sharing a word with the statement, then confirms."""

    id: Literal["local"] = "local"

    def __init__(self, p_yes: float = 0.95, *, pick_word: str = "беспорядка",
                 gate: asyncio.Event | None = None, undecided: str | None = None) -> None:
        self.p_yes, self.pick_word, self.gate, self.undecided = p_yes, pick_word, gate, undecided
        self.calls: list[Question] = []
        self.entered = asyncio.Event()

    async def ask(self, question: Question) -> Answer:
        self.calls.append(question)
        self.entered.set()
        if self.gate is not None:
            await self.gate.wait()
        if self.undecided is not None:
            return Undecided(self.undecided)
        if isinstance(question, ChoiceQuestion):
            options = list(question.options)
            about = self.pick_word in question.state
            chosen = next((option for option in options if about and self.pick_word in option
                           and option != NONE_OPTION), NONE_OPTION)
            return ChoiceAnswer(option=chosen, probabilities={chosen: 0.95}, confidence=0.95)
        return YesNoAnswer(p_yes=self.p_yes)

    async def ask_many(self, questions: Sequence[Question]) -> Sequence[Answer]:
        return [await self.ask(question) for question in questions]

    @property
    def choices(self) -> int:
        return sum(isinstance(call, ChoiceQuestion) for call in self.calls)


class Directory:
    """``AreaDirectory`` for one area that holds the given materials."""

    def __init__(self, material_ids: Sequence[str]) -> None:
        self.ids = list(material_ids)

    def area_for_topics(self, topic_ids: Sequence[str]) -> str | None:
        return None

    def area_path(self, area_id: str) -> Sequence[str]:
        return ("Physics",) if area_id == AREA else ()

    def topics(self, area_id: str) -> Sequence[str]:
        return ()

    def materials(self, area_id: str) -> Sequence[str]:
        return self.ids if area_id == AREA else ()

    def pinned(self) -> Sequence[str]:
        return ()

    def recently_active(self, limit: int = 10) -> Sequence[str]:
        return ()

    def read_marks(self, material_ids: Sequence[str]) -> dict[str, Any]:
        return {}


def age(kb: KnowledgeService, lecture: str, textbook: str) -> None:
    """The lecture was added first (the textbook can repeat it, not the other way round)."""
    with kb.db.write() as connection:
        for material_id, day in ((lecture, "01"), (textbook, "02")):
            connection.execute("UPDATE materials SET created_at = ? WHERE id = ?",
                               (f"2026-10-{day}T10:00:00+00:00", material_id))


def service_for(case: Case, layer: Layer | None, *, jobs: FakeJobStore | None = None, limit: int = 30,
                n2_from: datetime | None = FUTURE) -> tuple[RepeatsService, FakeJobStore, Layer | None]:
    age(case.kb, case.lecture, case.textbook)
    store = jobs or FakeJobStore(case.kb)
    service = RepeatsService(case.kb, areas=Directory([case.lecture, case.textbook]), decisions=lambda: layer,
                             jobs=store, batch_limit=limit, n2_from=n2_from)
    return service, store, layer


def continue_with(check: KbRepeatCheck) -> KbContinue:
    assert check.checkpoint is not None
    return KbContinue(checkpoint_id=check.checkpoint.id, revision=check.checkpoint.revision)


async def finish(service: RepeatsService, check: KbRepeatCheck) -> KbRepeatCheck:
    await asyncio.wait_for(service.join(check.id), 10)
    return await service.check(check.id)


# -- reading: N2 markers -----------------------------------------------------------------------


async def test_a_merged_repeat_shows_its_share_sources_and_paragraphs(ready: KnowledgeService) -> None:
    case = await _case(ready, p_yes=0.95, textbook_notes=TWO_SECTIONS)
    service, _jobs, _layer = service_for(case, None, n2_from=LONG_AGO)
    result = await service.material(case.textbook)
    overlap = material_overlap(ready, case.textbook)
    assert overlap is not None
    assert (result.status, result.percent, result.repeated, result.total) == (
        "checked", overlap.percent, overlap.repeated, overlap.total) == ("checked", 50, 1, 2)
    assert [(ref.material_id, ref.title) for ref in result.from_materials] == [(case.lecture, "Лекция 8")]
    assert result.checked_at is None  # N2 decided it when the material was added: no check run of ours
    [paragraph] = result.paragraphs  # the second section's statement is new: no mark
    assert paragraph.fragment_ids == [1] and paragraph.fully_repeated
    assert (paragraph.repeated_statements, paragraph.total_statements) == (1, 1)
    assert [ref.page_id for ref in paragraph.wiki_refs] == [case.page_id]
    assert paragraph.wiki_refs[0].title == ENTROPY_TITLE and paragraph.wiki_refs[0].block_id is not None
    assert [ref.material_id for ref in paragraph.from_materials] == [case.lecture]


async def test_the_first_source_repeats_nothing(ready: KnowledgeService) -> None:
    case = await _case(ready, p_yes=0.95)
    service, _jobs, _layer = service_for(case, None, n2_from=LONG_AGO)
    result = await service.material(case.lecture)
    assert (result.status, result.percent, result.repeated, result.paragraphs) == ("checked", 0, 0, [])
    assert result.from_materials == []


async def test_a_material_added_with_n2_that_repeated_nothing_is_checked_at_zero(
        ready: KnowledgeService) -> None:
    case = await _case(ready, p_yes=0.05)
    service, _jobs, _layer = service_for(case, None, n2_from=LONG_AGO)
    result = await service.material(case.textbook)
    assert (result.status, result.percent, result.repeated, result.total) == ("checked", 0, 0, 2)


async def test_a_material_from_before_n2_without_marks_is_not_checked(ready: KnowledgeService) -> None:
    case = await _case(ready, p_yes=0.05)
    service, _jobs, _layer = service_for(case, None)  # cut-off in the future: both are older than N2
    result = await service.material(case.textbook)
    assert (result.status, result.percent, result.repeated) == ("not_checked", None, 0)
    assert result.total == 2 and result.paragraphs == [] and result.from_materials == []
    summaries = service.summaries([case.lecture, case.textbook])
    assert {key: value.status for key, value in summaries.items()} == {
        case.lecture: "not_checked", case.textbook: "not_checked"}


async def test_marks_make_an_older_material_checked_without_any_run(ready: KnowledgeService) -> None:
    case = await _case(ready, p_yes=0.95)
    service, _jobs, _layer = service_for(case, None)
    assert (await service.material(case.textbook)).status == "checked"


async def test_an_unknown_material_is_not_found(ready: KnowledgeService) -> None:
    case = await _case(ready, p_yes=0.05)
    service, _jobs, _layer = service_for(case, None)
    with pytest.raises(NotFound):
        await service.material("mat-nope")
    assert service.summaries(["mat-nope"]) == {}


# -- Check older materials ---------------------------------------------------------------------


def page_text(case: Case) -> str:
    record = case.kb.page_repo.get(case.page_id)
    assert record is not None
    return (case.kb.library_root / record.rel_path).read_text(encoding="utf-8")


async def test_a_check_finds_the_repeat_and_changes_no_page(ready: KnowledgeService) -> None:
    case = await _case(ready, p_yes=0.05, textbook_notes=TWO_SECTIONS)  # N2 merged nothing
    layer = Layer()
    service, jobs, _ = service_for(case, layer)
    before = page_text(case)
    check = await service.start(KbRepeatCheckStart(area_id=AREA))
    assert check.owner == "repeats" and check.budget.unit == "claim_comparison" and check.budget.limit == 30
    check = await finish(service, check)
    assert (check.state, check.stop_reason, check.area_id) == ("done", "completed", AREA)
    assert (check.materials_checked, check.materials_remaining) == (2, 0)
    assert check.budget.free_only is False and check.budget.used == check.budget.total_used
    # The lecture's three statements have no earlier source: free. The textbook's two are compared (a pick,
    # plus a confirmation when one was picked).
    assert check.budget.used == 2 and layer.choices == 2
    assert (check.counters.checked, check.counters.covered, check.counters.new) == (5, 1, 4)
    assert page_text(case) == before  # nothing is merged or removed here
    textbook = await service.material(case.textbook)
    assert (textbook.status, textbook.repeated, textbook.total, textbook.percent) == ("checked", 1, 2, 50)
    assert [ref.material_id for ref in textbook.from_materials] == [case.lecture]
    assert textbook.checked_at is not None
    [paragraph] = textbook.paragraphs
    assert paragraph.fragment_ids == [1] and paragraph.repeated_statements == 1
    assert (await service.material(case.lecture)).repeated == 0
    assert all(item.status == "checked" for item in service.summaries([case.lecture, case.textbook]).values())
    assert jobs.created == 1


async def test_the_decision_layer_is_asked_with_untrusted_text_and_candidates_of_the_page(
        ready: KnowledgeService) -> None:
    case = await _case(ready, p_yes=0.05)
    layer = Layer()
    service, _jobs, _ = service_for(case, layer)
    await finish(service, await service.start(KbRepeatCheckStart(area_id=AREA)))
    first = layer.calls[0]
    assert isinstance(first, ChoiceQuestion)
    assert "untrusted" in first.state and "statement B" in first.state
    assert first.options[-1] == NONE_OPTION and len(first.options) <= 9
    assert not any("Учебник" in option for option in first.options)  # candidates are the earlier source's


async def test_an_unsure_confirmation_is_never_a_repeat(ready: KnowledgeService) -> None:
    case = await _case(ready, p_yes=0.05)
    service, _jobs, _ = service_for(case, Layer(p_yes=0.5))
    check = await finish(service, await service.start(KbRepeatCheckStart(area_id=AREA)))
    assert check.state == "done" and check.counters.covered == 0
    textbook = await service.material(case.textbook)
    assert textbook.status == "checked" and textbook.repeated == 0 and textbook.percent == 0


async def test_a_confident_no_to_the_confirmation_is_new(ready: KnowledgeService) -> None:
    case = await _case(ready, p_yes=0.05)
    service, _jobs, _ = service_for(case, Layer(p_yes=0.1))
    check = await finish(service, await service.start(KbRepeatCheckStart(area_id=AREA)))
    assert (check.counters.covered, check.counters.new) == (0, 5)


async def test_statements_without_an_earlier_counterpart_cost_nothing(ready: KnowledgeService) -> None:
    case = await _case(ready, p_yes=0.05)
    layer = Layer()
    service, _jobs, _ = service_for(case, layer)
    check = await finish(service, await service.start(KbRepeatCheckStart(area_id=AREA)))
    # The lecture (first source) has three statements; none was put to the model.
    assert check.counters.checked == 5 and check.budget.used == 2 and layer.choices == 2
    evidence = RepeatStore(ready.db).evidence([case.lecture])[case.lecture]
    assert evidence.status == "checked" and [item.verdict for item in evidence.judged.values()] == ["new"] * 3


async def test_the_budget_pauses_after_30_and_continue_never_repeats_work(ready: KnowledgeService) -> None:
    case = await _case(ready, p_yes=0.05, textbook_notes=TWO_SECTIONS)
    layer = Layer()
    service, jobs, _ = service_for(case, layer, limit=1)
    check = await finish(service, await service.start(KbRepeatCheckStart(area_id=AREA)))
    assert (check.state, check.stop_reason) == ("paused", "budget")
    assert (check.budget.used, check.budget.remaining, check.budget.batch) == (1, 0, 1)
    assert check.materials_remaining >= 1 and check.checkpoint is not None
    first_batch = layer.choices
    check = await service.resume(check.id, continue_with(check))
    check = await finish(service, check)
    assert (check.state, check.stop_reason) == ("done", "completed")
    assert check.budget.batch == 2 and check.budget.total_used == 2
    assert layer.choices == first_batch + 1  # the statement done in batch 1 was not asked again
    assert len(jobs.work[(check.id, "repeats")]) == 5
    assert (await service.material(case.textbook)).status == "checked"


async def test_a_stale_checkpoint_is_a_conflict_and_does_no_work(ready: KnowledgeService) -> None:
    case = await _case(ready, p_yes=0.05)
    layer = Layer()
    service, _jobs, _ = service_for(case, layer, limit=1)
    check = await finish(service, await service.start(KbRepeatCheckStart(area_id=AREA)))
    assert check.checkpoint is not None
    calls = len(layer.calls)
    with pytest.raises(Exception) as caught:
        await service.resume(check.id, KbContinue(checkpoint_id=check.checkpoint.id, revision=99))
    assert getattr(caught.value, "status_code", None) == 409
    assert len(layer.calls) == calls and (await service.check(check.id)).state == "paused"


async def test_pause_stops_between_comparisons_and_continue_goes_on(ready: KnowledgeService) -> None:
    case = await _case(ready, p_yes=0.05, textbook_notes=TWO_SECTIONS)
    gate = asyncio.Event()
    layer = Layer(gate=gate)
    service, _jobs, _ = service_for(case, layer)
    started = await service.start(KbRepeatCheckStart(area_id=AREA))
    await asyncio.wait_for(layer.entered.wait(), 5)
    pausing = asyncio.create_task(service.pause(started.id))
    await asyncio.sleep(0)
    gate.set()
    paused = await asyncio.wait_for(pausing, 10)
    assert (paused.state, paused.stop_reason) == ("paused", "user_pause")
    assert paused.budget.used == 1 and paused.checkpoint is not None  # the batch goes on where it stopped
    done = await finish(service, await service.resume(paused.id, continue_with(paused)))
    assert (done.state, done.budget.batch, done.budget.used) == ("done", 1, 2)


async def test_pausing_a_check_that_is_not_running_is_a_conflict(ready: KnowledgeService) -> None:
    case = await _case(ready, p_yes=0.05)
    service, _jobs, _ = service_for(case, Layer())
    check = await finish(service, await service.start(KbRepeatCheckStart(area_id=AREA)))
    with pytest.raises(Exception) as caught:
        await service.pause(check.id)
    assert getattr(caught.value, "status_code", None) == 409


async def test_a_second_check_of_a_running_area_is_a_conflict(ready: KnowledgeService) -> None:
    case = await _case(ready, p_yes=0.05)
    gate = asyncio.Event()
    layer = Layer(gate=gate)
    service, jobs, _ = service_for(case, layer)
    first = await service.start(KbRepeatCheckStart(area_id=AREA))
    await asyncio.wait_for(layer.entered.wait(), 5)
    with pytest.raises(Exception) as caught:
        await service.start(KbRepeatCheckStart(area_id=AREA))
    assert getattr(caught.value, "status_code", None) == 409 and jobs.created == 1
    gate.set()
    await finish(service, first)


async def test_without_a_decision_model_the_check_stops_and_asks_for_one(ready: KnowledgeService) -> None:
    case = await _case(ready, p_yes=0.05)
    service, _jobs, _ = service_for(case, None)
    check = await finish(service, await service.start(KbRepeatCheckStart(area_id=AREA)))
    assert (check.state, check.stop_reason) == ("paused", "decision_model_required")
    assert check.decision_choices == ["download_local", "openrouter_jev"] and check.checkpoint is not None
    assert (await service.material(case.textbook)).status == "not_checked"
    # Continue without a model changes nothing and says so again: no fallback to another model.
    again = await finish(service, await service.resume(check.id, continue_with(check)))
    assert (again.state, again.stop_reason) == ("paused", "decision_model_required")


async def test_a_layer_that_does_not_answer_stops_and_records_nothing(
        ready: KnowledgeService, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("skaz.knowledge.repeats.service.OUTAGE_STREAK", 2)
    case = await _case(ready, p_yes=0.05, textbook_notes=TWO_SECTIONS)
    layer = Layer(undecided="the local model is not running")
    # Give the lecture the later date, so its two statements on the shared page are the ones compared.
    service, jobs, _ = service_for(case, layer)
    with ready.db.write() as connection:
        connection.execute("UPDATE materials SET created_at = '2026-10-01T10:00:00+00:00' WHERE id = ?",
                           (case.textbook,))
        connection.execute("UPDATE materials SET created_at = '2026-10-02T10:00:00+00:00' WHERE id = ?",
                           (case.lecture,))
    await finish(service, await service.start(KbRepeatCheckStart(area_id=AREA)))
    check = await service.check("job-1")
    assert (check.state, check.stop_reason) == ("paused", "provider_unavailable")
    assert layer.choices == 2 and (await service.material(case.lecture)).status == "not_checked"
    # Only the lecture's statement with nothing to compare (decided without the model) was recorded.
    assert len(jobs.work.get(("job-1", "repeats"), {})) == 1


async def test_not_confident_is_a_verdict_not_an_outage(ready: KnowledgeService) -> None:
    case = await _case(ready, p_yes=0.05, textbook_notes=TWO_SECTIONS)
    unsure = Layer(undecided="Not confident enough (51% < 80%); the writing model decides.")
    service, _jobs, _ = service_for(case, unsure)
    check = await finish(service, await service.start(KbRepeatCheckStart(area_id=AREA)))
    assert (check.state, check.counters.covered) == ("done", 0)
    assert (await service.material(case.textbook)).status == "checked"


async def test_an_earlier_verdict_is_reused_by_a_later_run(ready: KnowledgeService) -> None:
    case = await _case(ready, p_yes=0.05)
    layer = Layer()
    service, jobs, _ = service_for(case, layer)
    await finish(service, await service.start(KbRepeatCheckStart(area_id=AREA)))
    calls = len(layer.calls)
    second = await finish(service, await service.start(KbRepeatCheckStart(area_id=AREA)))
    assert second.state == "done" and len(layer.calls) == calls and second.materials_checked == 0
    assert jobs.created == 2


async def test_unknown_area_not_found_and_no_job_without_the_job_store(ready: KnowledgeService) -> None:
    case = await _case(ready, p_yes=0.05)
    service, jobs, _ = service_for(case, Layer())
    with pytest.raises(NotFound):
        await service.start(KbRepeatCheckStart(area_id="nope"))
    assert jobs.created == 0
    unwired = RepeatsService(ready, areas=Directory([case.lecture]), decisions=lambda: None, jobs=None)
    with pytest.raises(ContractFailure) as caught:
        await unwired.start(KbRepeatCheckStart(area_id=AREA))
    assert (caught.value.status, caught.value.code) == (503, "not_ready")
    with pytest.raises(ContractFailure):
        await unwired.check("job-1")
    # Reading needs no job store.
    assert (await unwired.material(case.lecture)).status in ("checked", "not_checked")


# -- evidence stays honest ---------------------------------------------------------------------


def stored_case(case: Case, *, text_digest: str | None = None,
                match_block: str | None = None) -> RepeatReader:
    store = RepeatStore(case.kb.db)
    own = next(block for block in case.kb.page_repo.blocks(case.page_id)
               if block.text.startswith("Энтропия — мера беспорядка"))
    other = next(block for block in case.kb.page_repo.blocks(case.page_id)
                 if block.text.startswith("Мера беспорядка"))
    judged = Judged(case.page_id, own.block_id, text_digest or text_hash(own.text), "repeat",
                    StatementRef(case.page_id, match_block or other.block_id))
    store.save(Evidence(case.textbook, "checked", datetime(2026, 11, 9, tzinfo=UTC), {judged.key: judged}))
    return RepeatReader(case.kb, store, n2_from=FUTURE)


async def test_stored_evidence_counts_while_it_still_holds(ready: KnowledgeService) -> None:
    case = await _case(ready, p_yes=0.05)
    assert stored_case(case).material(case.textbook).repeated == 1


async def test_an_edited_statement_or_a_vanished_counterpart_is_not_counted(ready: KnowledgeService) -> None:
    case = await _case(ready, p_yes=0.05)
    assert stored_case(case, text_digest="0" * 16).material(case.textbook).repeated == 0  # text changed
    assert stored_case(case, match_block="c-gone-00000000").material(case.textbook).repeated == 0
    # The first source goes: what it repeated is gone with it.
    reader = stored_case(case)
    case.service.delete_material(case.lecture)
    assert reader.material(case.textbook).repeated == 0


def test_the_evidence_json_holds_ids_and_verdicts_only(ready: KnowledgeService) -> None:
    store = RepeatStore(ready.db)
    judged = Judged("page-1", "c-1", "abc", "repeat", StatementRef("page-2", "c-2"))
    store.save(Evidence("mat-x", "not_checked", None, {judged.key: judged}))
    with ready.db.read() as connection:
        raw = connection.execute("SELECT evidence_json FROM material_repeat_checks").fetchone()[0]
    assert set(json.loads(raw)["statements"][0]) == {"page", "block", "hash", "verdict", "match"}
    assert store.evidence(["mat-x"])["mat-x"].judged[judged.key] == judged


def test_unit_statement_text_is_not_needed_to_describe_a_candidate() -> None:
    assert UNIT  # the N2 fixture the other tests build on
    check: Callable[..., Any] = text_hash
    assert check("Энтропия [[Materials/x#^seg-1|x]]") == check("Энтропия")


async def test_paragraph_fragment_ids_are_segment_numbers(ready: KnowledgeService) -> None:
    # F5 matches ``fragment_ids`` against ``KbFragment.seg``: the unit statement cites segment 2.
    case = await _case(ready, p_yes=0.05, textbook_notes=TWO_SECTIONS)
    blocks = case.kb.page_repo.blocks(case.page_id)
    unit = next(block for block in blocks if block.text.startswith("Единица измерения"))
    other = next(block for block in blocks if block.text.startswith("Энтропия газа"))
    judged = Judged(case.page_id, unit.block_id, text_hash(unit.text), "repeat",
                    StatementRef(case.page_id, other.block_id))
    store = RepeatStore(ready.db)
    store.save(Evidence(case.textbook, "checked", datetime(2026, 11, 9, tzinfo=UTC), {judged.key: judged}))
    result = RepeatReader(ready, store, n2_from=FUTURE).material(case.textbook)
    assert [paragraph.fragment_ids for paragraph in result.paragraphs] == [[2]]
    assert result.paragraphs[0].wiki_refs[0].block_id == other.block_id


async def test_runtime_wires_kb_repeats_in_the_real_app(kb_client: object, kb_app: object) -> None:
    import httpx

    client = kb_client
    assert isinstance(client, httpx.AsyncClient)
    runtime = kb_app.state.runtime  # type: ignore[attr-defined]
    assert isinstance(runtime.kb_repeats, RepeatsService)
    # The decision layer is asked at call time (None while none is chosen), not captured at start.
    assert runtime.kb_repeats._decisions() is None
    assert runtime.kb_repeats._jobs is runtime.kb_jobs  # B2's JobStore, passed explicitly
    calls: list[tuple[str, str, dict[str, Any] | None]] = [
        ("GET", "/kb/materials/mat-1/repeats", None),
        ("POST", "/kb/explore/repeat-checks", {"area_id": "area-1"}),
        ("GET", "/kb/explore/repeat-checks/job-1", None),
        ("POST", "/kb/explore/repeat-checks/job-1/pause", None),
        ("POST", "/kb/explore/repeat-checks/job-1/continue", {"checkpoint_id": "cp-1", "revision": 1}),
    ]
    # No library: every route is not_ready.
    for method, path, body in calls:
        response = await client.request(method, path, json=body)
        assert (response.status_code, response.json()) == (503, {"code": "not_ready"}), path
    runtime.kb.connect(None)
    # With a library and B2's JobStore the routes answer for real: unknown ids are plain 404s.
    for method, path, body in calls:
        response = await client.request(method, path, json=body)
        assert (response.status_code, response.json()) == (404, {"code": "not_found"}), path

async def test_older_means_before_04_first_opened_this_library_option_a(ready: KnowledgeService) -> None:
    # User decision (option A): the boundary is when 0.4.0 first opened the library, kept per library. A
    # material from before it without repeat marks is "not checked" — never a false "checked, 0%".
    from skaz.knowledge.repeats.reader import MARKS_FROM_KEY, stamp_marks_from

    case = await _case(ready, p_yes=0.05)
    key = MARKS_FROM_KEY.format(library_id=ready.require().library_id)
    ready.settings.set(key, FUTURE.isoformat())  # 0.4.0 first opened this library after these materials
    reader = RepeatReader(ready, RepeatStore(ready.db))
    assert reader.is_older(case.lecture)
    ready.settings.set(key, LONG_AGO.isoformat())  # opened before they were added: N2 marks are there
    assert not reader.is_older(case.lecture)

    # The stamp is written once and then kept.
    ready.settings.set(key, None)
    first = stamp_marks_from(ready)
    assert first is not None and ready.settings.get(key) == first.isoformat()
    assert stamp_marks_from(ready) == first
