"""Engine quota pauses at the fake-engine seam, with a manual clock/scheduler and no sleeps."""
from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest

from skaz.knowledge.agents.engine import AgentTurn, Failed, ModelOption, TextDelta
from skaz.knowledge.agents.fake import FakeEngine, Gate, ScriptItem
from skaz.knowledge.ingest.execution import ProcessingProfile, execution_scope, stored_scope
from skaz.knowledge.ingest.jobs import EngineLimited, JobRecord
from skaz.knowledge.ingest.service import IngestBusy, IngestService
from skaz.knowledge.service import KnowledgeService
from skaz.knowledge.wiki.agent import AgentCaller
from skaz.knowledge.wiki.jobs import JobContext, WikiJobs
from skaz.knowledge.wiki.service import WikiService
from skaz.knowledge.wiring import follow_up_continuer

from .ingest_support import PatternDetector, ScriptedWiki, add_material, block, cite, notes
from .test_ingest_pipeline import NOTES_OK


@dataclass
class Alarm:
    at: datetime
    callback: Callable[[], None]
    cancelled: bool = False

    def cancel(self) -> None:
        self.cancelled = True


@dataclass
class Clock:
    now: datetime = datetime(2026, 11, 11, 12, tzinfo=UTC)
    alarms: list[Alarm] = field(default_factory=list)

    def __call__(self) -> datetime:
        return self.now

    def schedule(self, after: float, callback: Callable[[], None]) -> Alarm:
        alarm = Alarm(self.now + timedelta(seconds=after), callback)
        self.alarms.append(alarm)
        return alarm

    def advance(self, seconds: float) -> None:
        self.now += timedelta(seconds=seconds)
        for alarm in list(self.alarms):
            if not alarm.cancelled and alarm.at <= self.now:
                alarm.cancelled = True
                alarm.callback()


def engine_with_limit(retry_at: datetime | None) -> FakeEngine:
    wiki = ScriptedWiki(notes=[NOTES_OK] * 12)
    first = True

    def answer(turn: AgentTurn) -> list[ScriptItem]:
        nonlocal first
        if first:
            first = False
            return [Failed("", "limit", "PRIVATE provider detail", retry_at)]
        return wiki._answer(turn)

    return FakeEngine("codex", script=answer)


def service(kb: KnowledgeService, engine: FakeEngine, clock: Clock) -> IngestService:
    ingest = IngestService(kb, engines=lambda _id: engine, detector=PatternDetector(),
                           clock=clock, schedule=clock.schedule)
    ingest.slots = lambda: 1  # type: ignore[method-assign]
    return ingest


async def drain(ingest: IngestService) -> None:
    """Join actual tasks and their queue pumps, rather than polling time or sleeping."""
    for _ in range(100):
        tasks = [active.task for active in ingest._active.values() if active.task is not None]
        if ingest._pump_task is not None:
            tasks.append(ingest._pump_task)
        tasks = [task for task in tasks if not task.done()]
        if not tasks:
            return
        await asyncio.wait_for(asyncio.gather(*(asyncio.shield(task) for task in tasks)), 5)
    raise AssertionError("queue did not settle")


async def limited(kb: KnowledgeService, clock: Clock, retry_at: datetime | None,
                  count: int = 2) -> tuple[IngestService, FakeEngine, list[JobRecord]]:
    engine = engine_with_limit(retry_at)
    ingest = service(kb, engine, clock)
    materials = [add_material(kb, "Quota", f"Lecture {n}", kind="pdf") for n in range(count)]
    # Keep all requests queued before the first model call; then release one engine slot.
    ingest.slots = lambda: 0  # type: ignore[method-assign]
    jobs = [await ingest.request_ingest(material) for material in materials]
    ingest.slots = lambda: 1  # type: ignore[method-assign]
    ingest.resume()
    await drain(ingest)
    return ingest, engine, jobs


async def test_limit_pauses_only_its_engine_and_retains_the_queued_jobs(ready: KnowledgeService) -> None:
    clock = Clock()
    reset = clock.now + timedelta(hours=1)
    ingest, codex, jobs = await limited(ready, clock, reset)
    first, queued = (ingest.job(job.id) for job in jobs)
    assert (first.state, first.error_code, first.can_retry) == ("paused", "ENGINE_LIMIT", False)
    assert first.engine_pause is not None and first.engine_pause.retry_at == reset
    assert queued.state == "queued" and queued.engine_pause == first.engine_pause
    assert len(codex.turns) == 1 and "PRIVATE" not in repr(first)
    hermes = ScriptedWiki(notes=[NOTES_OK]).engine
    hermes._id = "hermes"
    ingest.engines = lambda selected: hermes if selected == "hermes" else codex
    ingest.update_settings(engine="hermes")
    other = await ingest.request_ingest(add_material(ready, "Quota", "Other engine", kind="pdf"))
    await drain(ingest)
    assert ingest.job(other.id).state == "done" and ingest.job(queued.id).state == "queued"
    await ingest.close()


async def test_resume_occurs_at_the_reset_and_never_before_it(ready: KnowledgeService) -> None:
    clock = Clock()
    ingest, engine, jobs = await limited(ready, clock, clock.now + timedelta(hours=1))
    clock.advance(3599)
    await drain(ingest)
    assert len(engine.turns) == 1 and ingest.job(jobs[0].id).state == "paused"
    clock.advance(1)
    await drain(ingest)
    assert [ingest.job(job.id).state for job in jobs] == ["done", "done"]
    await ingest.close()


async def test_pause_and_automatic_resume_survive_a_new_service(ready: KnowledgeService) -> None:
    clock = Clock()
    first, engine, jobs = await limited(ready, clock, clock.now + timedelta(hours=1))
    await first.close()
    restarted = service(ready, engine, clock)
    restarted.resume()
    await drain(restarted)
    assert [restarted.job(job.id).state for job in jobs] == ["paused", "queued"]
    clock.advance(3600)
    await drain(restarted)
    assert [restarted.job(job.id).state for job in jobs] == ["done", "done"]
    await restarted.close()


async def test_unknown_reset_waits_for_continue_now(ready: KnowledgeService) -> None:
    clock = Clock()
    ingest, engine, jobs = await limited(ready, clock, None)
    clock.advance(10 * 86400)
    ingest.resume()
    await drain(ingest)
    assert len(engine.turns) == 1 and ingest.job(jobs[0].id).state == "paused"
    await ingest.continue_job(jobs[0].id)
    await drain(ingest)
    assert [ingest.job(job.id).state for job in jobs] == ["done", "done"]
    await ingest.close()


async def test_stop_cancels_a_paused_job_without_resuming_the_rest(ready: KnowledgeService) -> None:
    clock = Clock()
    ingest, engine, jobs = await limited(ready, clock, None)
    stopped = await ingest.cancel(jobs[0].id)
    assert stopped.state == "cancelled" and stopped.engine_pause is None
    await drain(ingest)
    assert len(engine.turns) == 1 and ingest.job(jobs[1].id).state == "queued"
    await ingest.close()


async def test_explicit_model_switch_continues_on_the_new_engine_without_unlocking_the_old(
    ready: KnowledgeService,
) -> None:
    clock = Clock()
    ingest, codex, jobs = await limited(ready, clock, None)
    other = ScriptedWiki(notes=[NOTES_OK]).engine
    other._id = "hermes"
    ingest.engines = lambda selected: other if selected == "hermes" else codex
    ingest.update_settings(engine="hermes", model="fake-model")
    await ingest.request_from_user(jobs[0].material_id or "")
    await drain(ingest)
    continued = ingest.job(jobs[0].id)
    assert continued.state == "done" and continued.execution is not None
    assert continued.execution.profile.engine == "hermes"
    assert other.turns[0].model == "fake-model" and len(codex.turns) == 1
    assert ingest.job(jobs[1].id).state == "queued"
    await ingest.close()


async def test_a_follow_up_waits_without_sending_and_continues_at_the_reset(ready: KnowledgeService) -> None:
    clock = Clock()
    ingest, _engine, parents = await limited(ready, clock, clock.now + timedelta(hours=1), count=1)
    wiki = WikiJobs(ingest.jobs, profile=ingest.profile)
    calls: list[str] = []

    async def work(context: JobContext) -> None:
        calls.append(context.job_id)

    with execution_scope(stored_scope(ready.db, parents[0].id)):
        follow = await wiki.start("connections", None, "finding_connections", work)
    await wiki.wait(follow.id)
    assert ingest.job(follow.id).state == "paused" and calls == []
    clock.advance(3600)
    await drain(ingest)
    await wiki.wait(follow.id)
    assert ingest.job(follow.id).state == "done" and calls == [follow.id]
    await wiki.close()
    await ingest.close()


async def test_a_limit_during_follow_up_pauses_the_same_engine_queue(ready: KnowledgeService) -> None:
    clock = Clock()
    engine = engine_with_limit(clock.now + timedelta(hours=1))
    ingest = service(ready, engine, clock)
    wiki = WikiJobs(ingest.jobs, profile=lambda: ProcessingProfile("codex", None, None, "en"))

    async def work(_context: JobContext) -> None:
        await AgentCaller(engine, "follow-up").ask("fixture", (), {"title": "fixture"})

    follow = await wiki.start("folder_overview", "folder", "writing_overview", work)
    await wiki.wait(follow.id)
    await drain(ingest)
    assert ingest.job(follow.id).state == "paused"
    queued = await ingest.request_ingest(add_material(ready, "Quota", "Waits", kind="pdf"))
    assert queued.state == "queued" and len(engine.turns) == 1
    await wiki.close()
    await ingest.close()


async def test_http_pause_metadata_continue_and_stop(kb_app: Any, kb_client: httpx.AsyncClient) -> None:
    await kb_client.post("/kb/library", json={})
    runtime = kb_app.state.runtime
    clock = Clock()
    ingest, _engine, jobs = await limited(runtime.kb, clock, None)
    runtime.kb_ingest = ingest
    paused = (await kb_client.get(f"/kb/jobs/{jobs[0].id}")).json()
    assert paused["state"] == "paused" and paused["engine_pause"] == {"engine": "codex", "retry_at": None}
    stopped = await kb_client.post(f"/kb/jobs/{jobs[1].id}/cancel")
    assert stopped.status_code == 200 and stopped.json()["state"] == "cancelled"
    resumed = await kb_client.post(f"/kb/jobs/{jobs[0].id}/continue")
    assert resumed.status_code == 202
    await drain(ingest)
    assert ingest.job(jobs[0].id).state == "done"
    await ingest.close()


async def test_stale_reset_does_not_spin_or_automatically_spend_again(ready: KnowledgeService) -> None:
    clock = Clock()
    ingest, engine, jobs = await limited(ready, clock, clock.now - timedelta(minutes=1))
    assert len(engine.turns) == 1 and ingest.job(jobs[0].id).state == "paused"
    pause = ingest.job(jobs[0].id).engine_pause
    assert pause is not None and pause.retry_at is None
    await ingest.close()


async def test_running_jobs_reach_their_own_limit_and_the_latest_reset_wins(ready: KnowledgeService) -> None:
    clock = Clock()
    gates = [asyncio.Event(), asyncio.Event()]
    both_started = asyncio.Event()
    answers = ScriptedWiki(notes=[NOTES_OK] * 4)
    calls = 0

    def answer(turn: AgentTurn) -> list[ScriptItem]:
        nonlocal calls
        calls += 1
        if calls == 2:
            both_started.set()
        if calls <= 2:
            return [Gate(gates[calls - 1]), Failed("", "limit", "fixture",
                                                  clock.now + timedelta(hours=calls))]
        return answers._answer(turn)

    engine = FakeEngine("codex", script=answer)
    ingest = service(ready, engine, clock)
    ingest.slots = lambda: 2  # type: ignore[method-assign]
    jobs = [await ingest.request_ingest(add_material(ready, "Quota", f"Running {n}", kind="pdf"))
            for n in range(3)]
    first_task = ingest._active[jobs[0].id].task
    second_task = ingest._active[jobs[1].id].task
    assert first_task is not None and second_task is not None
    await asyncio.wait_for(both_started.wait(), 5)
    gates[0].set()
    await asyncio.shield(first_task)
    assert [ingest.job(job.id).state for job in jobs] == ["paused", "running", "queued"]
    assert len(engine.turns) == 2
    gates[1].set()
    await asyncio.shield(second_task)
    await drain(ingest)
    clock.advance(3600)
    await drain(ingest)
    assert [ingest.job(job.id).state for job in jobs] == ["paused", "paused", "queued"]
    clock.advance(3600)
    await drain(ingest)
    assert [ingest.job(job.id).state for job in jobs] == ["done", "done", "done"]
    await ingest.close()


async def test_finished_streamed_sections_stay_in_the_checkpoint_at_a_quota_pause(
    ready: KnowledgeService,
) -> None:
    clock = Clock()
    one = json.loads(NOTES_OK)["sections"][0]
    second = notes(("Температура", [block("from_source", "Температура показывает энергию частиц.",
                                           cite(2, "среднюю кинетическую энергию частиц"))]))
    wiki = ScriptedWiki(notes=[second])
    first = True

    def answer(turn: AgentTurn) -> list[ScriptItem]:
        nonlocal first
        if first:
            first = False
            return [TextDelta("", '{"sections": [' + json.dumps(one) + ', {"title": "unfinished'),
                    Failed("", "limit", "fixture")]
        return wiki._answer(turn)

    engine = FakeEngine("codex", script=answer)
    ingest = service(ready, engine, clock)
    material = add_material(ready, "Quota", "Checkpoint", kind="pdf")
    ingest.update_settings(engine="codex", model="fake-model")
    job = await ingest.request_ingest(material)
    await drain(ingest)
    assert ingest.job(job.id).state == "paused"
    with ready.db.read() as connection:
        saved = connection.execute("SELECT response FROM wiki_checkpoint_answers WHERE material_id = ?",
                                   (material,)).fetchall()
    assert saved and "Энтропия" in saved[0][0]
    await ingest.continue_job(job.id)
    await drain(ingest)
    assert ingest.job(job.id).state == "done" and ingest.job(job.id).counters["notes_sections"] == 2
    await ingest.close()


async def test_material_follow_ups_resume_after_restart_with_the_same_root_and_budget(
    ready: KnowledgeService,
) -> None:
    clock = Clock()
    ingest, engine, parents = await limited(ready, clock, clock.now + timedelta(hours=1), count=1)
    wiki = WikiService(ready, ingest)
    parent_scope = stored_scope(ready.db, parents[0].id)
    assert parent_scope is not None
    material = ready.material_repo.get(parents[0].material_id or "")
    assert material is not None
    with execution_scope(parent_scope):
        follow = await wiki.write_overview(material.folder_id)
    await wiki.jobs.wait(follow.id)
    assert ingest.job(follow.id).state == "paused"
    await wiki.jobs.close()
    await ingest.close()

    restarted = service(ready, engine, clock)
    next_wiki = WikiService(ready, restarted)
    restarted.continue_follow_ups = follow_up_continuer(next_wiki)
    restarted.resume()
    await drain(restarted)
    clock.advance(3600)
    await drain(restarted)
    await next_wiki.jobs.idle("folder_overview")
    continued = [job for job in restarted.jobs.list_all()
                 if job.kind == "folder_overview" and job.id != follow.id]
    assert len(continued) == 1 and continued[0].state == "done"
    scope = stored_scope(ready.db, continued[0].id)
    assert scope is not None and scope.root_job_id == parent_scope.root_job_id
    assert scope.budget == parent_scope.budget and scope.profile == parent_scope.profile
    await next_wiki.jobs.close()
    await restarted.close()


async def test_continue_pins_the_new_model_before_releasing_the_engine_gate(
    ready: KnowledgeService, monkeypatch: pytest.MonkeyPatch,
) -> None:
    clock = Clock()
    ingest, engine, jobs = await limited(ready, clock, None, count=1)
    engine._models = (ModelOption("chosen-model", "Chosen"),)
    ingest.update_settings(engine="codex", model="chosen-model")
    loop = asyncio.get_running_loop()
    release = ingest.jobs.release_engine

    def release_with_queue_race(engine_id: str) -> None:
        release(engine_id)
        # The queue may run as soon as the DB gate is released, before this disk call returns.
        asyncio.run_coroutine_threadsafe(drain(ingest), loop).result(timeout=5)

    monkeypatch.setattr(ingest.jobs, "release_engine", release_with_queue_race)
    await ingest.continue_job(jobs[0].id)
    await drain(ingest)
    assert ingest.job(jobs[0].id).state == "done"
    assert all(turn.model == "chosen-model" for turn in engine.turns[1:])
    await ingest.close()


async def test_continue_on_another_paused_engine_releases_only_the_selected_engine(
    ready: KnowledgeService,
) -> None:
    clock = Clock()
    ingest, codex, jobs = await limited(ready, clock, None, count=1)
    other = ScriptedWiki(notes=[NOTES_OK, NOTES_OK]).engine
    other._id = "hermes"
    ingest.engines = lambda selected: other if selected == "hermes" else codex
    waiting = ingest.jobs.create(add_material(ready, "Quota", "Hermes queued", kind="pdf"),
                                 profile=ProcessingProfile("hermes", None, None, "en"), state="queued")
    ingest.jobs.pause(waiting.id, EngineLimited("hermes", None))
    ingest.update_settings(engine="hermes")
    await ingest.continue_job(jobs[0].id)
    await drain(ingest)
    assert ingest.job(jobs[0].id).state == "done" and ingest.job(waiting.id).state == "done"
    assert set(ingest.jobs.engine_pauses()) == {"codex"} and len(codex.turns) == 1
    await ingest.close()


async def test_a_nonrecoverable_standalone_wiki_check_never_claims_to_have_continued(
    ready: KnowledgeService,
) -> None:
    clock = Clock()
    engine = engine_with_limit(None)
    ingest = service(ready, engine, clock)
    wiki = WikiJobs(ingest.jobs, profile=ingest.profile)

    async def work(_context: JobContext) -> None:
        await AgentCaller(engine, "standalone").ask("fixture", (), {})

    job = await wiki.start("recheck", "page", "rechecking", work)
    await wiki.wait(job.id)
    await wiki.close()
    await ingest.close()
    restarted = service(ready, engine, clock)
    next_wiki = WikiJobs(restarted.jobs, profile=restarted.profile)
    with pytest.raises(IngestBusy, match="Start it again"):
        await restarted.continue_job(job.id)
    assert restarted.job(job.id).state == "paused" and len(engine.turns) == 1
    await next_wiki.close()
    await restarted.close()
