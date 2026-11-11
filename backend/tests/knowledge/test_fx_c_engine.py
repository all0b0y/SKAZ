"""FX-C reviewer scenarios: real job storage, fake engines, deterministic quota clock."""
from __future__ import annotations

import asyncio
from datetime import timedelta
from pathlib import Path
from typing import Any

import pytest

from skaz.knowledge.agents.engine import Completed, TextDelta
from skaz.knowledge.agents.fake import FakeEngine
from skaz.knowledge.ingest.jobs import EngineLimited, JobKind
from skaz.knowledge.ingest.service import IngestBusy
from skaz.knowledge.service import KnowledgeService
from skaz.knowledge.wiki.jobs import JobContext
from skaz.knowledge.wiki.service import WikiService

from .ingest_support import add_material
from .test_wr5_engine_queue import Clock, drain, limited, service


async def test_export_does_not_use_the_wiki_engine_quota(
    ready: KnowledgeService, documents: Path,
) -> None:
    clock = Clock()
    ingest, engine, _ = await limited(ready, clock, None, count=1)
    wiki = WikiService(ready, ingest)
    try:
        job = await wiki.export(str(documents / "export"), overwrite=False)
        await wiki.jobs.wait(job.id)
        assert ingest.job(job.id).state == "done"
        assert ingest.job(job.id).engine_pause is None and len(engine.turns) == 1
        assert "codex" in ingest.jobs.engine_pauses()
    finally:
        await wiki.jobs.close()
        await ingest.close()


async def test_recognition_uses_its_own_engine_gate_not_the_wiki_gate(ready: KnowledgeService) -> None:
    clock = Clock()
    ingest, codex, _ = await limited(ready, clock, None, count=1)
    other = FakeEngine("claude_code", script=lambda _: [TextDelta("", '{"corrections":[]}'), Completed("")])
    ingest.engines = lambda selected: other if selected == "claude_code" else codex
    ready.settings.set("recognition_engine", "claude_code")
    material = add_material(ready, "Quota", "Own recognition engine", kind="recording")
    wiki = WikiService(ready, ingest)
    try:
        job = await wiki.check_recognition_again(material)
        await wiki.jobs.wait(job.id)
        assert ingest.job(job.id).state == "done", ingest.job(job.id).error
        assert len(other.turns) == 1 and len(codex.turns) == 1
        # The actual recognition engine is gated before dispatch, even though the wiki is Codex.
        held = ingest.jobs.create(None, kind="recheck", profile=ingest.profile())
        ingest.jobs.pause(held.id, EngineLimited("claude_code", None))
        again = await wiki.check_recognition_again(material)
        await wiki.jobs.wait(again.id)
        pause = ingest.job(again.id).engine_pause
        assert ingest.job(again.id).state == "paused" and pause is not None
        assert pause.engine == "claude_code" and len(other.turns) == 1
    finally:
        await wiki.jobs.close()
        await ingest.close()


@pytest.mark.parametrize("kind", ["connections", "folder_overview"])
async def test_quota_resumes_serialize_the_same_wiki_work(
    ready: KnowledgeService, kind: JobKind,
) -> None:
    clock = Clock()
    ingest, _, _ = await limited(ready, clock, clock.now + timedelta(hours=1), count=1)
    wiki = WikiService(ready, ingest)
    active = peak = calls = 0
    entered = asyncio.Event()
    release = asyncio.Event()

    async def work(_: JobContext) -> None:
        nonlocal active, peak, calls
        active += 1
        peak = max(peak, active)
        calls += 1
        entered.set()
        try:
            await release.wait()
        finally:
            active -= 1

    try:
        # Production starts can accumulate multiple paused closures while the gate is held.
        jobs = [await wiki.jobs.start(kind, "folder" if kind == "folder_overview" else None,
                                      "finding_connections", work) for _ in range(2)]
        for job in jobs:
            await wiki.jobs.wait(job.id)
            assert ingest.job(job.id).state == "paused"
        clock.advance(3600)
        await drain(ingest)
        await asyncio.wait_for(entered.wait(), 5)
        release.set()
        for job in jobs:
            await wiki.jobs.wait(job.id)
        assert calls == 2 and peak == 1
        assert all(ingest.job(job.id).state == "done" for job in jobs)
    finally:
        release.set()
        await wiki.jobs.close()
        await ingest.close()


async def test_wall_clock_deadline_is_rechecked_within_a_minute_and_on_poll(ready: KnowledgeService) -> None:
    clock = Clock()
    ingest, _, jobs = await limited(ready, clock, clock.now + timedelta(days=3))
    try:
        pending = [alarm for alarm in clock.alarms if not alarm.cancelled]
        assert pending and (pending[-1].at - clock.now).total_seconds() <= 60
        # Wall time moved during sleep; the monotonic alarm hasn't fired at all.
        clock.now += timedelta(days=4)
        ingest.list_jobs()
        await asyncio.sleep(0)  # deliver the thread-safe polling kick
        await drain(ingest)
        assert all(ingest.job(job.id).state == "done" for job in jobs)
    finally:
        await ingest.close()


async def test_failed_continue_leaves_profiles_gates_and_other_jobs_untouched(
    ready: KnowledgeService,
) -> None:
    clock = Clock()
    ingest, engine, jobs = await limited(ready, clock, None)
    ingest.slots = lambda: 0  # type: ignore[method-assign]
    orphan = ingest.jobs.create("page", kind="recheck", profile=ingest.profile())
    ingest.jobs.pause(orphan.id, EngineLimited("codex", None))
    ingest.update_settings(engine="codex", model="fake-model")
    try:
        with pytest.raises(IngestBusy, match="Start it again"):
            await ingest.continue_job(orphan.id)
        assert "codex" in ingest.jobs.engine_pauses()
        assert ingest.job(orphan.id).execution == orphan.execution
        assert [ingest.job(job.id).state for job in jobs] == ["paused", "queued"]
        assert len(engine.turns) == 1
    finally:
        await ingest.close()


async def test_restart_interrupts_unrestorable_corrections_and_material_can_be_queued_again(
    ready: KnowledgeService,
) -> None:
    clock = Clock()
    ingest, engine, jobs = await limited(ready, clock, clock.now + timedelta(hours=1), count=1)
    material = jobs[0].material_id
    assert material is not None
    orphan = ingest.jobs.create(material, kind="corrections", profile=ingest.profile())
    ingest.jobs.pause(orphan.id, EngineLimited("codex", clock.now + timedelta(hours=1)))
    await ingest.close()
    restarted = service(ready, engine, clock)
    try:
        stopped = restarted.job(orphan.id)
        assert stopped.state == "interrupted" and stopped.engine_pause is None
        assert stopped.error_code is None and "Start it again" in (stopped.error or "")
        # Remove the old ingest pause, leaving the interrupted corrections as the latest row.
        await restarted.cancel(jobs[0].id)
        queued = await restarted.request_from_user(material)
        assert queued.id != orphan.id and queued.kind == "ingest" and queued.state == "queued"
    finally:
        await restarted.close()


async def test_bad_follow_up_does_not_block_queued_work_or_the_next_alarm(
    ready: KnowledgeService, caplog: pytest.LogCaptureFixture,
) -> None:
    clock = Clock()
    ingest, _, jobs = await limited(ready, clock, clock.now + timedelta(hours=1))
    scope = ingest.job(jobs[0].id).execution
    assert scope is not None
    bad = ingest.jobs.create(None, kind="connections", profile=scope.profile,
                             root_job_id=scope.root_job_id, budget_material=jobs[0].material_id)
    ingest.jobs.pause(bad.id, EngineLimited("codex", clock.now + timedelta(hours=1)))
    # A second engine's timer must still be armed after the broken row is skipped.
    held = ingest.jobs.create(None, kind="recheck", profile=scope.profile)
    ingest.jobs.pause(held.id, EngineLimited("hermes", clock.now + timedelta(days=1)))

    async def broken(_: str, _kinds: Any) -> Any:
        raise RuntimeError("PRIVATE provider/material text")

    ingest.continue_follow_ups = broken
    try:
        clock.advance(3600)
        await drain(ingest)
        assert all(ingest.job(job.id).state == "done" for job in jobs)
        assert any(not alarm.cancelled for alarm in clock.alarms)
        assert "PRIVATE" not in caplog.text
    finally:
        await ingest.close()


async def test_default_model_pause_honestly_explains_restart_and_how_to_keep_parts(
    ready: KnowledgeService,
) -> None:
    ingest, _, jobs = await limited(ready, Clock(), None, count=1)
    try:
        error = ingest.job(jobs[0].id).error or ""
        assert "Continue starts this material over" in error
        assert "choose a wiki model in Settings → Models" in error
        assert "finished work is kept" not in error
    finally:
        await ingest.close()
