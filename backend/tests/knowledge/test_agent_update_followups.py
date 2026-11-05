"""FIX-1 F3.10: wiki follow-up jobs (folder overview, connections, recheck) hold their agent for the whole
job, like a wiki build (``update_gate.holding``): an agent update never lands between two of their steps.
"""
from __future__ import annotations

from typing import Any

import pytest

from skaz.knowledge.agents.update_gate import UpdateGate, guard
from skaz.knowledge.service import KnowledgeService

from .wiki_support import two_sources


class _Stop(Exception):
    pass


@pytest.mark.parametrize("kind", ["overview", "connections", "recheck"])
async def test_wiki_follow_up_jobs_hold_their_agent_for_the_whole_job(ready: KnowledgeService,
                                                                     kind: str) -> None:
    case = await two_sources(ready, conflict=False)
    service = case.service
    engine = case.wiki.engine
    gate = UpdateGate()
    guard(engine, gate)
    held: list[bool] = []

    async def first_step(*_: Any, **__: Any) -> Any:
        held.append(gate.busy(engine.id))  # before any agent run of the job
        raise _Stop()

    if kind == "overview":
        service.overviews.write = first_step  # type: ignore[method-assign]
        folder = next(folder for folder in ready.folders() if folder.name == "Физика")
        job = await service.write_overview(folder.id)
    elif kind == "connections":
        service.discrepancies.check_pages = first_step  # type: ignore[method-assign]
        job = await service.find_connections()
    else:
        def unchecked_target(*_: Any, **__: Any) -> Any:
            return None
        service.rechecks.target = unchecked_target  # type: ignore[method-assign]
        service.rechecks.run = first_step  # type: ignore[method-assign]
        job = await service.recheck("page", "block")
    await service.jobs.wait(job.id)
    assert held == [True]
    assert not gate.busy(engine.id)  # released when the job ended
