"""EX2 X1: the map of the user's own topics, labelling, the "Sort materials" job, topic edits, hidden labels.

Scenarios from G2 on the user's real library: 93 materials, 1000+ concept pages, a library that is not only
science papers, names in Russian. Fakes at the external seams only (engine, OpenAlex search, decision model).
"""

from __future__ import annotations

import asyncio
import json
import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Any

import pytest

from skaz.knowledge.agents.engine import AgentTurn, Completed, Failed, TextDelta
from skaz.knowledge.agents.fake import FakeEngine, Gate, ScriptItem
from skaz.knowledge.api.contract_routes import ContractFailure
from skaz.knowledge.api.schemas_areas import KbAreaCreate, KbAreaMerge, KbAreaUpdate, KbMaterialTopicSet
from skaz.knowledge.areas import prompts
from skaz.knowledge.areas.labelling import BATCH, MaterialLabeller, TopicLabels
from skaz.knowledge.areas.service import ExploreAreasService
from skaz.knowledge.areas.topics import TopicStore, clean_name
from skaz.knowledge.decisions.protocol import (
    Answer,
    ChoiceAnswer,
    ChoiceQuestion,
    DeciderId,
    Question,
    Undecided,
)
from skaz.knowledge.ingest.protocols import TopicRequest
from skaz.knowledge.ingest.service import IngestService
from skaz.knowledge.markdown.page import Block, Cite, PageDocument, PageMeta
from skaz.knowledge.markdown.source import FragmentInput
from skaz.knowledge.science.protocols import ScienceConsentRequired, TaxonomyNode
from skaz.knowledge.service import KnowledgeService
from skaz.knowledge.wiki.jobs import WikiJobs

from .ingest_support import PatternDetector

# -- library builders -----------------------------------------------------------------------------------


def wiki_material(kb: KnowledgeService, title: str, concepts: Sequence[str]) -> str:
    """A material in the wiki: concept pages that cite it."""
    folder = kb.folders()[0].id
    mid = kb.create_material(folder, title, "pdf", [FragmentInput(text="Text.")]).manifest.id
    taken = {page.title for page in kb.pages(kind="concept")}
    for index, raw in enumerate(concepts):
        concept = raw if raw not in taken else f"{raw} ({title})"
        kb.create_page(
            PageDocument(
                meta=PageMeta(skaz_id=f"page-{mid}-{index}", kind="concept", title=concept, sources=(mid,)),
                parts=[
                    Block.create("c-1", "from_source", "A statement.", cites=(Cite(material_id=mid, seg=1),))
                ],
            )
        )
    return mid


class Forbidden:
    """A science client / decision model the map must never call."""

    @property
    def id(self) -> str:
        return "local"

    def __getattr__(self, name: str) -> Any:
        raise AssertionError(f"the map called {name}")


@dataclass
class Search:
    found: dict[str, list[TaxonomyNode]] = field(default_factory=dict)
    queries: list[str] = field(default_factory=list)
    stop: Exception | None = None

    async def __call__(self, terms: Sequence[str]) -> Sequence[TaxonomyNode]:
        assert 1 <= len(terms) <= 6 and all(0 < len(term) <= 72 for term in terms)  # search_topics' limits
        query = " ".join(terms)
        self.queries.append(query)
        if self.stop is not None:
            raise self.stop
        for key, nodes in self.found.items():
            if query.startswith(key):
                return nodes
        return []


@dataclass
class Decider:
    picks: dict[str, tuple[str, dict[str, float]]] = field(default_factory=dict)
    asked: list[ChoiceQuestion] = field(default_factory=list)

    @property
    def id(self) -> DeciderId:
        return "local"

    async def ask(self, question: Question) -> Answer:
        assert isinstance(question, ChoiceQuestion)
        self.asked.append(question)
        for name, (option, probabilities) in self.picks.items():
            if name in question.state:
                return ChoiceAnswer(option=option, probabilities=probabilities, confidence=0.9)
        return Undecided("not sure")

    async def ask_many(self, questions: Sequence[Question]) -> Sequence[Answer]:
        return [await self.ask(q) for q in questions]


def node(tid: str, name: str) -> TaxonomyNode:
    return TaxonomyNode(tid, "subfields-1702", "topic", name, 0)


# -- the map reads stored state only ----------------------------------------------------------------------


async def test_map_of_93_materials_reads_stored_topics_and_never_calls_a_model_or_the_network(
    ready: KnowledgeService,
) -> None:
    """G2 why-1: 93 materials and 1000+ concept pages; the map was slow and paid on every visit."""
    store = TopicStore(ready)
    plan = (
        [("AI", "AI agents")] * 30
        + [("AI", "Machine learning")] * 20
        + [("Деловые коммуникации", "Переговоры")] * 25
        + [("Cooking", None)] * 3
    )
    materials: list[str] = []
    for index in range(93):
        materials.append(
            wiki_material(ready, f"Material {index:02d}", [f"Concept {index}-{n}" for n in range(12)])
        )
    for mid, (topic, sub) in zip(materials, plan, strict=False):
        leaf, _ = store.ensure_path(topic, sub)
        store.label(mid, leaf, "agent")
    service = ExploreAreasService(ready, science=Forbidden(), decisions=Forbidden())  # type: ignore[arg-type]

    top = await service.map()
    assert top.total_pages == 93 * 12 and top.total_sources == 93
    assert [(a.name, a.materials) for a in top.areas] == [
        ("AI", 50),
        ("Деловые коммуникации", 25),
        ("Cooking", 3),
    ]
    assert top.unsorted_materials == 15
    assert round(sum(a.wiki_share for a in top.areas) + 15 / 93, 3) == 1.0
    assert top.worth_closing == [] and all(a.topic_ids == [] for a in top.areas)
    assert top.labelling.state == "not_ready"  # no wiki agent wired here: said, not hidden
    ai = top.areas[0]
    assert ai.level == "custom" and ai.has_children and (ai.children_covered, ai.children_total) == (2, 2)
    assert ai.pages == 50 * 12

    inside = await service.map(parent_id=ai.id)
    assert [b.name for b in inside.breadcrumbs] == ["AI"]
    assert [(a.name, a.materials) for a in inside.areas] == [("AI agents", 30), ("Machine learning", 20)]
    agents = inside.areas[0]
    listed = await service.materials(agents.id, limit=100)
    assert [m.material_id for m in listed.materials] == materials[:30]


# -- the "Sort materials" job ----------------------------------------------------------------------------

LINE = re.compile(r"^(\d+)\. (.+)$", re.M)


def sorter_answer(paths: dict[str, tuple[str, str]]) -> Callable[[AgentTurn], list[ScriptItem]]:
    """An agent that sorts by the title's first word."""

    def answer(turn: AgentTurn) -> list[ScriptItem]:
        prompt = turn.messages[-1].content
        items = [
            {"item": int(number), "topic": paths[title.split()[0]][0], "subtopic": paths[title.split()[0]][1]}
            for number, title in LINE.findall(prompt)
        ]
        return [TextDelta("", json.dumps({"materials": items})), Completed("", None)]

    return answer


def wired(kb: KnowledgeService, engine: FakeEngine, **extra: Any) -> tuple[ExploreAreasService, WikiJobs]:
    ingest = IngestService(kb, engines=lambda _id: engine, detector=PatternDetector())
    jobs = WikiJobs(ingest.jobs, profile=ingest.profile)
    service = ExploreAreasService(kb, ingest=ingest, wiki_jobs=jobs, **extra)
    ingest.topics = service.labeller
    return service, jobs


async def finished(service: ExploreAreasService, jobs: WikiJobs) -> None:
    latest = service.sorting.latest_job()
    assert latest is not None
    await jobs.wait(latest.id)
    await service.mapper.idle()


async def test_sort_materials_labels_45_unsorted_materials_in_batches_and_maps_new_topics(
    ready: KnowledgeService,
) -> None:
    """G2-3 backfill: ~20 materials per call, progress on the map, only topic/concept names leave."""
    titles = (
        [f"Agents {n}" for n in range(20)]
        + [f"Sales {n}" for n in range(20)]
        + [f"Pasta {n}" for n in range(5)]
    )
    for title in titles:
        wiki_material(ready, title, [f"{title} concept", f"Общий термин {title}"])
    gate = asyncio.Event()
    sorter = sorter_answer(
        {
            "Agents": ("AI", "AI agents"),
            "Sales": ("Деловые коммуникации", "Продажи"),
            "Pasta": ("Cooking", ""),
        }
    )
    turns = 0

    def script(turn: AgentTurn) -> list[ScriptItem]:
        nonlocal turns
        turns += 1
        return ([Gate(gate)] if turns == 1 else []) + sorter(turn)

    engine = FakeEngine("codex", script=script)
    search = Search(found={"AI agents": [node("T10028", "LLM agents and tool use"), node("T1", "Robotics")]})
    decider = Decider(picks={"AI agents": ("LLM agents and tool use", {"LLM agents and tool use": 0.7})})
    service, jobs = wired(ready, engine, decisions=decider, topic_search=lambda: search)

    before = await service.map()
    assert (before.unsorted_materials, before.labelling.state, before.labelling.engine) == (
        45,
        "idle",
        "codex",
    )
    started = await service.sort_topics()
    assert started.state == "running" and started.job_id is not None
    assert (await service.sort_topics()).job_id == started.job_id  # a second click starts nothing new
    while (await service.map()).labelling.total == 0:
        await asyncio.sleep(0.005)
    assert (await service.map()).labelling.total == 45
    gate.set()
    await finished(service, jobs)

    assert [len(LINE.findall(turn.messages[-1].content)) for turn in engine.turns] == [BATCH, BATCH, 5]
    first = engine.turns[0]
    assert first.tools is None and first.response_schema == prompts.LABEL_SCHEMA
    assert (
        "<untrusted-data" in first.messages[-1].content and "Agents 0 concept" in first.messages[-1].content
    )
    assert "Деловые коммуникации › Продажи" in engine.turns[2].messages[-1].content  # existing paths offered
    after = await service.map()
    assert after.unsorted_materials == 0 and after.labelling.state == "idle"
    assert [(a.name, a.materials) for a in after.areas] == [
        ("AI", 20),
        ("Деловые коммуникации", 20),
        ("Cooking", 5),
    ]
    job = service.sorting.latest_job()
    assert job is not None and job.counters["parts_done"] == 45
    assert "Sorted 45 of 45" in job.journal[-1].message and "Agents" not in job.journal[-1].message
    assert all(item.kind != "topics" for item in IngestService.list_jobs(service._ingest))  # type: ignore[arg-type]

    # Hidden label: one search per new topic by its name + main concepts; ids never on the map.
    agents = next(a for a in (await service.map(parent_id=after.areas[0].id)).areas if a.name == "AI agents")
    assert list(service.topics(agents.id)) == ["T10028"] and agents.topic_ids == []
    assert any(q.startswith("AI agents Agents ") and "concept" in q for q in search.queries)
    assert len(search.queries) == 5  # AI, AI agents, Деловые коммуникации, Продажи, Cooking
    assert service.area_for_topics(["T10028"]) == agents.id
    assert (await service.sort_topics()).state == "idle"  # nothing left to sort: no job, no call
    assert len(engine.turns) == 3


async def test_sorting_pauses_at_the_usage_limit_and_the_next_click_continues(
    ready: KnowledgeService,
) -> None:
    """WR5 rules apply to the topics job: paused with its reason, Continue on the user's click."""
    for n in range(3):
        wiki_material(ready, f"Agents {n}", ["Tool use"])
    sorter = sorter_answer({"Agents": ("AI", "AI agents")})
    limited = True

    def script(turn: AgentTurn) -> list[ScriptItem]:
        nonlocal limited
        if limited:
            limited = False
            return [Failed("", "limit", "PRIVATE provider detail", None)]
        return sorter(turn)

    engine = FakeEngine("codex", script=script)
    service, jobs = wired(ready, engine)
    await service.sort_topics()
    await finished(service, jobs)
    paused = (await service.map()).labelling
    assert (paused.state, paused.reason_code) == ("paused", "engine_limit")
    assert (await service.map()).unsorted_materials == 3
    again = await service.sort_topics()
    assert again.job_id == paused.job_id
    await finished(service, jobs)
    done = await service.map()
    assert done.unsorted_materials == 0 and done.labelling.state == "idle"
    assert "PRIVATE" not in repr(service.sorting.latest_job())


async def test_no_wiki_agent_is_an_honest_state_and_the_click_is_refused(ready: KnowledgeService) -> None:
    wiki_material(ready, "Agents 1", ["Tool use"])
    ingest = IngestService(ready, engines=lambda _id: None, detector=PatternDetector())
    service = ExploreAreasService(
        ready, ingest=ingest, wiki_jobs=WikiJobs(ingest.jobs, profile=ingest.profile)
    )
    state = (await service.map()).labelling
    assert (state.state, state.reason_code) == ("not_ready", "no_wiki_engine")
    with pytest.raises(ContractFailure) as caught:
        await service.sort_topics()
    assert (caught.value.status, caught.value.code) == (503, "not_ready")
    unwired = ExploreAreasService(ready)
    with pytest.raises(ContractFailure):
        await unwired.sort_topics()


# -- labelling at the end of ingest ------------------------------------------------------------------------


async def test_a_material_is_labelled_by_its_own_agent_and_a_users_move_wins(ready: KnowledgeService) -> None:
    mid = wiki_material(ready, "Переговоры с клиентом", ["Активное слушание", "Возражения"])
    store = TopicStore(ready)
    existing, _ = store.ensure_path("Деловые коммуникации", "Переговоры")
    asked: list[str] = []

    async def ask(instructions: str, messages: Sequence[Any], schema: dict[str, Any]) -> str:
        asked.append(messages[-1].content)
        assert "Russian" in instructions or "russian" in instructions.lower()
        return json.dumps(
            {"materials": [{"item": 1, "topic": "деловые коммуникации", "subtopic": "ПЕРЕГОВОРЫ"}]}
        )

    logs: list[str] = []

    async def log(message: str) -> None:
        logs.append(message)

    scheduled: list[int] = []
    labeller = MaterialLabeller(TopicLabels(store), lambda: scheduled.append(1))
    assert await labeller.label(TopicRequest(mid, ask, log, "ru")) == existing  # matched, not duplicated
    assert "Активное слушание" in asked[0] and "Деловые коммуникации › Переговоры" in asked[0]
    assert len(store.topics()) == 2 and scheduled == []

    other, _ = store.ensure_path("Sales", None)
    store.move(mid, other)
    assert await labeller.label(TopicRequest(mid, ask, log, "ru")) == other  # re-processing keeps the move
    assert len(asked) == 1
    assert store.material_topic(mid).origin == "user"


async def test_an_unreadable_answer_leaves_materials_unsorted_and_paths_in_one_field_are_split(
    ready: KnowledgeService,
) -> None:
    store = TopicStore(ready)
    a = wiki_material(ready, "A", ["x"])
    b = wiki_material(ready, "B", ["y"])
    labels = TopicLabels(store)
    answers = iter(["not json", "still not json"])

    async def broken(_i: str, _m: Sequence[Any], _s: dict[str, Any]) -> str:
        return next(answers)

    outcome = await labels.ask(broken, [a, b], "en")
    assert outcome.unreadable and store.unsorted_material_ids() == [a, b]  # titles "A", "B"

    async def odd(_i: str, _m: Sequence[Any], _s: dict[str, Any]) -> str:
        return json.dumps(
            {
                "materials": [
                    {"item": 1, "topic": "AI › Agents", "subtopic": ""},
                    {"item": 7, "topic": "Ghost", "subtopic": ""},
                    {"item": 2, "topic": "  ", "subtopic": ""},
                ]
            }
        )

    outcome = await labels.ask(odd, [a, b], "en")
    assert outcome.labelled == 1 and store.unsorted_material_ids() == [b]
    assert [t.name for t in store.topics()] == ["AI", "Agents"]
    assert clean_name('  "Agents ›"  ') == "Agents" and len(clean_name("word " * 40)) <= 60


# -- topic edits --------------------------------------------------------------------------------------------


async def test_create_rename_merge_move_and_delete_own_topics(ready: KnowledgeService) -> None:
    service = ExploreAreasService(ready)
    store = service.topic_store
    m1, m2, m3 = (wiki_material(ready, f"M{n}", ["c"]) for n in range(3))
    ai = await service.create(KbAreaCreate(name="AI"))
    agents = await service.create(KbAreaCreate(name="Agents", parent_id=ai.id))
    ml = await service.create(KbAreaCreate(name="ML"))
    ml_agents = await service.create(KbAreaCreate(name="agents", parent_id=ml.id))
    ml_vision = await service.create(KbAreaCreate(name="Vision", parent_id=ml.id))
    assert (ai.level, ai.topic_ids, agents.parent_id) == ("custom", [], ai.id)
    with pytest.raises(ContractFailure) as caught:
        await service.create(KbAreaCreate(name="Deeper", parent_id=agents.id))  # two levels only
    assert caught.value.status == 422
    with pytest.raises(ContractFailure) as caught:
        await service.create(KbAreaCreate(name="ai"))
    assert caught.value.status == 409

    store.label(m1, ml_agents.id, "agent")
    store.label(m2, ml_vision.id, "agent")
    moved = await service.set_material_topic(m3, KbMaterialTopicSet(area_id=ml.id))
    assert (moved.area_id, moved.origin) == (ml.id, "user")

    renamed = await service.update(ml.id, KbAreaUpdate(name="Machine learning", pinned=True))
    assert renamed.name == "Machine learning" and store.topic(ml.id).mapping_state == "pending"
    with pytest.raises(ContractFailure) as caught:
        await service.update(ml.id, KbAreaUpdate(name="AI"))
    assert caught.value.status == 409

    with pytest.raises(ContractFailure) as caught:
        await service.merge(ai.id, KbAreaMerge(into_id=agents.id))  # into its own subtopic
    assert caught.value.status == 422
    merged = await service.merge(ml.id, KbAreaMerge(into_id=ai.id))
    assert merged.id == ai.id and merged.pinned and merged.materials == 3
    children = {a.name: a for a in (await service.map(parent_id=ai.id)).areas}
    assert set(children) == {"Agents", "Vision"} and children["Agents"].materials == 1  # same name joined
    assert store.material_topic(m3).area_id == ai.id and store.material_topic(m3).origin == "user"

    await service.delete(ai.id)
    assert (await service.map()).areas == [] and len(store.unsorted_material_ids()) == 3


# -- hidden OpenAlex label ----------------------------------------------------------------------------------


async def test_hidden_label_picks_up_to_three_topics_no_match_and_waits_on_a_stop(
    ready: KnowledgeService,
) -> None:
    store = TopicStore(ready)
    rag, _ = store.ensure_path("RAG", None)
    cooking, _ = store.ensure_path("Cooking", None)
    talks, _ = store.ensure_path("Переговоры", None)
    search = Search(
        found={
            "RAG": [
                node("T1", "Retrieval"),
                node("T2", "QA systems"),
                node("T3", "Search"),
                node("T4", "Vision"),
            ],
            "Переговоры": [node("T9", "Negotiation")],
        }
    )
    decider = Decider(
        picks={
            "RAG": ("Retrieval", {"Retrieval": 0.5, "QA systems": 0.3, "Search": 0.26, "Vision": 0.1}),
        }
    )
    service = ExploreAreasService(ready, decisions=decider, topic_search=lambda: search)
    assert await service.map_topics() == 2  # RAG mapped, Cooking no match; Переговоры undecided
    assert list(service.topics(rag)) == ["T1", "T2", "T3"]
    assert store.topic(cooking).mapping_state == "no_match" and list(service.topics(cooking)) == []
    assert store.topic(talks).mapping_state == "pending"
    assert prompts.NO_MATCH_OPTION in decider.asked[0].options and "<untrusted-data" in decider.asked[0].state

    store.rename(rag, "Retrieval-augmented generation")
    assert list(service.topics(rag)) == []  # a stale label is not used for a search
    search.stop = ScienceConsentRequired()
    assert await service.map_topics() == 0
    assert store.topic(rag).mapping_state == "pending"
    unwired = ExploreAreasService(ready)
    assert await unwired.map_topics() == 0


async def test_runtime_map_answers_from_stored_state_without_consent(kb_client: Any, kb_app: Any) -> None:
    """G2 why-1: GET map no longer needs OpenAlex (it answered 403 consent_required before EX2)."""
    runtime = kb_app.state.runtime
    runtime.kb.connect(None)
    res = await kb_client.get("/kb/explore/map")
    assert res.status_code == 200
    body = res.json()
    assert body["areas"] == [] and body["worth_closing"] == [] and body["unsorted_materials"] == 0
    res = await kb_client.post("/kb/explore/areas", json={"name": "AI agents"})
    assert res.status_code == 200 and res.json()["topic_ids"] == []
    area_id = res.json()["id"]
    res = await kb_client.post(f"/kb/explore/areas/{area_id}/merge", json={"into_id": area_id})
    assert (res.status_code, res.json()) == (422, {"code": "invalid_request"})
    res = await kb_client.put("/kb/materials/missing/topic", json={"area_id": area_id})
    assert (res.status_code, res.json()) == (404, {"code": "not_found"})


def test_directory_gives_the_largest_topics_and_their_main_concepts(ready: KnowledgeService) -> None:
    """X2's "All your topics": the largest top-level topics (max 8) and their main concepts."""
    service = ExploreAreasService(ready)
    store = service.topic_store
    for n in range(10):
        leaf, _ = store.ensure_path(f"Topic {n}", "Sub")
        mids = [wiki_material(ready, f"T{n}-{k}", [f"Own {n}-{k}"]) for k in range(n + 1)]
        for mid in mids:
            store.label(mid, leaf, "agent")
        cites = tuple(Cite(material_id=mid, seg=1) for mid in mids)
        ready.create_page(
            PageDocument(
                meta=PageMeta(
                    skaz_id=f"shared-{n}", kind="concept", title=f"Shared {n}", sources=tuple(mids)
                ),
                parts=[Block.create("c-1", "from_source", "A statement.", cites=cites)],
            )
        )
    largest = list(service.topic_directory.largest_topics())
    assert len(largest) == 8 and store.topic(largest[0]).name == "Topic 9"
    assert service.topic_directory.top_concepts(largest[0], 2)[0] == "Shared 9"


async def test_ingest_labels_its_material_last_with_the_same_agent_and_a_failure_keeps_it_done(
    ready: KnowledgeService,
) -> None:
    """G2-3: the wiki agent labels the material at the end of its processing (same engine and profile)."""
    from .ingest_support import ScriptedWiki, add_material, wait_finished
    from .test_ingest_pipeline import CONCEPTS_OK, NOTES_OK

    labelled = json.dumps({"materials": [{"item": 1, "topic": "Физика", "subtopic": "Термодинамика"}]})
    wiki = ScriptedWiki(
        notes=[NOTES_OK, NOTES_OK],
        concepts=[CONCEPTS_OK, CONCEPTS_OK],
        answers={prompts.LABEL_SCHEMA_TITLE: [labelled, "broken", "broken"]},
    )
    ready.settings.set("write_notes_automatically", True)
    ingest = IngestService(ready, engines=lambda _id: wiki.engine, detector=PatternDetector())
    service = ExploreAreasService(
        ready, ingest=ingest, wiki_jobs=WikiJobs(ingest.jobs, profile=ingest.profile)
    )
    ingest.topics = service.labeller

    first = add_material(ready, "Физика", "Лекция 8")
    job = await wait_finished(ingest, (await ingest.request_ingest(first)).id)
    assert job.state == "done"
    titles = [str(turn.response_schema["title"]) for turn in wiki.engine.turns if turn.response_schema]
    assert titles[-1] == prompts.LABEL_SCHEMA_TITLE  # the last call of the material's processing
    topic = service.topic_store.material_topic(first)
    assert topic.origin == "agent" and topic.area_id is not None
    assert service.area_path(topic.area_id) == ("Физика", "Термодинамика")
    assert (await service.map()).unsorted_materials == 0

    second = add_material(ready, "Физика", "Лекция 9")
    job = await wait_finished(ingest, (await ingest.request_ingest(second)).id)
    assert job.state == "done"  # an unreadable topic answer never fails the material
    assert service.topic_store.material_topic(second).area_id is None
    assert any("Sort materials" in entry.message for entry in job.journal)
    await ingest.close()


def test_areas_v2_keeps_a_pre_ex2_custom_areas_openalex_topics_as_its_hidden_label() -> None:
    import sqlite3

    from skaz.knowledge.store.schema import areas

    connection = sqlite3.connect(":memory:")
    connection.executescript(
        "CREATE TABLE explore_areas (id TEXT PRIMARY KEY, parent_id TEXT, taxonomy_id TEXT,"
        " level TEXT NOT NULL, original_name TEXT NOT NULL, name TEXT NOT NULL,"
        " hidden INTEGER NOT NULL DEFAULT 0,"
        " pinned INTEGER NOT NULL DEFAULT 0);"
        "CREATE TABLE explore_area_topics (area_id TEXT NOT NULL, topic_id TEXT NOT NULL,"
        " PRIMARY KEY(area_id, topic_id));"
        "INSERT INTO explore_areas(id, level, original_name, name) VALUES"
        " ('a1','custom','Mine','Mine'), ('a2','custom','Empty','Empty'), ('d1','domain','S','S');"
        "INSERT INTO explore_area_topics VALUES ('a1','T1');"
    )
    areas.UPGRADES[2](connection)
    areas.UPGRADES[2](connection)
    sql = "SELECT id, mapping_state, mapped_name FROM explore_areas ORDER BY id"
    rows = connection.execute(sql).fetchall()
    assert rows == [("a1", "mapped", "Mine"), ("a2", "pending", None), ("d1", "pending", None)]
