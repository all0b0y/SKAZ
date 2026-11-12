"""B4 tests: OpenAlex taxonomy map, areas, read marks, factual signals, and AreaDirectory/SignalRecorder."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import date
from pathlib import Path
from typing import TYPE_CHECKING

import pytest

from skaz.knowledge.api.contract_routes import ContractFailure
from skaz.knowledge.api.schemas_areas import (
    KbAreaCreate,
    KbAreaUpdate,
    KbReadMarkUpdate,
    KbSignalEntity,
)
from skaz.knowledge.areas.protocols import (
    AreaDirectory,
    SignalDraft,
    SignalRecorder,
)
from skaz.knowledge.areas.service import ExploreAreasService
from skaz.knowledge.areas.signals import SignalStore
from skaz.knowledge.areas.store import AreasStore
from skaz.knowledge.errors import NotFound
from skaz.knowledge.service import KnowledgeService
from skaz.knowledge.store.database import KnowledgeDatabase

if TYPE_CHECKING:
    pass


@pytest.fixture
def db(tmp_path: Path) -> Iterator[KnowledgeDatabase]:
    database = KnowledgeDatabase(tmp_path / "knowledge.sqlite3")
    yield database
    database.close()


def test_signal_store_records_append_only_facts_and_paginates(db: KnowledgeDatabase) -> None:
    store: SignalRecorder = SignalStore(db)
    s1 = store.record(
        SignalDraft(
            subject=KbSignalEntity(kind="user", id="local-user"),
            predicate="area_opened",
            object=KbSignalEntity(kind="area", id="area-ai"),
            origin="user_action",
            evidence_id="area-ai",
        )
    )
    s2 = store.record(
        SignalDraft(
            subject=KbSignalEntity(kind="user", id="local-user"),
            predicate="read_mark_set",
            object=KbSignalEntity(kind="material", id="mat-1"),
            origin="user_action",
            value="useful_method",
            evidence_id="read-mark-mat-1",
        )
    )
    s3 = store.record(
        SignalDraft(
            subject=KbSignalEntity(kind="user", id="local-user"),
            predicate="read_mark_set",
            object=KbSignalEntity(kind="material", id="mat-1"),
            origin="user_action",
            value="changed_my_view",
            evidence_id="read-mark-mat-1",
            supersedes_id=s2.id,
        )
    )
    assert s3.supersedes_id == s2.id

    concrete = SignalStore(db)
    page1 = concrete.list_signals(limit=2)
    assert [sig.id for sig in page1.signals] == [s3.id, s2.id]
    assert page1.next_cursor is not None

    page2 = concrete.list_signals(cursor=page1.next_cursor, limit=2)
    assert [sig.id for sig in page2.signals] == [s1.id]
    assert page2.next_cursor is None

    with pytest.raises(ContractFailure) as exc:
        concrete.list_signals(cursor="nonexistent-cursor", limit=2)
    assert exc.value.status == 422
    assert exc.value.code == "invalid_request"


def test_areas_store_directory_custom_areas_and_read_marks(ready: KnowledgeService) -> None:
    signals = SignalStore(ready.db)
    store = AreasStore(ready, signals)
    directory: AreaDirectory = store

    from skaz.knowledge.science.protocols import TaxonomyNode

    store.sync_taxonomy_nodes(
        None,
        [
            TaxonomyNode("domain-physical", None, "domain", "Physical Sciences", 2),
        ],
    )
    store.sync_taxonomy_nodes(
        "domain-physical",
        [
            TaxonomyNode("field-cs", "domain-physical", "field", "Computer Science", 1),
        ],
    )
    store.sync_taxonomy_nodes(
        "field-cs",
        [
            TaxonomyNode("area-ai", "field-cs", "subfield", "Artificial Intelligence", 2),
        ],
    )
    store.sync_taxonomy_nodes(
        "area-ai",
        [
            TaxonomyNode("topic-rag", "area-ai", "topic", "Retrieval-augmented generation", 0),
            TaxonomyNode("topic-agents", "area-ai", "topic", "LLM agents and tool use", 0),
        ],
    )

    assert list(directory.area_path("topic-rag")) == [
        "Physical Sciences",
        "Computer Science",
        "Artificial Intelligence",
        "Retrieval-augmented generation",
    ]
    # A subfield's scope is its own id (a hierarchy filter), not the leaves loaded so far (review R1-05).
    assert list(directory.topics("area-ai")) == ["area-ai"]
    assert list(directory.topics("topic-rag")) == ["topic-rag"]
    assert directory.area_for_topics(["unknown", "topic-rag"]) == "topic-rag"

    # Rename, pin, hide on taxonomy area
    updated = store.update_area("topic-rag", KbAreaUpdate(name="RAG", pinned=True))
    assert updated.name == "RAG"
    assert updated.original_name == "Retrieval-augmented generation"
    assert updated.pinned is True
    assert list(directory.pinned()) == ["topic-rag"]

    # Re-syncing taxonomy preserves user rename and pinned state
    store.sync_taxonomy_nodes(
        "area-ai",
        [
            TaxonomyNode("topic-rag", "area-ai", "topic", "Retrieval-augmented generation", 0),
        ],
    )
    reloaded = store.get_area("topic-rag")
    assert reloaded.name == "RAG"
    assert reloaded.original_name == "Retrieval-augmented generation"
    assert reloaded.pinned is True

    # Taxonomy area cannot be deleted (409 conflict)
    with pytest.raises(ContractFailure) as exc:
        store.delete_area("topic-rag")
    assert exc.value.status == 409
    assert exc.value.code == "conflict"

    # Custom area creation & deletion
    custom = store.create_custom(KbAreaCreate(name="My Agent Stack", topic_ids=["topic-rag", "topic-agents"]))
    assert custom.level == "custom"
    assert custom.topic_ids == []  # EX2: the hidden OpenAlex label never reaches the UI
    assert list(directory.topics(custom.id)) == ["topic-rag", "topic-agents"]
    store.delete_area(custom.id)
    with pytest.raises(NotFound):
        store.get_area(custom.id)

    # Opened event updates recently_active
    store.record_opened("area-ai")
    store.record_opened("topic-rag")
    assert list(directory.recently_active(limit=5))[:2] == ["topic-rag", "area-ai"]

    # Read marks on materials and findings, and moving finding mark to material
    from skaz.knowledge.markdown.source import FragmentInput, Origin

    folder_id = ready.folders()[0].id
    mat_files = ready.create_material(
        folder_id,
        "RAG Paper",
        "pdf",
        [FragmentInput(text="Paragraph 1")],
        origin=Origin(type="url", url="https://example.org/rag", topic_ids=["topic-rag"]),  # type: ignore[call-arg]
    )
    mat_id = mat_files.manifest.id

    assert list(directory.materials("area-ai")) == [mat_id]
    assert list(directory.materials("domain-physical")) == [mat_id]

    mark0 = store.get_material_read_mark(mat_id)
    assert mark0.value is None and mark0.updated_at is None

    mark1 = store.set_material_read_mark(mat_id, KbReadMarkUpdate(value="useful_method"))
    assert mark1.value == "useful_method"
    assert directory.read_marks([mat_id]) == {mat_id: "useful_method"}

    mark2 = store.set_material_read_mark(mat_id, KbReadMarkUpdate(value="changed_my_view"))
    assert mark2.value == "changed_my_view"

    removed = store.remove_material_read_mark(mat_id)
    assert removed.value is None
    assert directory.read_marks([mat_id]) == {}

    # Finding mark -> move to material (open question 5)
    f_mark = store.set_finding_read_mark("finding-1", KbReadMarkUpdate(value="already_knew"))
    assert f_mark.finding_id == "finding-1"
    assert f_mark.value == "already_knew"
    moved = store.move_finding_mark_to_material("finding-1", mat_id)
    assert moved is not None
    assert moved.material_id == mat_id
    assert moved.value == "already_knew"
    assert store.get_material_read_mark(mat_id).value == "already_knew"

    # Signals recorded superseding chain for read marks
    all_signals = signals.list_signals(limit=20).signals
    mat_signals = [s for s in all_signals if s.object.kind == "material" and s.object.id == mat_id]
    assert len(mat_signals) >= 3
    assert mat_signals[0].supersedes_id == mat_signals[1].id
    assert mat_signals[1].supersedes_id == mat_signals[2].id


async def test_edge_cases_science_stop_hidden_undecided_and_pagination(
    ready: KnowledgeService,
) -> None:
    from collections.abc import Sequence

    from skaz.knowledge.api.schemas_explore import KbFinding
    from skaz.knowledge.api.schemas_explore_common import KbPublicationDate
    from skaz.knowledge.api.schemas_science import KbPaidAccess, KbScienceWork
    from skaz.knowledge.decisions.protocol import Answer, Question, Undecided
    from skaz.knowledge.markdown.page import Block, PageDocument, PageMeta
    from skaz.knowledge.markdown.source import FragmentInput, Origin
    from skaz.knowledge.science.protocols import ScienceConsentRequired, TaxonomyNode

    folder_id = ready.folders()[0].id
    m1 = ready.create_material(
        folder_id,
        "Material One",
        "text",
        [FragmentInput(text="First material text.")],
        origin=Origin(type="paste", topic_ids=["T-1"]),  # type: ignore[call-arg]
    ).manifest.id
    m2 = ready.create_material(
        folder_id,
        "Material Two",
        "text",
        [FragmentInput(text="Second material text.")],
        origin=Origin(type="paste", topic_ids=["T-1"]),  # type: ignore[call-arg]
    ).manifest.id

    ready.create_page(
        PageDocument(
            meta=PageMeta(
                skaz_id="page-unplaced",
                kind="concept",
                title="Unplaced concept",
            ),
            parts=[Block.create("c-1", "from_source", "Some unplaced statement.")],
        )
    )

    class ConsentBlockedScience:
        def __init__(self) -> None:
            self.blocked = False

        async def taxonomy(self, parent_id: str | None = None) -> Sequence[TaxonomyNode]:
            if self.blocked:
                raise ScienceConsentRequired()
            if parent_id is None:
                return [
                    TaxonomyNode("dom-1", None, "domain", "Domain One", 1),
                    TaxonomyNode("dom-2", None, "domain", "Domain Two", 1),
                ]
            return [TaxonomyNode("T-1", "dom-1", "topic", "Topic One", 0)]

    class UndecidedLayer:
        @property
        def id(self) -> str:
            return "local"

        async def ask(self, question: Question) -> Answer:
            return Undecided("model not confident")

        async def ask_many(self, questions: Sequence[Question]) -> Sequence[Answer]:
            return [Undecided("model not confident") for _ in questions]

    class FakeExploreWithImportedFinding:
        async def finding(self, finding_id: str) -> KbFinding:
            if finding_id != "finding-imported":
                raise NotFound("Finding not found")
            pub = KbPublicationDate(
                year=2026, date=None, precision="year", origin="openalex", evidence_url=None
            )
            access = KbPaidAccess(
                paid=False,
                alternatives_checked=True,
                free_alternative_ids=[],
                suggestion_shown_at=None,
                recommendation=None,
                publisher_url=None,
            )
            work = KbScienceWork(
                id="w-1",
                provider="openalex",
                provider_id="W1",
                doi=None,
                arxiv_id=None,
                title="Work 1",
                authors=["A"],
                publication=pub,
                venue=None,
                publication_type="article",
                abstract="Abstract",
                topic_ids=["T-1"],
                referenced_ids=[],
                cited_by_count=0,
                locations=[],
                access=access,
            )
            return KbFinding(
                id="finding-imported",
                run_id="run-1",
                task_id=None,
                area_id="T-1",
                channel="search",
                label="new",
                work=work,
                area_path=["Domain One", "Topic One"],
                reason="Reason",
                wiki_refs=[],
                theses=[],
                cites_materials=[],
                shared_source_count=0,
                repeat_hint=None,
                read_mark=None,
                material_id=m1,
                text_available="full_text",
                created_at="2026-11-09T10:00:00Z",  # type: ignore[arg-type]
            )

    science = ConsentBlockedScience()
    service = ExploreAreasService(
        ready,
        science=science,  # type: ignore[arg-type]
        decisions=UndecidedLayer(),  # type: ignore[arg-type]
        explore=FakeExploreWithImportedFinding(),  # type: ignore[arg-type]
    )

    # EX2: own topics; the map never asks the science client or the decision model.
    one = await service.create(KbAreaCreate(name="Topic One"))
    two = await service.create(KbAreaCreate(name="Topic Two"))
    science.blocked = True
    m_initial = await service.map()
    assert {a.id for a in m_initial.areas} == {one.id, two.id}
    assert sum(a.pages for a in m_initial.areas) == 0

    # Hide two: hidden by default, shown with include_hidden=True
    await service.update(two.id, KbAreaUpdate(hidden=True, pinned=True))
    m_visible = await service.map(include_hidden=False)
    assert [a.id for a in m_visible.areas] == [one.id]
    m_all = await service.map(include_hidden=True)
    assert {a.id for a in m_all.areas} == {one.id, two.id}
    assert two.id not in service.pinned()
    service.topic_store.label(m1, one.id, "agent")
    service.topic_store.label(m2, one.id, "agent")

    # Materials pagination
    page1 = await service.materials(one.id, limit=1)
    assert len(page1.materials) == 1
    assert page1.next_cursor is not None
    page2 = await service.materials(one.id, cursor=page1.next_cursor, limit=1)
    assert len(page2.materials) == 1
    assert page2.next_cursor is None
    assert {page1.materials[0].material_id, page2.materials[0].material_id} == {m1, m2}

    # Setting a mark on a finding already imported to wiki moves the mark to its material (open question 5)
    mark = await service.set_finding_mark("finding-imported", KbReadMarkUpdate(value="useful_method"))
    assert mark.material_id == m1
    assert mark.value == "useful_method"
    assert (await service.read_mark(m1)).value == "useful_method"

    # Missing material / area raises NotFound (404)
    with pytest.raises(NotFound):
        await service.read_mark("missing-material")
    with pytest.raises(NotFound):
        await service.materials("missing-area")
    with pytest.raises(NotFound):
        await service.map(parent_id="missing-area")


async def test_runtime_wires_kb_areas_in_real_app(kb_client: object, kb_app: object) -> None:
    import httpx

    client = kb_client
    assert isinstance(client, httpx.AsyncClient)
    runtime = kb_app.state.runtime  # type: ignore[attr-defined]
    assert getattr(runtime, "kb_areas", None) is not None
    # The wiring hands over the decider itself (None while none is chosen), not the ``layer`` method.
    assert runtime.kb_areas._decisions() is None
    assert runtime.kb_areas.directory is not None and runtime.kb_areas.recorder is not None

    # No library yet: not_ready, not an empty map that looks like a result.
    res = await client.get("/kb/explore/map")
    assert res.status_code == 503
    assert res.json() == {"code": "not_ready"}

    runtime.kb.connect(None)
    # EX2: the map is the user's own topics from stored state; it never needs OpenAlex consent.
    res = await client.get("/kb/explore/map")
    assert res.status_code == 200 and res.json()["areas"] == []

    res = await client.post(
        "/kb/explore/areas",
        json={"name": "Runtime Custom Area", "topic_ids": ["T-runtime"]},
    )
    assert res.status_code == 200
    area_id = res.json()["id"]

    res = await client.post(f"/kb/explore/areas/{area_id}/opened")
    assert res.status_code == 200
    assert res.json() == {"ok": True}

    res = await client.get("/kb/explore/signals")
    assert res.status_code == 200
    signals = res.json()["signals"]
    assert any(s["predicate"] == "area_opened" and s["object"]["id"] == area_id for s in signals)


def test_a_parent_area_scope_is_its_own_hierarchy_id(ready: KnowledgeService) -> None:
    """Review R1-05: the same scope before and after one child is expanded."""
    from skaz.knowledge.science.protocols import TaxonomyNode

    store = AreasStore(ready, SignalStore(ready.db))
    store.sync_taxonomy_nodes(None, [TaxonomyNode("domains-3", None, "domain", "Physical Sciences", 2)])
    assert list(store.topics("domains-3")) == ["domains-3"]
    store.sync_taxonomy_nodes("domains-3", [TaxonomyNode("fields-17", "domains-3", "field", "CS", 1)])
    store.sync_taxonomy_nodes("fields-17", [TaxonomyNode("subfields-1702", "fields-17", "subfield", "AI", 1)])
    store.sync_taxonomy_nodes("subfields-1702", [TaxonomyNode("T10181", "subfields-1702", "topic", "RAG", 0)])
    assert list(store.topics("domains-3")) == ["domains-3"]
    assert list(store.topics("subfields-1702")) == ["subfields-1702"]
    assert list(store.topics("T10181")) == ["T10181"]


async def test_own_topic_materials_carry_repeats_freshness_dates_and_routes_work(
    ready: KnowledgeService,
) -> None:
    """EX2 port of the B4 map test: a topic's materials (subtopics included) and the area routes."""
    from collections.abc import Mapping, Sequence

    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from skaz.knowledge.api import areas as areas_router
    from skaz.knowledge.api.schemas_explore_common import KbMaterialRef, KbPublicationDate
    from skaz.knowledge.api.schemas_repeats import KbMaterialRepeats
    from skaz.knowledge.markdown.page import Block, Cite, PageDocument, PageMeta
    from skaz.knowledge.markdown.source import FragmentInput

    folder_id = ready.folders()[0].id
    ids = []
    for title in ("RAG beyond the basics", "Reflexion Agents", "Hallucination survey"):
        mid = ready.create_material(folder_id, title, "pdf", [FragmentInput(text="Text.")]).manifest.id
        ready.create_page(
            PageDocument(
                meta=PageMeta(
                    skaz_id=f"page-{mid}", kind="concept", title=f"{title} concept", sources=(mid,)
                ),
                parts=[
                    Block.create("c-1", "from_source", "A statement.", cites=(Cite(material_id=mid, seg=1),))
                ],
            )
        )
        ids.append(mid)
    m_rag, m_agents, m_fact = ids
    ready.create_page(
        PageDocument(  # a study deck never counts on the map
            meta=PageMeta(skaz_id="deck-1", kind="deck", title="RAG Deck", sources=(m_rag,)), parts=[]
        )
    )

    class Dates:
        def dates(self, material_ids: Sequence[str]) -> Mapping[str, KbPublicationDate]:
            return {
                mid: KbPublicationDate(
                    year=2026, date=date(2026, 10, 15), precision="day", origin="openalex", evidence_url=None
                )
                for mid in material_ids
                if mid == m_rag
            }

    class Repeats:
        def summaries(self, material_ids: Sequence[str]) -> Mapping[str, KbMaterialRepeats]:
            return {
                m_rag: KbMaterialRepeats(
                    material_id=m_rag,
                    status="checked",
                    percent=80,
                    repeated=4,
                    total=5,
                    from_materials=[KbMaterialRef(material_id=m_agents, title="Lecture 7")],
                    paragraphs=[],
                    checked_at=None,
                )
            }

    class Freshness:
        def mark_ids(self, material_ids: Sequence[str]) -> Mapping[str, Sequence[str]]:
            return {m_rag: ["mark-version"]} if m_rag in material_ids else {}

    service = ExploreAreasService(
        ready,
        publication_dates=Dates(),
        repeat_summaries=Repeats(),
        freshness_marks=Freshness(),
        finding_exists=lambda fid: fid == "finding-1",
        new_findings_by_area=lambda: {"x": 0},
    )
    ai = await service.create(KbAreaCreate(name="AI"))
    rag = await service.create(KbAreaCreate(name="RAG", parent_id=ai.id))
    service.topic_store.label(m_rag, rag.id, "agent")
    service.topic_store.label(m_agents, ai.id, "agent")
    service.topic_store.label(m_fact, rag.id, "agent")

    top = await service.map()
    assert top.total_pages == 3 and top.total_sources == 3  # the deck is not a wiki page
    (tile,) = top.areas
    assert (tile.materials, tile.pages, tile.newest_source_year, tile.wiki_share) == (3, 3, 2026, 1.0)
    await service.set_read_mark(m_rag, KbReadMarkUpdate(value="useful_method"))
    mats = await service.materials(ai.id)
    assert mats.not_checked_count == 2
    by_id = {m.material_id: m for m in mats.materials}
    assert set(by_id) == {m_rag, m_agents, m_fact}
    assert by_id[m_rag].repeats_source_titles == ["Lecture 7"] and by_id[m_rag].freshness_mark_ids == [
        "mark-version"
    ]
    assert by_id[m_rag].read_mark == "useful_method" and by_id[m_rag].publication.year == 2026
    assert [m.material_id for m in (await service.materials(rag.id)).materials] == [m_fact, m_rag]

    app = FastAPI()
    app.include_router(areas_router.router)
    app.state.kb_areas = service
    with TestClient(app) as client:
        assert client.get("/kb/explore/map").json()["total_pages"] == 3
        res = client.patch(f"/kb/explore/areas/{rag.id}", json={"name": "Retrieval", "pinned": True})
        assert (res.status_code, res.json()["name"], res.json()["pinned"]) == (200, "Retrieval", True)
        assert client.post(f"/kb/explore/areas/{rag.id}/opened").json() == {"ok": True}
        res = client.put(f"/kb/materials/{m_agents}/topic", json={"area_id": rag.id})
        assert res.json() == {"material_id": m_agents, "area_id": rag.id, "origin": "user"}
        res = client.post(f"/kb/explore/areas/{rag.id}/merge", json={"into_id": ai.id})
        assert (res.status_code, res.json()["id"], res.json()["materials"]) == (200, ai.id, 3)
        assert (
            client.put("/kb/explore/findings/finding-1/read-mark", json={"value": "already_knew"}).status_code
            == 200
        )
        res = client.put("/kb/explore/findings/missing-finding/read-mark", json={"value": "already_knew"})
        assert (res.status_code, res.json()) == (404, {"code": "not_found"})
        assert client.delete(f"/kb/explore/areas/{ai.id}").json() == {"ok": True}
        assert len(client.get("/kb/explore/signals").json()["signals"]) >= 3
