"""Review 0.3.1 (C-14): Continue of a material's paused follow-ups while a connection run is going
waits for it (like the follow-ups of a new source) instead of answering 409."""
from __future__ import annotations

import asyncio

from skaz.knowledge.service import KnowledgeService
from skaz.knowledge.wiring import follow_up_continuer
from tests.knowledge.test_wiki_connection_batches import (
    TEMPERATURE,
    connection_jobs,
    ids,
    lecture,
)
from tests.knowledge.wiki_support import settle_wiki


async def test_continue_while_connections_run_starts_each_follow_up_and_waits_for_the_run(
        ready: KnowledgeService) -> None:
    wiki, ingest, service, material = await lecture(ready)
    # The pairs become stale, so a whole-wiki run asks the agent and is held there.
    page = ids(ready)[TEMPERATURE]
    statement = next(item for item in ready.page(page).entries if item.kind == "from_source")
    service.update_block(page, statement.id, "Температура показывает среднюю энергию частиц.")
    wiki.hold = asyncio.Event()
    running = await service.find_connections(None)
    await asyncio.sleep(0.05)
    assert service.jobs.running("connections")
    folder_jobs = len([job for job in ingest.list_jobs() if job.kind == "folder_overview"])
    runs = len(connection_jobs(ingest))

    record = await follow_up_continuer(service)(material, ["folder_overview", "connections"])

    assert record is not None and record.kind == "connections"
    assert len([job for job in ingest.list_jobs() if job.kind == "folder_overview"]) == folder_jobs + 1
    wiki.hold.set()
    await service.jobs.wait(running.id)
    await settle_wiki(service, ingest)
    assert len(connection_jobs(ingest)) == runs + 1  # the material's own run followed the held one
    latest = connection_jobs(ingest)[0]
    assert latest.id != running.id and latest.state == "done", latest.error
