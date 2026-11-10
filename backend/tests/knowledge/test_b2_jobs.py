"""Slice B2: ``SqliteJobStore``, the only writer of ``explore_jobs`` and its checkpoints."""

from __future__ import annotations

import pytest

from skaz.knowledge.api.schemas_explore_common import KbRunBudget, KbRunCounters
from skaz.knowledge.errors import KnowledgeError
from skaz.knowledge.explore.jobs import SqliteJobStore
from skaz.knowledge.explore.protocols import JobStore
from skaz.knowledge.store.database import KnowledgeDatabase


def _budget(
    used: int = 0, *, batch: int = 1, total: int | None = None, unit: str = "candidate"
) -> KbRunBudget:
    limit = 30 if unit == "candidate" else 100
    return KbRunBudget.model_validate(
        {
            "unit": unit,
            "limit": limit,
            "used": used,
            "remaining": limit - used,
            "total_used": used if total is None else total,
            "batch": batch,
            "free_only": False,
        }
    )


def _counters(checked: int = 0) -> KbRunCounters:
    return KbRunCounters(
        checked=checked, after_rules=0, decided=0, on_topic=0, novelty_checked=0, new=0, covered=0
    )


@pytest.fixture
def store() -> SqliteJobStore:
    return SqliteJobStore(KnowledgeDatabase(":memory:"))


def test_is_a_job_store(store: SqliteJobStore) -> None:
    assert isinstance(store, object)
    typed: JobStore = store  # mypy checks the structural match
    assert typed is store


def test_create_get_and_progress(store: SqliteJobStore) -> None:
    job = store.create("explore", "Find what's new", "collect", _budget())
    assert job.state == "running"
    assert job.owner == "explore"
    assert job.stop_reason is None
    assert job.checkpoint is None
    assert job.decision_choices == []
    assert store.get(job.id) == job
    assert store.title(job.id) == "Find what's new"
    moved = store.progress(job.id, stage="rules", budget=_budget(3), counters=_counters(12))
    assert moved.stage == "rules"
    assert moved.budget.used == 3
    assert moved.counters.checked == 12
    assert store.get("missing") is None


def test_stop_maps_reasons_to_states_and_keeps_a_checkpoint_to_continue(store: SqliteJobStore) -> None:
    job = store.create("links", "Check links", "links", _budget(unit="link"))
    paused = store.stop(job.id, "budget")
    assert (paused.state, paused.stop_reason) == ("paused", "budget")
    # A paused job can always be continued: a checkpoint exists even if the caller saved none.
    assert paused.checkpoint is not None and paused.checkpoint.revision == 1
    resumed = store.progress(
        job.id, stage="links", budget=_budget(unit="link", batch=2), counters=_counters()
    )
    assert (resumed.state, resumed.stop_reason) == ("running", None)
    assert store.stop(job.id, "completed").state == "done"
    assert store.get(job.id).checkpoint is None  # type: ignore[union-attr]
    for reason, state in (
        ("cancelled", "cancelled"),
        ("failed", "error"),
        ("user_pause", "paused"),
        ("app_exit", "paused"),
        ("openalex_daily_limit", "paused"),
        ("science_consent_required", "paused"),
        ("provider_unavailable", "paused"),
    ):
        other = store.create("explore", "x", "collect", _budget())
        assert store.stop(other.id, reason).state == state  # type: ignore[arg-type]


def test_decision_required_offers_both_choices_and_retry_at_is_kept(store: SqliteJobStore) -> None:
    job = store.create("explore", "x", "decision", _budget())
    stopped = store.stop(job.id, "decision_model_required")
    assert stopped.decision_choices == ["download_local", "openrouter_jev"]
    limited = store.stop(
        store.create("explore", "y", "collect", _budget()).id,
        "openalex_daily_limit",
        retry_at="2026-11-11T00:00:00Z",
    )
    assert limited.retry_at is not None and limited.retry_at.day == 11
    assert (
        store.progress(job.id, stage="decision", budget=_budget(), counters=_counters()).decision_choices
        == []
    )


def test_checkpoints_get_new_revisions(store: SqliteJobStore) -> None:
    job = store.create("explore", "x", "novelty", _budget())
    first = store.checkpoint(job.id, stage="novelty", cursor="w2", completed_ids=["w1"], pending_ids=["w2"])
    second = store.checkpoint(
        job.id, stage="novelty", cursor=None, completed_ids=["w1", "w2"], pending_ids=[]
    )
    assert (first.revision, second.revision) == (1, 2)
    assert first.id != second.id
    paused = store.stop(job.id, "user_pause")
    assert paused.checkpoint == second


def test_completed_work_is_unique_and_listed_per_stage(store: SqliteJobStore) -> None:
    job = store.create("explore", "x", "novelty", _budget())
    store.complete(job.id, "w1", "novelty", '{"label": "new"}')
    store.complete(job.id, "w1", "rules", '{"kept": true}')
    with pytest.raises(KnowledgeError) as caught:
        store.complete(job.id, "w1", "novelty", "{}")
    assert caught.value.status_code == 409
    assert set(store.completed(job.id, "novelty")) == {"w1"}
    assert store.result(job.id, "w1", "rules") == '{"kept": true}'
    with pytest.raises(KnowledgeError):
        store.complete(job.id, "w2", "novelty", "not json")


def test_active_lists_unfinished_jobs_of_every_owner(store: SqliteJobStore) -> None:
    a = store.create("explore", "a", "collect", _budget())
    b = store.create("links", "b", "links", _budget(unit="link"))
    c = store.create("repeats", "c", "repeats", _budget(unit="claim_comparison"))
    store.stop(b.id, "user_pause")
    store.stop(c.id, "completed")
    assert {job.id for job in store.active()} == {a.id, b.id}
    assert {job.id for job in store.recent(limit=10)} == {a.id, b.id, c.id}


def test_recover_pauses_running_jobs_with_app_exit(store: SqliteJobStore) -> None:
    running = store.create("explore", "a", "novelty", _budget(4))
    store.checkpoint(running.id, stage="novelty", cursor="w5", completed_ids=["w1"], pending_ids=["w5"])
    paused = store.create("links", "b", "links", _budget(unit="link"))
    store.stop(paused.id, "user_pause")
    assert store.recover() == [running.id]
    after = store.get(running.id)
    assert after is not None
    assert (after.state, after.stop_reason) == ("paused", "app_exit")
    # A fresh revision: a Continue sent with a card seen before the crash is stale.
    assert after.checkpoint is not None and after.checkpoint.revision == 2
    assert after.checkpoint.pending_ids == ["w5"]
    assert store.get(paused.id).stop_reason == "user_pause"  # type: ignore[union-attr]
    assert store.recover() == []


def test_unknown_job_is_not_found(store: SqliteJobStore) -> None:
    with pytest.raises(KnowledgeError) as caught:
        store.stop("missing", "completed")
    assert caught.value.status_code == 404
