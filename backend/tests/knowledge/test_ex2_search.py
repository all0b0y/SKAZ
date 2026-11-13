"""EX2 X2: own-topic plans, card-scoped decisions, and the visible funnel; fixtures only."""

from __future__ import annotations

import json
from collections.abc import Sequence
from types import SimpleNamespace
from typing import Any

import pytest

from skaz.knowledge.api.contract_routes import ContractFailure
from skaz.knowledge.api.schemas_explore import KbFunnelStart, KbSearchPlanItem, KbSearchPlanRequest
from skaz.knowledge.decisions.protocol import ChoiceAnswer, ChoiceQuestion
from skaz.knowledge.errors import KnowledgeError
from tests.knowledge.test_b2_funnel import (
    FakeLayer,
    run_to_end,
    work,
)
from tests.knowledge.test_b2_funnel import (
    parts as parts,
)


def topic(
    p: SimpleNamespace,
    area_id: str,
    name: str,
    *,
    parent: str | None = None,
    count: int = 0,
    hidden_ids: Sequence[str] = (),
) -> None:
    with p.kb.db.write() as db:
        db.execute(
            "INSERT INTO explore_areas(id,parent_id,level,name,original_name,mapping_state,mapped_name)"
            " VALUES (?,?,'custom',?,?,'mapped',?)",
            (area_id, parent, name, name, name),
        )
        db.executemany("INSERT INTO explore_area_topics VALUES (?,?)", [(area_id, t) for t in hidden_ids])
        folder = p.kb.folders()[0].id
        for n in range(count):
            mid = f"{area_id}-material-{n}"
            db.execute(
                "INSERT INTO materials(id,folder_id,kind,status,title,rel_dir,source_file,created_at)"
                " VALUES (?,?,'web','ready',?,?,'source.md','2026-11-10')",
                (mid, folder, mid, mid),
            )
            db.execute("INSERT INTO explore_area_materials VALUES (?,?,'agent','now')", (mid, area_id))
    p.directory.paths[area_id] = ([p.directory.paths[parent][-1]] if parent else []) + [name]
    p.directory.area_topics[area_id] = list(hidden_ids)


def concept(p: SimpleNamespace, area_id: str, title: str, n: int, *, kind: str = "concept") -> None:
    with p.kb.db.write() as db:
        db.execute(
            "INSERT INTO pages(id,kind,title,rel_path,language,file_sha256,indexed_at)"
            " VALUES (?,?,?,?,'en','fixture','now')",
            (f"p-{n}", kind, title, f"Wiki/{n}.md"),
        )
        db.execute("INSERT INTO page_sources VALUES (?,?)", (f"p-{n}", f"{area_id}-material-0"))


async def test_all_topics_real_library_shape_is_local_bounded_and_nonempty(parts: SimpleNamespace) -> None:
    # 93 ordinary web materials, 1124 concepts: no paper DOIs, no taxonomy roots.
    topic(parts, "topic-agents", "AI agents", count=30)
    topic(parts, "topic-ml", "Machine learning", count=25)
    topic(parts, "topic-comms", "Business communication", count=10)
    for n in range(7):
        topic(parts, f"topic-small-{n}", f"Small topic {n}", count=4)
    for n in range(1124):
        concept(parts, "topic-agents", "Agent memory" if n % 2 else "Tool use", n)
    plan = await parts.funnel.plan(KbSearchPlanRequest(all_topics=True))
    assert plan.ready and plan.reason is None
    assert len(plan.items) == 8
    assert [i.area_id for i in plan.items[:3]] == ["topic-agents", "topic-ml", "topic-comms"]
    assert plan.items[0].terms == ["AI agents", "Agent memory", "Tool use"]
    assert parts.science.calls == [] and parts.deciders.layer().asked == 0
    parts.science.search_works = [work(1)]
    run = await run_to_end(parts, KbFunnelStart(all_topics=True, channels=["search"]))
    assert run.state == "done" and run.counters.checked == 1
    assert len([1 for name, _ in parts.science.calls if name == "search"]) == 8
    assert run.plan == plan.items


async def test_subtopic_query_is_precise_and_only_hidden_ids_are_added(parts: SimpleNamespace) -> None:
    topic(parts, "topic-ai", "AI", count=1, hidden_ids=["T1"])
    topic(parts, "topic-agents", "AI agents", parent="topic-ai", count=1, hidden_ids=["T2"])
    concept(parts, "topic-agents", "Agent memory", 1)
    preview = await parts.funnel.plan(KbSearchPlanRequest(area_id="topic-agents", query="harness"))
    assert preview.items == [KbSearchPlanItem(area_id="topic-agents", label="AI agents", terms=["harness"])]
    run = await run_to_end(parts, KbFunnelStart(area_id="topic-agents", query="harness", channels=["search"]))
    (sent,) = [body for name, body in parts.science.calls if name == "search"]
    assert sent.payload.topics == ["harness", "T2"]
    assert run.plan == preview.items
    plain = await parts.funnel.plan(KbSearchPlanRequest(query="harness"))
    assert plain.items[0].area_id is None and plain.items[0].terms == ["harness"]


async def test_unmapped_topic_searches_its_name_and_concepts_without_taxonomy(parts: SimpleNamespace) -> None:
    topic(parts, "topic-comms", "Business communication", count=2)
    concept(parts, "topic-comms", "Negotiation", 1)
    concept(parts, "topic-comms", "Private notes body", 2, kind="note")
    run = await run_to_end(parts, KbFunnelStart(area_id="topic-comms", channels=["search"]))
    (sent,) = [body for name, body in parts.science.calls if name == "search"]
    assert sent.payload.topics == ["Business communication", "Negotiation"]
    assert run.state == "done"


@pytest.mark.parametrize("scope", [KbSearchPlanRequest(), KbSearchPlanRequest(all_topics=True)])
async def test_empty_scope_reports_reason_and_cannot_create_a_run(
    parts: SimpleNamespace,
    scope: KbSearchPlanRequest,
) -> None:
    plan = await parts.funnel.plan(scope)
    assert not plan.ready and plan.reason and plan.items == []
    with pytest.raises(ContractFailure) as caught:
        await parts.funnel.start(KbFunnelStart(**scope.model_dump()))
    assert caught.value.status == 422
    assert parts.jobs.active() == [] and parts.science.calls == []


async def test_edited_plan_is_authoritative_and_empty_items_are_rejected(parts: SimpleNamespace) -> None:
    topic(parts, "topic-ai", "AI", count=1)
    topic(parts, "topic-ml", "ML", count=1)
    plan = [KbSearchPlanItem(area_id="topic-ai", label="AI", terms=["Agent safety"])]
    run = await run_to_end(
        parts, KbFunnelStart(all_topics=True, query="ignored", plan=plan, channels=["search"])
    )
    assert run.plan == plan
    (sent,) = [body for name, body in parts.science.calls if name == "search"]
    assert sent.payload.topics == ["Agent safety"]
    for invalid in (
        [],
        [KbSearchPlanItem(area_id=None, label="empty", terms=[])],
        [KbSearchPlanItem(area_id=None, label="blank", terms=["   "])],
    ):
        with pytest.raises(ContractFailure):
            await parts.funnel.start(KbFunnelStart(plan=invalid))


class CardLayer(FakeLayer):
    def __init__(self) -> None:
        super().__init__("local", set())
        self.questions: list[ChoiceQuestion] = []

    async def ask_many(self, questions: Sequence[ChoiceQuestion]) -> list[Any]:
        self.questions.extend(questions)
        return [
            ChoiceAnswer(option=q.options[0], probabilities={q.options[0]: 0.9}, confidence=0.9)
            for q in questions
        ]


async def test_explicit_search_plan_uses_russian_topics_not_own_library(parts: SimpleNamespace) -> None:
    topic(parts, "topic-comms", "Business communication", count=1)
    card = [KbSearchPlanItem(area_id=None, label="Память агентов", terms=["Память агентов", "harness"])]
    layer = CardLayer()
    parts.deciders._layer = layer
    parts.science.search_works = [work(n, title=f"Agent memory {n}") for n in range(50)]
    started = await parts.funnel.start(KbFunnelStart(plan=card))
    run = await parts.funnel.settled(started.id)
    assert (run.counters.checked, run.counters.on_topic, run.counters.new) == (50, 50, 30)
    assert run.stop_reason == "budget"
    for q in layer.questions:
        assert "Память агентов" in q.state and "harness" in q.state
        assert "Business communication" not in q.state + q.question + str(q.options)
        assert "areas of the user's library" not in q.question
    assert [body.payload.topics for name, body in parts.science.calls if name == "search"] == [card[0].terms]


async def test_changed_card_does_not_reuse_off_topic_forever(parts: SimpleNamespace) -> None:
    parts.science.search_works = [work(1, title="Off topic")]
    first = await run_to_end(parts, KbFunnelStart(query="communication", channels=["search"]))
    assert first.counters.on_topic == 0
    parts.deciders._layer = CardLayer()
    started = await parts.funnel.start(KbFunnelStart(query="agents"))
    changed = await parts.funnel.settled(started.id)
    assert changed.counters.on_topic == 1 and changed.counters.new == 1


async def test_funnel_lists_all_outcomes_with_reasons_pagination_and_overrides(
    parts: SimpleNamespace,
) -> None:
    parts.science.search_works = [
        work(1, title="Too old", year=2019),
        work(2, title="Off topic"),
        work(3, title="Known"),
        work(4, title="New"),
    ]
    parts.novelty.labels = {"Known": "covered"}
    run = await run_to_end(parts, KbFunnelStart(query="agents", channels=["search"]))
    page = await parts.funnel.candidates(run.id, limit=2)
    assert page.next_cursor is not None
    later = await parts.funnel.candidates(run.id, cursor=page.next_cursor, limit=2)
    assert later.next_cursor is None
    items = {i.candidate_id: i for i in [*page.items, *later.items]}
    assert {cid: i.outcome for cid, i in items.items()} == {
        "work-1": "dropped_by_rules",
        "work-2": "not_fit",
        "work-3": "covered",
        "work-4": "new",
    }
    assert all(i.reason for i in items.values())
    assert "date" in items["work-1"].reason.lower()
    (dropped,) = (await parts.funnel.candidates(run.id, outcome="not_fit")).items
    assert dropped.candidate_id == "work-2"
    before = list(parts.novelty.checked)
    override = await parts.funnel.mark_fits(run.id, "work-2")
    assert (override.outcome, override.overridden) == ("fits", True)
    assert parts.novelty.checked == before
    assert await parts.funnel.mark_fits(run.id, "work-2") == override  # idempotent
    assert "work-2" in await parts.funnel.waiting(run.id)
    assert (await parts.funnel.run(run.id)).counters.on_topic == run.counters.on_topic + 1
    # The explicit Check novelty click consumes the user's override rather than an old rejection.
    check = await run_to_end(parts, KbFunnelStart(candidate_ids=["work-2"]))
    assert check.counters.new == 1
    with pytest.raises(KnowledgeError):
        await parts.funnel.mark_fits("missing-run", "work-2")
    with pytest.raises(KnowledgeError):
        await parts.funnel.mark_fits(run.id, "other-work")
    with pytest.raises(ContractFailure):
        await parts.funnel.candidates(run.id, cursor="bad")


async def test_rule_override_preserves_original_reason_without_spending(parts: SimpleNamespace) -> None:
    parts.science.search_works = [work(1, year=2019)]
    run = await run_to_end(parts, KbFunnelStart(query="agents", channels=["search"]))
    override = await parts.funnel.mark_fits(run.id, "work-1")
    assert override.outcome == "fits" and override.overridden
    assert "work-1" in await parts.funnel.waiting(run.id)
    assert parts.novelty.checked == []
    with parts.kb.db.read() as db:
        original = json.loads(
            db.execute(
                "SELECT result_json FROM explore_completed_work"
                " WHERE job_id=? AND candidate_id='work-1' AND stage='rules'",
                (run.id,),
            ).fetchone()[0]
        )
    assert original["reason"] == "outside_dates"


async def test_precise_and_edited_scopes_never_resolve_unselected_library_sources(
    parts: SimpleNamespace,
) -> None:
    from tests.knowledge.test_b2_funnel import add_material

    add_material(parts.kb, "Unrelated paper", "https://doi.org/10.1000/unrelated")
    topic(parts, "topic-agents", "AI agents", count=1)
    await run_to_end(parts, KbFunnelStart(query="harness"))
    assert [name for name, _ in parts.science.calls] == ["search"]
    parts.science.calls.clear()
    await run_to_end(
        parts,
        KbFunnelStart(
            all_topics=True,
            plan=[KbSearchPlanItem(area_id="topic-agents", label="AI agents", terms=["Agent memory"])],
        ),
    )
    assert [name for name, _ in parts.science.calls] == ["search"]


async def test_renamed_or_pending_mapping_cannot_filter_with_stale_ids(parts: SimpleNamespace) -> None:
    topic(parts, "topic-agents", "AI agents", count=1, hidden_ids=["T1"])
    with parts.kb.db.write() as db:
        db.execute("UPDATE explore_areas SET name='Memory' WHERE id='topic-agents'")
    await run_to_end(parts, KbFunnelStart(area_id="topic-agents", channels=["search"]))
    (sent,) = [body for name, body in parts.science.calls if name == "search"]
    assert sent.payload.topics == ["Memory"]


async def test_long_precise_query_is_honest_instead_of_truncated(parts: SimpleNamespace) -> None:
    preview = await parts.funnel.plan(KbSearchPlanRequest(query="x" * 73))
    assert not preview.ready and "72" in preview.reason
    with pytest.raises(ContractFailure):
        await parts.funnel.start(KbFunnelStart(query="x" * 73))
    assert parts.science.calls == []


async def test_funnel_routes_use_the_contract_and_validate_inputs(parts: SimpleNamespace) -> None:
    import httpx
    from fastapi import FastAPI

    from skaz.knowledge.api.explore import router

    app = FastAPI()
    app.include_router(router)
    app.state.kb_explore = parts.funnel
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/kb/explore/plan", json={"query": "agents"})
        assert response.status_code == 200 and response.json()["items"][0]["terms"] == ["agents"]
        parts.science.search_works = [work(1, title="Off topic")]
        response = await client.post("/kb/explore/runs", json={"query": "agents", "channels": ["search"]})
        assert response.status_code == 200
        run_id = response.json()["id"]
        await parts.funnel.settled(run_id)
        base = f"/kb/explore/runs/{run_id}/candidates"
        response = await client.get(base, params={"outcome": "not_fit"})
        assert response.status_code == 200 and response.json()["items"][0]["outcome"] == "not_fit"
        response = await client.post(base + "/work-1/fits")
        assert response.status_code == 200 and response.json()["overridden"] is True
        assert parts.novelty.checked == []
        assert (await client.get(base, params={"outcome": "unknown"})).status_code == 422
        assert (await client.get(base, params={"cursor": "bad"})).status_code == 422
        assert (await client.post(base + "/missing/fits")).status_code == 404
        assert (await client.get("/kb/explore/runs/missing/candidates")).status_code == 404


async def test_legacy_run_without_a_plan_cannot_resume_as_empty_success(parts: SimpleNamespace) -> None:
    from skaz.knowledge.api.schemas_explore_common import KbContinue
    from skaz.knowledge.science.protocols import ScienceDailyLimit

    parts.science.error = ScienceDailyLimit()
    run = await run_to_end(parts, KbFunnelStart(query="agents", channels=["search"]))
    with parts.kb.db.write() as db:
        row = db.execute("SELECT request_json FROM explore_runs WHERE id=?", (run.id,)).fetchone()
        old_request = json.loads(row[0])
        old_request.pop("plan")
        old_request.pop("hidden_scopes")
        db.execute("UPDATE explore_runs SET request_json=? WHERE id=?", (json.dumps(old_request), run.id))
    parts.jobs.stop(run.id, "app_exit")
    parts.science.error = None
    before = list(parts.science.calls)
    assert await parts.funnel.on_start() == []
    paused = await parts.funnel.run(run.id)
    with pytest.raises(ContractFailure) as caught:
        await parts.funnel.resume(
            run.id, KbContinue(checkpoint_id=paused.checkpoint.id, revision=paused.checkpoint.revision)
        )
    assert (caught.value.status, caught.value.code) == (503, "not_ready")
    assert parts.science.calls == before


async def test_pause_keeps_plan_and_hidden_labels_and_skips_finished_search_items(
    parts: SimpleNamespace,
) -> None:
    from skaz.knowledge.api.schemas_explore_common import KbContinue
    from skaz.knowledge.science.protocols import ScienceDailyLimit
    from tests.knowledge.test_b2_funnel import results

    topic(parts, "topic-ai", "AI", count=1, hidden_ids=["T1"])
    topic(parts, "topic-ml", "ML", count=1, hidden_ids=["T2"])
    plan = [
        KbSearchPlanItem(area_id="topic-ai", label="AI", terms=["agents"]),
        KbSearchPlanItem(area_id="topic-ml", label="ML", terms=["learning"]),
    ]
    calls: list[list[str]] = []
    limited = True

    async def search(body: Any, *, run_id: str | None = None) -> Any:
        calls.append(body.payload.topics)
        if body.payload.topics[0] == "learning" and limited:
            raise ScienceDailyLimit()
        return results([])

    parts.science.search = search
    run = await run_to_end(parts, KbFunnelStart(plan=plan, channels=["search"]))
    assert run.stop_reason == "openalex_daily_limit"
    with parts.kb.db.write() as db:
        db.execute("UPDATE explore_areas SET name='Changed',mapping_state='pending'")
        db.execute("DELETE FROM explore_area_topics")
    limited = False
    await parts.funnel.resume(
        run.id, KbContinue(checkpoint_id=run.checkpoint.id, revision=run.checkpoint.revision)
    )
    done = await parts.funnel.settled(run.id)
    assert done.plan == plan and done.state == "done"
    assert calls == [["agents", "T1"], ["learning", "T2"], ["learning", "T2"]]


async def test_explicit_search_plan_keeps_requested_channels_inside_picked_topics(
    parts: SimpleNamespace,
) -> None:
    from tests.knowledge.test_b2_funnel import add_material

    chosen = add_material(parts.kb, "Chosen seed", "https://doi.org/10.1000/chosen")
    with parts.kb.db.write() as db:
        db.execute("INSERT INTO explore_area_materials VALUES (?,'area-ai','agent','now')", (chosen,))
    parts.science.resolved["10.1000/chosen"] = work(10, title="Chosen seed", doi="10.1000/chosen")
    parts.science.citing_works = [work(11, title="Cites chosen seed")]
    started = await parts.funnel.start(
        KbFunnelStart(
            plan=[KbSearchPlanItem(area_id="area-ai", label="AI", terms=["agents"])], channels=["continues"]
        ),
    )
    run = await parts.funnel.settled(started.id)
    assert run.counters.new == 1
    assert [name for name, _ in parts.science.calls] == ["resolve", "citing", "open_text_url"]
    assert (await parts.funnel.findings()).groups[0].findings[0].area_id == "area-ai"


async def test_latest_user_override_keeps_its_scope_when_a_work_appears_in_several_runs(
    parts: SimpleNamespace,
) -> None:
    parts.science.search_works = [work(1, title="Off topic")]
    first = await run_to_end(parts, KbFunnelStart(query="communication", channels=["search"]))
    await run_to_end(parts, KbFunnelStart(query="agents", channels=["search"]))
    await parts.funnel.mark_fits(first.id, "work-1")
    checked = await run_to_end(parts, KbFunnelStart(candidate_ids=["work-1"]))
    assert checked.plan == first.plan
    assert checked.counters.new == 1
