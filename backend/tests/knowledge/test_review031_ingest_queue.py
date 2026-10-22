"""Review 0.3.1 (C-01..C-03): the ingest queue under quit and Stop races.

The engine is ``FakeEngine`` at the external seam; ``interrupt`` that yields models a real
engine's round trip (Codex ``turn/interrupt``, OpenCode ``notify``).
"""
from __future__ import annotations

import asyncio
import threading
from typing import Any

import pytest

from skaz.knowledge.ingest.execution import stored_scope
from skaz.knowledge.ingest.jobs import JobRepository
from skaz.knowledge.ingest.service import IngestService
from skaz.knowledge.service import KnowledgeService
from skaz.knowledge.wiki.jobs import JobContext, WikiJobs
from tests.knowledge.ingest_support import (
    PatternDetector,
    ScriptedWiki,
    add_material,
    block,
    cite,
    notes,
    settle,
    wait_finished,
)

NOTES_OK = notes(("Энтропия", [block("from_source", "Энтропия определяется как мера беспорядка системы.",
                                     cite(1, "мера беспорядка системы"))]))


def service_for(kb: KnowledgeService, wiki: ScriptedWiki) -> IngestService:
    return IngestService(kb, engines=lambda _engine_id: wiki.engine, detector=PatternDetector())


async def test_close_requeues_a_running_job_when_the_engine_interrupt_awaits(ready: KnowledgeService) -> None:
    """C-01: the engine's stream says "cancelled" while ``interrupt`` still awaits its reply."""
    material_id = add_material(ready, "Физика", "Лекция 8")
    wiki = ScriptedWiki(notes=[NOTES_OK], gate=asyncio.Event())
    interrupt = wiki.engine.interrupt

    async def round_trip(run_id: str) -> None:
        await interrupt(run_id)
        await asyncio.sleep(0.05)

    wiki.engine.interrupt = round_trip  # type: ignore[method-assign]
    ingest = service_for(ready, wiki)
    job = await ingest.request_ingest(material_id)
    await settle(lambda: bool(wiki.engine.active_runs()))
    await ingest.close()
    record = ingest.job(job.id)
    assert (record.state, record.error) == ("queued", None)


async def test_stop_while_the_job_reads_its_snapshot_finishes_it(ready: KnowledgeService,
                                                                 monkeypatch: pytest.MonkeyPatch) -> None:
    """C-02: Stop in the job's first moments never leaves it running and the material busy."""
    material_id = add_material(ready, "Физика", "Лекция 8")
    wiki = ScriptedWiki(notes=[NOTES_OK])
    ingest = service_for(ready, wiki)
    entered, release = threading.Event(), threading.Event()
    real = stored_scope

    def slow_scope(*args: Any) -> Any:
        entered.set()
        assert release.wait(5)
        return real(*args)

    monkeypatch.setattr("skaz.knowledge.ingest.service.stored_scope", slow_scope)
    job = await ingest.request_ingest(material_id)
    await settle(entered.is_set)
    stopping = asyncio.create_task(ingest.cancel(job.id))
    await asyncio.sleep(0.05)
    release.set()
    record = await asyncio.wait_for(stopping, 5)
    assert record.state == "cancelled"
    assert ingest.active_jobs() == set()
    monkeypatch.setattr("skaz.knowledge.ingest.service.stored_scope", real)
    again = await ingest.request_ingest(material_id)  # the material isn't left busy
    assert (await wait_finished(ingest, again.id)).state == "done"


async def test_stop_of_a_queued_job_that_the_queue_claims_meanwhile_stops_it(
        ready: KnowledgeService, monkeypatch: pytest.MonkeyPatch) -> None:
    """C-03: the queue claims the job between Stop's read and its write: the job doesn't run on."""
    material_id = add_material(ready, "Физика", "Лекция 8")
    wiki = ScriptedWiki(notes=[NOTES_OK])
    ingest = service_for(ready, wiki)
    slots = [0]
    monkeypatch.setattr(ingest, "slots", lambda: slots[0])
    job = await ingest.request_ingest(material_id)
    assert job.state == "queued"
    loop = asyncio.get_running_loop()
    claimed, handed_over = threading.Event(), threading.Event()
    claim_next = ingest.jobs.claim_next

    def claim() -> Any:
        found = claim_next()  # committed: the job is "running" in the database …
        claimed.set()
        assert handed_over.wait(5)  # … but the queue has no task for it yet when Stop looks
        return found

    monkeypatch.setattr(ingest.jobs, "claim_next", claim)
    read = ingest.job

    def stale_read(job_id: str) -> Any:
        record = read(job_id)  # "queued" — then a slot frees and the queue claims it
        monkeypatch.setattr(ingest, "job", read)
        slots[0] = 1
        loop.call_soon_threadsafe(ingest._kick)
        assert claimed.wait(5)
        loop.call_soon_threadsafe(loop.call_later, 0.1, handed_over.set)
        return record

    monkeypatch.setattr(ingest, "job", stale_read)
    record = await ingest.cancel(job.id)
    await settle(handed_over.is_set)
    pump = ingest._pump_task  # the queue hands the claimed job over, and it settles
    assert pump is not None
    await asyncio.wait_for(asyncio.shield(pump), 5)
    await settle(lambda: not ingest.active_jobs())
    assert wiki.engine.turns == []
    record = ingest.job(job.id)
    assert record.state == "cancelled"
    assert not (ready.library_root / "Wiki" / "Notes" / "Лекция 8.md").exists()


async def test_closing_while_a_wiki_job_reads_its_snapshot_finishes_it(
        ready: KnowledgeService, monkeypatch: pytest.MonkeyPatch) -> None:
    """C-02 (wiki jobs): a cancel at the snapshot read never leaves the job running and counted."""
    jobs = WikiJobs(JobRepository(ready.db))
    entered, release = threading.Event(), threading.Event()
    real = stored_scope

    def slow_scope(*args: Any) -> Any:
        entered.set()
        assert release.wait(5)
        return real(*args)

    async def work(_context: JobContext) -> None:
        raise AssertionError("never reached")

    monkeypatch.setattr("skaz.knowledge.wiki.jobs.stored_scope", slow_scope)
    job = await jobs.start("connections", None, "finding_connections", work)
    await settle(entered.is_set)
    closing = asyncio.create_task(jobs.close())
    await asyncio.sleep(0.05)
    release.set()
    await asyncio.wait_for(closing, 5)
    assert not jobs.running("connections")
    record = jobs.jobs.get(job.id)
    assert record is not None and record.state == "interrupted"
