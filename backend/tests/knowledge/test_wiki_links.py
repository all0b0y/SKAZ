"""Discrepancies, connections, the graph, folder overviews, background connections (decisions 4, 5, 10)."""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from skaz.knowledge.agents.engine import EngineStatus
from skaz.knowledge.agents.fake import FakeEngine
from skaz.knowledge.decisions.protocol import Answer, Question, YesNoAnswer
from skaz.knowledge.markdown.page import parse_page
from skaz.knowledge.service import KnowledgeService
from skaz.knowledge.wiki.statements import page_statements

from .ingest_support import PatternDetector
from .wiki_support import CONNECTIONS, DISCREPANCIES, OVERVIEW, TwoSources, two_sources

ENTROPY = "Энтропия (entropy)"


def page_text(kb: KnowledgeService, page_id: str) -> str:
    record = kb.page_repo.get(page_id)
    assert record is not None
    return (kb.library_root / record.rel_path).read_text(encoding="utf-8")


def discrepancy(kb: KnowledgeService) -> Any:
    [notice] = [item for item in kb.notifications() if item.kind == "discrepancy"]
    return notice


# -- discrepancies ------------------------------------------------------------------


async def test_a_contradiction_is_marked_with_both_versions_and_a_notification(
    ready: KnowledgeService,
) -> None:
    case = await two_sources(ready)
    page_id = case.concept_id(ENTROPY)
    document = parse_page(page_text(ready, page_id))
    statements = [block for block in document.blocks() if block.kind == "from_source"]
    # Both versions stay, on equal terms.
    assert any("газа растёт" in block.body for block in statements)
    assert any("изолированной системы убывает" in block.body for block in statements)
    [mark] = [block for block in document.blocks() if block.id.startswith("c-disc-")]
    assert mark.kind == "explanation" and mark.owner == "agent"
    assert mark.body.startswith("Sources disagree: [[#^") and "Одна говорит о росте" in mark.body

    notice = discrepancy(ready)
    assert notice.requires_action and notice.subject == {
        "type": "page",
        "id": page_id,
        "block_id": mark.id,
        "seg": None,
    }
    payload = notice.payload
    assert payload["page_id"] == page_id and payload["page_title"] == ENTROPY
    assert payload["explanation_block_id"] == mark.id
    old, new = payload["sides"]
    assert old["material_title"] == "Лекция 8" and old["folder_name"] == "Физика"
    assert new["material_title"] == "Учебник" and new["folder_name"] == "Химия"
    assert new["citation"]["material_id"] == case.textbook and new["citation"]["available"] is True
    assert new["citation"]["quote"] == "Энтропия изолированной системы со временем убывает."
    assert set(old) == {"block_id", "text", "citation", "material_title", "folder_name"}
    actions = [
        (spec.id, spec.label, spec.primary, spec.needs_text)
        for spec in ready.notification_actions.actions(notice)
    ]
    assert actions == [
        ("keep_both", "Keep both", True, False),
        ("prefer_0", "Correct in Лекция 8", False, False),
        ("prefer_1", "Correct in Учебник", False, False),
        ("own_note", "Write my own note", False, True),
    ]
    # Reported once: the statements are remembered as compared.
    turns = len(case.wiki.turns(DISCREPANCIES))
    job = await case.service.find_connections()
    await case.service.jobs.wait(job.id)
    assert len(case.wiki.turns(DISCREPANCIES)) == turns
    assert len([item for item in ready.notifications() if item.kind == "discrepancy"]) == 1


@pytest.mark.parametrize("action", ["keep_both", "prefer_0", "prefer_1", "own_note"])
async def test_every_discrepancy_action_works(ready: KnowledgeService, action: str) -> None:
    case = await two_sources(ready)
    page_id = case.concept_id(ENTROPY)
    notice = discrepancy(ready)
    old, new = notice.payload["sides"]
    before = page_text(ready, page_id)
    text = "Мой вывод: условия разные." if action == "own_note" else None
    resolved = await case.service.feed.resolve(notice.id, action, text)
    assert resolved.resolution == action and resolved.resolved_at
    after = page_text(ready, page_id)
    document = parse_page(after)
    ids = [block.id for block in document.blocks()]
    # Both sides always stay (the source isn't "wrong"; it is the user's choice).
    assert old["block_id"] in ids and new["block_id"] in ids
    if action == "keep_both":
        assert after == before
    elif action == "own_note":
        note = next(block for block in document.blocks() if block.kind == "user_note")
        assert note.owner == "user" and note.body == "Мой вывод: условия разные."
        assert ids.index(note.id) == ids.index(notice.payload["explanation_block_id"]) + 1
    else:
        loser = new if action == "prefer_0" else old
        winner = old if action == "prefer_0" else new
        superseded = document.blocks()[ids.index(loser["block_id"]) + 1]
        assert superseded.id.startswith("c-sup-") and superseded.kind == "explanation"
        assert superseded.body == f"Superseded by “{winner['material_title']}” — your choice."
    with pytest.raises(Exception, match="already resolved"):
        await case.service.feed.resolve(notice.id, "keep_both", None)


async def test_own_note_needs_text_and_resolve_over_http(kb_app: Any, kb_client: httpx.AsyncClient) -> None:
    await kb_client.post("/kb/library", json={})
    runtime = kb_app.state.runtime
    await two_sources(runtime.kb, runtime=runtime)
    notice = discrepancy(runtime.kb)
    no_text = await kb_client.post(f"/kb/notifications/{notice.id}/resolve", json={"action": "own_note"})
    assert no_text.status_code == 422
    feed = (await kb_client.get("/kb/notifications")).json()
    item = next(entry for entry in feed["items"] if entry["id"] == notice.id)
    assert [action["id"] for action in item["actions"]] == ["keep_both", "prefer_0", "prefer_1", "own_note"]
    assert feed["requires_action"] == 1
    done = await kb_client.post(f"/kb/notifications/{notice.id}/resolve", json={"action": "keep_both"})
    assert done.status_code == 200 and done.json()["resolution"] == "keep_both"
    again = await kb_client.post(f"/kb/notifications/{notice.id}/resolve", json={"action": "keep_both"})
    assert again.status_code == 409 and again.json() == {"detail": "This notification is already resolved."}
    assert (await kb_client.get("/kb/notifications")).json()["requires_action"] == 0


async def test_a_confident_no_from_the_decision_layer_drops_the_pair(ready: KnowledgeService) -> None:
    def sure_no(_question: Question) -> Answer:
        return YesNoAnswer(0.05)

    case = await two_sources(ready, answer=sure_no)
    assert [item for item in ready.notifications() if item.kind == "discrepancy"] == []
    assert "c-disc-" not in page_text(ready, case.concept_id(ENTROPY))


# -- connections and the graph --------------------------------------------------------


async def connected(case: TwoSources) -> str:
    """Run "Find connections" with a scripted connection Энтропия → Температура; returns the block id."""
    # Statements are numbered: this page's first, then the candidate's (Температура: one statement).
    own = page_statements(case.kb, case.concept_id(ENTROPY), limit=10)
    mine = next(n for n, item in enumerate(own, start=1) if "газа растёт" in item.text)
    answer = {
        "connections": [
            {
                "page": 1,
                "text": "Рост температуры увеличивает энтропию газа.",
                "this_side": [mine],
                "other_side": [len(own) + 1],
            }
        ]
    }
    case.wiki.queues.setdefault(CONNECTIONS, []).append(json.dumps(answer, ensure_ascii=False))
    job = await case.service.find_connections([case.concept_id(ENTROPY)])
    await case.service.jobs.wait(job.id)
    record = case.ingest.job(job.id)
    assert record.state == "done", (record.error, record.journal)
    document = parse_page(page_text(case.kb, case.concept_id(ENTROPY)))
    return next(block.id for block in document.blocks() if block.id.startswith("c-link-"))


async def test_find_connections_writes_a_cited_connection_and_an_edge(ready: KnowledgeService) -> None:
    case = await two_sources(ready, conflict=False)
    block_id = await connected(case)
    document = parse_page(page_text(ready, case.concept_id(ENTROPY)))
    link = document.block(block_id)
    assert link is not None and link.kind == "connection" and link.owner == "agent"
    # Both sides cited (checked quotes copied from the statements), plus the link to the other page.
    assert {(cite.material_id, cite.seg) for cite in link.cites} == {(case.lecture, 3), (case.lecture, 2)}
    assert link.body.endswith("[[Wiki/Concepts/Температура|Температура]]")
    temperature = case.concept_id("Температура")
    graph = case.service.graph_view(None)
    edges = {(edge.source, edge.target, edge.kind) for edge, _cross in graph.edges}
    assert (case.concept_id(ENTROPY), temperature, "connection") in edges
    detail = case.service.page(temperature)
    # A connection counts both ways: Температура lists Энтропия as related although only Энтропия holds it.
    assert case.concept_id(ENTROPY) in [ref.id for ref in detail.related]
    assert case.concept_id(ENTROPY) not in [ref.id for ref in detail.mentioned_in]
    # Already connected: not proposed again.
    page = ready.page_repo.get(case.concept_id(ENTROPY))
    assert page is not None and temperature not in [
        item.id for item in case.service.connections.candidates(page)
    ]


async def test_graph_over_http(kb_app: Any, kb_client: httpx.AsyncClient) -> None:
    await kb_client.post("/kb/library", json={})
    runtime = kb_app.state.runtime
    case = await two_sources(runtime.kb, conflict=False, runtime=runtime)
    entropy, temperature = case.concept_id(ENTROPY), case.concept_id("Температура")
    graph = (await kb_client.get("/kb/graph")).json()
    nodes = {node["id"]: node for node in graph["nodes"]}
    assert nodes[entropy]["kind"] == "concept" and len(nodes[entropy]["folder_ids"]) == 2
    note = case.note_id(case.lecture)
    assert nodes[note]["kind"] == "note"
    edges = {(edge["source"], edge["target"]): edge for edge in graph["edges"]}
    assert edges[(entropy, temperature)]["kind"] == "link"  # the "Related" navigation
    assert edges[(note, entropy)]["cross_folder"] is False
    physics = next(folder.id for folder in runtime.kb.folders() if folder.name == "Физика")
    chemistry = next(folder.id for folder in runtime.kb.folders() if folder.name == "Химия")
    only = (await kb_client.get("/kb/graph", params={"folder_id": chemistry})).json()
    assert {node["id"] for node in only["nodes"]} == {entropy, case.note_id(case.textbook)}
    assert all(edge["source"] in {entropy, case.note_id(case.textbook)} for edge in only["edges"])
    assert physics in nodes[entropy]["folder_ids"]
    assert (await kb_client.get("/kb/graph", params={"folder_id": "fld-gone"})).status_code == 404

    page = (await kb_client.get(f"/kb/wiki/pages/{temperature}")).json()
    # Энтропия links here (its "Related"), Температура doesn't link back: "Mentioned in", not "Related".
    assert {"id": entropy, "kind": "concept", "title": ENTROPY} in page["mentioned_in"]
    assert entropy not in [ref["id"] for ref in page["related"]]
    assert page["folder_names"] == ["Физика"] and page["updated_at"].endswith("Z")
    assert page["is_analysis_source_forbidden"] is False
    started = await kb_client.post("/kb/wiki/connections/find")
    assert started.status_code == 202 and started.json()["kind"] == "connections"
    assert started.json()["material_id"] is None
    await case.service.jobs.wait(started.json()["id"])


# -- folder overview ----------------------------------------------------------------------


async def test_the_folder_overview_is_written_after_ingest(ready: KnowledgeService) -> None:
    case = await two_sources(ready, conflict=False)
    physics = next(folder for folder in ready.folders() if folder.name == "Физика")
    case.wiki.queues.setdefault(OVERVIEW, []).append(
        json.dumps(
            {
                "blocks": [
                    {"text": "Лекция ввела энтропию как меру беспорядка.", "statements": [1]},
                    {"text": "Ссылка на несуществующее утверждение.", "statements": [99]},
                ]
            },
            ensure_ascii=False,
        )
    )
    job = await case.service.write_overview(physics.id)
    await case.service.jobs.wait(job.id)
    assert case.ingest.job(job.id).state == "done"
    [page] = ready.pages(kind="folder")
    assert page.rel_path == "Wiki/Folders/Физика.md" and page.folders == (physics.id,)
    document = parse_page(page_text(ready, page.id))
    [covered] = [block for block in document.blocks() if block.kind == "from_source"]
    assert covered.cites and covered.cites[0].material_id == case.lecture and covered.cites[0].quote
    text = page_text(ready, page.id)
    assert "## What was covered" in text and "## Key concepts" in text and "## Materials in order" in text
    assert "1. [[Wiki/Notes/Лекция 8|Лекция 8]]" in text


# -- background connections -----------------------------------------------------------------


async def test_background_connections_never_start_without_permission(ready: KnowledgeService) -> None:
    case = await two_sources(ready, conflict=False)
    service = case.service
    service.idle_after_s = 0.0
    assert case.ingest.settings().background_connections is False
    assert await service.tick() is None
    assert not [
        job for job in case.ingest.list_jobs() if job.kind == "connections" and job.state == "running"
    ]
    jobs_before = len([job for job in case.ingest.list_jobs() if job.kind == "connections"])

    case.ingest.update_settings(background_connections=True)
    service.idle_after_s = 3600.0
    service._touch()
    assert await service.tick() is None
    service.idle_after_s = 0.0
    job = await service.tick()
    assert job is not None and job.kind == "connections"
    await service.jobs.wait(job.id)
    assert len([item for item in case.ingest.list_jobs() if item.kind == "connections"]) == jobs_before + 1
    # Nothing changed since: no second background run.
    assert await service.tick() is None


# -- "Find connections now" without a ready agent (QA A13) --------------------------------


async def test_find_now_without_a_ready_agent_is_refused_and_starts_no_job(
    kb_app: Any, kb_client: httpx.AsyncClient
) -> None:
    await kb_client.post("/kb/library", json={})
    runtime = kb_app.state.runtime
    case = await two_sources(runtime.kb, conflict=False, runtime=runtime)
    before = len(runtime.kb_ingest.jobs.list_all())
    not_installed = EngineStatus("codex", installed=False, reason="Codex is not installed.")
    missing = FakeEngine("codex", status=not_installed)
    runtime.kb_ingest.engines = lambda _engine_id: missing
    answer = await kb_client.post("/kb/wiki/connections/find")
    assert answer.status_code == 409
    assert answer.json()["detail"] == (
        "Finding connections needs a connected agent. Codex is not installed. "
        "Set one up in Settings → Accounts & keys."
    )
    # Nothing was started and reported as done.
    assert len(runtime.kb_ingest.jobs.list_all()) == before
    assert not case.service.jobs.running("connections")
    # No engine at all: the same honest refusal.
    runtime.kb_ingest.engines = lambda _engine_id: None
    answer = await kb_client.post("/kb/wiki/connections/find")
    assert answer.status_code == 409 and "needs a connected agent" in answer.json()["detail"]


async def test_find_now_on_a_wiki_without_concept_pages_says_so(
    kb_app: Any, kb_client: httpx.AsyncClient
) -> None:
    await kb_client.post("/kb/library", json={})
    runtime = kb_app.state.runtime
    runtime.kb_ingest.engines = lambda _engine_id: FakeEngine("codex")
    runtime.kb_ingest.detector = PatternDetector()
    answer = await kb_client.post("/kb/wiki/connections/find")
    assert answer.status_code == 400
    assert answer.json()["detail"] == "The wiki has no concept pages yet. Add materials to the wiki first."
    assert runtime.kb_ingest.jobs.list_all() == []
