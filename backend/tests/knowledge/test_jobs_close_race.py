"""A job request that races shutdown starts nothing.

``close()`` stops the tasks it can see. A request that was on a worker thread
(writing its job row) when ``close()`` ran had no task yet; before this fix it
created one afterwards, which outlived the service and hung the event loop's
shutdown. Now such a job ends ``interrupted`` and nothing starts.
"""
from __future__ import annotations

import asyncio
import threading
from typing import Any

import pytest

from skaz.knowledge.ingest.jobs import JobRepository
from skaz.knowledge.service import KnowledgeService
from skaz.knowledge.wiki.jobs import WikiBusy, WikiJobs


async def test_a_wiki_job_requested_while_closing_starts_nothing(
    ready: KnowledgeService, monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo = JobRepository(ready.db)
    wiki_jobs = WikiJobs(repo)
    loop = asyncio.get_running_loop()
    create = repo.create
    closing: list[asyncio.Task[None]] = []
    closed = threading.Event()
    ran: list[str] = []

    def start_closing() -> None:
        closing.append(loop.create_task(wiki_jobs.close()))
        loop.call_soon(closed.set)

    def create_while_closing(*args: Any, **kwargs: Any) -> Any:
        loop.call_soon_threadsafe(start_closing)
        assert closed.wait(5)
        return create(*args, **kwargs)

    async def work(_context: Any) -> None:
        ran.append("work")

    monkeypatch.setattr(repo, "create", create_while_closing)
    with pytest.raises(WikiBusy):
        await wiki_jobs.start("recheck", None, "reading", work)
    await asyncio.gather(*closing)
    await asyncio.sleep(0)
    assert ran == []
    assert not [task for task in asyncio.all_tasks() if task.get_name().startswith("wiki-")]
    assert [job.state for job in repo.list_all()] == ["interrupted"]


async def test_a_wiki_job_whose_agent_is_signed_out_says_so_in_its_code(ready: KnowledgeService) -> None:
    """G4: a refresh/recheck that failed on sign-in carries ``AGENT_UNAVAILABLE``; other failures don't."""
    from skaz.knowledge.agents.engine import Failed, FailureKind
    from skaz.knowledge.agents.fake import FakeEngine
    from skaz.knowledge.ingest.jobs import AGENT_UNAVAILABLE
    from skaz.knowledge.wiki.agent import AgentCaller

    repo = JobRepository(ready.db)
    wiki_jobs = WikiJobs(repo)
    outcomes: dict[FailureKind, str | None] = {"auth": AGENT_UNAVAILABLE, "network": None}
    for kind, code in outcomes.items():
        caller = AgentCaller(FakeEngine("codex", script=[Failed("", kind, "Sign in to Codex.")]), f"t-{kind}",
                             retry_delays_s=(0.0,))  # "network" may have been sent: retried once

        async def work(_context: Any, caller: AgentCaller = caller) -> None:
            await caller.ask("", [], {})

        job = await wiki_jobs.start("refresh", "mat-1", "reading", work)
        await wiki_jobs.wait(job.id)
        record = repo.get(job.id)
        assert record is not None and record.state == "failed" and record.error_code == code, kind
