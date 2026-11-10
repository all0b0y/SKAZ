"""Slice B2 in the real app: ``runtime.kb_jobs`` / ``runtime.kb_explore`` and the explore routes."""

from __future__ import annotations

from typing import Any

import httpx

from skaz.knowledge.api.schemas_explore_common import KbRunBudget
from skaz.knowledge.explore.jobs import SqliteJobStore
from skaz.knowledge.explore.service import ExploreFunnel


async def test_runtime_exposes_the_job_store_and_routes_go_live_with_a_library(
    kb_app: Any, kb_client: httpx.AsyncClient
) -> None:
    runtime = kb_app.state.runtime
    assert isinstance(runtime.kb_jobs, SqliteJobStore)
    assert isinstance(runtime.kb_explore, ExploreFunnel)
    assert runtime.kb_explore.job_store is runtime.kb_jobs
    # No library yet: every route of the slice is not_ready (as B4/B5).
    response = await kb_client.get("/kb/explore/jobs")
    assert (response.status_code, response.json()) == (503, {"code": "not_ready"})

    runtime.kb.connect(None)
    budget = KbRunBudget(unit="link", limit=100, used=0, remaining=100, total_used=0, batch=1, free_only=True)
    links = runtime.kb_jobs.create("links", "Check links", "links", budget)
    response = await kb_client.get("/kb/explore/jobs")
    assert response.status_code == 200
    assert [(job["id"], job["owner"], job["title"]) for job in response.json()["jobs"]] == [
        (links.id, "links", "Check links")
    ]
    response = await kb_client.get("/kb/explore/findings")
    assert response.status_code == 200
    assert response.json()["groups"] == [] and response.json()["covered_count"] == 0
    assert (await kb_client.get("/kb/explore/exploring")).json() == {"items": []}
    missing = await kb_client.get("/kb/explore/findings/finding-missing")
    assert (missing.status_code, missing.json()) == (404, {"code": "not_found"})
    # B1's science client isn't wired yet: a run can't start, and nothing is created.
    response = await kb_client.post("/kb/explore/runs", json={"query": "agents"})
    assert (response.status_code, response.json()) == (503, {"code": "not_ready"})
    assert [job.id for job in runtime.kb_jobs.active()] == [links.id]


async def test_a_running_job_from_the_last_process_is_paused_at_start(kb_app: Any) -> None:
    from skaz.runtime import Runtime

    runtime = kb_app.state.runtime
    budget = KbRunBudget(unit="link", limit=100, used=0, remaining=100, total_used=0, batch=1, free_only=True)
    job = runtime.kb_jobs.create("links", "Check links", "links", budget)
    restarted = Runtime(runtime.config)
    try:
        after = restarted.kb_jobs.get(job.id)
        assert after is not None
        assert (after.state, after.stop_reason) == ("paused", "app_exit")
    finally:
        restarted.close()
