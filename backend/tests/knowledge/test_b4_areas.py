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
    AreasService,
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
    assert list(directory.topics("area-ai")) == ["topic-rag", "topic-agents"]
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
    assert custom.topic_ids == ["topic-rag", "topic-agents"]
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
    mat_signals = [
        s for s in all_signals if s.object.kind == "material" and s.object.id == mat_id
    ]
    assert len(mat_signals) >= 3
    assert mat_signals[0].supersedes_id == mat_signals[1].id
    assert mat_signals[1].supersedes_id == mat_signals[2].id


async def test_areas_service_map_decision_placement_and_protocols(ready: KnowledgeService) -> None:
    from collections.abc import Mapping, Sequence

    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from skaz.knowledge.api import areas as areas_router
    from skaz.knowledge.api.schemas_explore_common import KbMaterialRef, KbPublicationDate
    from skaz.knowledge.api.schemas_repeats import KbMaterialRepeats
    from skaz.knowledge.decisions.protocol import (
        Answer,
        ChoiceAnswer,
        ChoiceQuestion,
        DeciderId,
        Question,
    )
    from skaz.knowledge.markdown.page import Block, Cite, PageDocument, PageMeta
    from skaz.knowledge.markdown.source import FragmentInput, Origin
    from skaz.knowledge.science.protocols import TaxonomyNode

    # Create materials & wiki pages (plus a study deck page that must be excluded from the map!)
    folder_id = ready.folders()[0].id
    m_rag = ready.create_material(
        folder_id,
        "RAG beyond the basics",
        "web",
        [FragmentInput(text="Retrieval-augmented generation grounds claims.")],
        origin=Origin(type="url", url="https://example.org/rag"),
    ).manifest.id
    m_agents = ready.create_material(
        folder_id,
        "Reflexion Agents",
        "pdf",
        [FragmentInput(text="Agents use tools and self-reflection.")],
        origin=Origin(type="url", url="https://example.org/agents", topic_ids=["topic-agents"]),  # type: ignore[call-arg]
    ).manifest.id
    m_fact = ready.create_material(
        folder_id,
        "Hallucination survey",
        "pdf",
        [FragmentInput(text="Factuality in language models.")],
        origin=Origin(type="url", url="https://example.org/fact", topic_ids=["topic-fact"]),  # type: ignore[call-arg]
    ).manifest.id

    ready.create_page(
        PageDocument(
            meta=PageMeta(
                skaz_id="page-rag",
                kind="concept",
                title="Retrieval-augmented generation",
                sources=(m_rag,),
            ),
            parts=[
                Block.create(
                    "c-1",
                    "from_source",
                    "RAG combines retrieval with generation.",
                    cites=(Cite(material_id=m_rag, seg=1),),
                ),
            ],
        )
    )
    ready.create_page(
        PageDocument(
            meta=PageMeta(
                skaz_id="page-agents",
                kind="concept",
                title="LLM agents",
                sources=(m_agents,),
            ),
            parts=[
                Block.create(
                    "c-1",
                    "from_source",
                    "Agents call tools.",
                    cites=(Cite(material_id=m_agents, seg=1),),
                ),
            ],
        )
    )
    ready.create_page(
        PageDocument(
            meta=PageMeta(
                skaz_id="page-fact",
                kind="concept",
                title="Factuality",
                sources=(m_fact,),
            ),
            parts=[
                Block.create(
                    "c-1",
                    "from_source",
                    "Factuality checks.",
                    cites=(Cite(material_id=m_fact, seg=1),),
                ),
            ],
        )
    )
    # Study deck page: must NOT count in total_pages or area pages
    ready.create_page(
        PageDocument(
            meta=PageMeta(
                skaz_id="deck-1",
                kind="deck",
                title="RAG Deck",
                sources=(m_rag,),
            ),
            parts=[],
        )
    )

    class FakeScience:
        def __init__(self) -> None:
            self.tree: dict[str | None, list[TaxonomyNode]] = {
                None: [
                    TaxonomyNode("domain-physical", None, "domain", "Physical Sciences", 2),
                    TaxonomyNode("domain-social", None, "domain", "Social Sciences", 1),
                ],
                "domain-physical": [
                    TaxonomyNode("field-cs", "domain-physical", "field", "Computer Science", 1),
                ],
                "field-cs": [
                    TaxonomyNode("area-ai", "field-cs", "subfield", "Artificial Intelligence", 4),
                ],
                "area-ai": [
                    TaxonomyNode("topic-rag", "area-ai", "topic", "Retrieval-augmented generation", 0),
                    TaxonomyNode("topic-agents", "area-ai", "topic", "LLM agents and tool use", 0),
                    TaxonomyNode("topic-fact", "area-ai", "topic", "Factuality and hallucination", 0),
                    TaxonomyNode("topic-verify", "area-ai", "topic", "Self-correction and verification", 0),
                ],
            }

        async def taxonomy(self, parent_id: str | None = None) -> Sequence[TaxonomyNode]:
            return self.tree.get(parent_id, [])

    class FakeDecisionLayer:
        @property
        def id(self) -> DeciderId:
            return "local"

        async def ask(self, question: Question) -> Answer:
            assert isinstance(question, ChoiceQuestion)
            assert "<untrusted-data" in question.state
            for opt in (
                "Retrieval-augmented generation",
                "Artificial Intelligence",
                "Computer Science",
                "Physical Sciences",
            ):
                if opt in question.options:
                    return ChoiceAnswer(option=opt, probabilities={opt: 0.95}, confidence=0.95)
            return ChoiceAnswer(
                option=question.options[0],
                probabilities={question.options[0]: 0.9},
                confidence=0.9,
            )

        async def ask_many(self, questions: Sequence[Question]) -> Sequence[Answer]:
            return [await self.ask(q) for q in questions]

    class FakePublicationDates:
        def dates(self, material_ids: Sequence[str]) -> Mapping[str, KbPublicationDate]:
            out: dict[str, KbPublicationDate] = {}
            for mid in material_ids:
                if mid in (m_rag, m_agents):
                    out[mid] = KbPublicationDate(
                        year=2026,
                        date=date(2026, 10, 15),
                        precision="day",
                        origin="openalex",
                        evidence_url="https://example.org/pub",
                    )
                elif mid == m_fact:
                    out[mid] = KbPublicationDate(
                        year=2023,
                        date=None,
                        precision="year",
                        origin="crossref",
                        evidence_url=None,
                    )
            return out

    class FakeRepeatSummaries:
        def summaries(self, material_ids: Sequence[str]) -> Mapping[str, KbMaterialRepeats]:
            out: dict[str, KbMaterialRepeats] = {}
            if m_rag in material_ids:
                out[m_rag] = KbMaterialRepeats(
                    material_id=m_rag,
                    status="checked",
                    percent=80,
                    repeated=4,
                    total=5,
                    from_materials=[KbMaterialRef(material_id=m_agents, title="Lecture 7")],
                    paragraphs=[],
                    checked_at=None,
                )
            return out

    class FakeFreshnessMarks:
        def mark_ids(self, material_ids: Sequence[str]) -> Mapping[str, Sequence[str]]:
            return {m_rag: ["mark-version"]} if m_rag in material_ids else {}

    known_findings = {"finding-1"}
    service: AreasService = ExploreAreasService(
        ready,
        science=FakeScience(),  # type: ignore[arg-type]
        decisions=FakeDecisionLayer(),
        publication_dates=FakePublicationDates(),
        repeat_summaries=FakeRepeatSummaries(),
        freshness_marks=FakeFreshnessMarks(),
        finding_exists=lambda fid: fid in known_findings,
        new_findings_by_area=lambda: {"topic-rag": 2, "topic-fact": 1},
    )

    # 1. Top level map (domains)
    top_map = await service.map()
    assert top_map.parent_id is None
    assert top_map.breadcrumbs == []
    assert top_map.total_pages == 3  # study deck excluded!
    assert top_map.total_sources == 3
    assert [a.id for a in top_map.areas] == ["domain-physical", "domain-social"]

    # 2. Drill down: domain -> field -> subfield -> topic (one level at a time)
    phys_map = await service.map(parent_id="domain-physical")
    assert [b.id for b in phys_map.breadcrumbs] == ["domain-physical"]
    assert [a.id for a in phys_map.areas] == ["field-cs"]

    cs_map = await service.map(parent_id="field-cs")
    assert [b.id for b in cs_map.breadcrumbs] == ["domain-physical", "field-cs"]
    assert [a.id for a in cs_map.areas] == ["area-ai"]

    ai_map = await service.map(parent_id="area-ai")
    assert [b.id for b in ai_map.breadcrumbs] == ["domain-physical", "field-cs", "area-ai"]
    ai_topics = {a.id: a for a in ai_map.areas}
    assert set(ai_topics) == {"topic-rag", "topic-agents", "topic-fact", "topic-verify"}
    assert ai_topics["topic-rag"].pages == 1
    assert ai_topics["topic-rag"].sources == 1
    assert ai_topics["topic-rag"].newest_source_year == 2026
    assert ai_topics["topic-rag"].new_findings == 2
    assert ai_topics["topic-verify"].pages == 0
    assert ai_topics["topic-verify"].depth == "empty"
    assert ai_topics["topic-verify"].gap_reason is not None
    assert "no pages yet" in ai_topics["topic-verify"].gap_reason
    assert ai_topics["topic-fact"].depth == "thin"
    assert ai_topics["topic-fact"].gap_reason == "thin · 1 source, 2023"

    # Worth closing on parent map includes deep gaps & thin areas
    top_map_after = await service.map()
    closing_ids = [a.id for a in top_map_after.worth_closing]
    assert "topic-verify" in closing_ids
    assert "topic-fact" in closing_ids

    # 3. Materials in area-ai use RepeatSummaries, FreshnessMarkReader, PublicationDates
    await service.set_read_mark(m_rag, KbReadMarkUpdate(value="useful_method"))
    mats = await service.materials("area-ai")
    assert mats.not_checked_count == 2  # m_agents and m_fact are not_checked
    by_id = {m.material_id: m for m in mats.materials}
    assert by_id[m_rag].repeat_status == "checked"
    assert by_id[m_rag].repeated_percent == 80
    assert by_id[m_rag].repeats_source_titles == ["Lecture 7"]
    assert by_id[m_rag].freshness_mark_ids == ["mark-version"]
    assert by_id[m_rag].read_mark == "useful_method"
    assert by_id[m_rag].publication.year == 2026
    assert by_id[m_agents].repeat_status == "not_checked"

    # 4. Route integration via FastAPI TestClient
    app = FastAPI()
    app.include_router(areas_router.router)
    app.state.kb_areas = service

    with TestClient(app) as client:
        res = client.get("/kb/explore/map")
        assert res.status_code == 200
        assert res.json()["total_pages"] == 3

        res = client.post(
            "/kb/explore/areas",
            json={"name": "Custom RAG", "topic_ids": ["topic-rag"]},
        )
        assert res.status_code == 200
        custom_id = res.json()["id"]
        assert res.json()["pages"] == 1

        res = client.patch(
            f"/kb/explore/areas/{custom_id}",
            json={"name": "Renamed Custom", "pinned": True},
        )
        assert res.status_code == 200
        assert res.json()["name"] == "Renamed Custom"
        assert res.json()["pinned"] is True

        res = client.post(f"/kb/explore/areas/{custom_id}/opened")
        assert res.status_code == 200
        assert res.json() == {"ok": True}

        res = client.delete("/kb/explore/areas/topic-rag")
        assert res.status_code == 409
        assert res.json() == {"code": "conflict"}

        res = client.delete(f"/kb/explore/areas/{custom_id}")
        assert res.status_code == 200
        assert res.json() == {"ok": True}

        res = client.put(
            "/kb/explore/findings/finding-1/read-mark",
            json={"value": "already_knew"},
        )
        assert res.status_code == 200
        assert res.json()["value"] == "already_knew"

        res = client.put(
            "/kb/explore/findings/missing-finding/read-mark",
            json={"value": "already_knew"},
        )
        assert res.status_code == 404
        assert res.json() == {"code": "not_found"}

        res = client.delete("/kb/explore/findings/finding-1/read-mark")
        assert res.status_code == 200
        assert res.json()["value"] is None

        res = client.get("/kb/explore/signals")
        assert res.status_code == 200
        assert len(res.json()["signals"]) >= 4


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

    # Initial sync succeeds, UndecidedLayer does not guess placement for page-unplaced
    m_initial = await service.map()
    assert len(m_initial.areas) == 2
    assert sum(a.pages for a in m_initial.areas) == 0

    await service.map(parent_id="dom-1")

    # Hide dom-2: hidden by default, shown with include_hidden=True
    await service.update("dom-2", KbAreaUpdate(hidden=True, pinned=True))
    m_visible = await service.map(include_hidden=False)
    assert [a.id for a in m_visible.areas] == ["dom-1"]
    m_all = await service.map(include_hidden=True)
    assert [a.id for a in m_all.areas] == ["dom-1", "dom-2"]
    assert "dom-2" not in service.pinned()

    # ScienceStop does not crash map(); cached areas still served
    science.blocked = True
    m_blocked = await service.map()
    assert [a.id for a in m_blocked.areas] == ["dom-1"]

    # Materials pagination
    page1 = await service.materials("T-1", limit=1)
    assert len(page1.materials) == 1
    assert page1.next_cursor is not None
    page2 = await service.materials("T-1", cursor=page1.next_cursor, limit=1)
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
    # Science integration off and no level loaded yet: the honest reason, not an empty map (review R1-08).
    res = await client.get("/kb/explore/map")
    assert (res.status_code, res.json()) == (403, {"code": "consent_required"})

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


async def test_placement_never_asks_again_about_off_topic_pages_and_caps_each_call(
    ready: KnowledgeService,
) -> None:
    """Decision cost: a page the model called off-topic is not asked again; one call asks at most 30."""
    from collections.abc import Sequence

    from skaz.knowledge.areas.service import OFF_TOPIC_OPTION
    from skaz.knowledge.decisions.protocol import Answer, ChoiceAnswer, Question
    from skaz.knowledge.markdown.page import Block, PageDocument, PageMeta
    from skaz.knowledge.science.protocols import TaxonomyNode

    for index in range(35):
        ready.create_page(
            PageDocument(
                meta=PageMeta(skaz_id=f"page-{index:02d}", kind="concept", title=f"Concept {index:02d}"),
                parts=[Block.create(f"c-{index}", "from_source", "A statement.")],
            )
        )

    class Science:
        async def taxonomy(self, parent_id: str | None = None) -> Sequence[TaxonomyNode]:
            return [TaxonomyNode("dom-1", None, "domain", "Domain One", 0)] if parent_id is None else []

    class Layer:
        def __init__(self) -> None:
            self.asked: list[str] = []

        @property
        def id(self) -> str:
            return "local"

        async def ask(self, question: Question) -> Answer:
            self.asked.append(question.state)
            return ChoiceAnswer(option=OFF_TOPIC_OPTION, probabilities={}, confidence=0.9)

        async def ask_many(self, questions: Sequence[Question]) -> Sequence[Answer]:
            return [await self.ask(q) for q in questions]

    layer = Layer()
    service = ExploreAreasService(ready, science=Science(), decisions=layer)  # type: ignore[arg-type]

    await service.map()
    assert len(layer.asked) == 30  # one call never asks more than a batch
    await service.map()
    assert len(layer.asked) == 35  # the 30 off-topic answers are kept; only the 5 left are asked
    await service.map()
    assert len(layer.asked) == 35  # nothing is asked twice


async def test_a_map_level_that_cannot_load_answers_its_honest_reason(ready: KnowledgeService) -> None:
    """Review R1-08: consent, the day limit and a provider failure are not an empty map."""
    from collections.abc import Sequence
    from datetime import UTC, datetime

    from skaz.knowledge.science.protocols import (
        ScienceConsentRequired,
        ScienceDailyLimit,
        ScienceUnavailable,
        TaxonomyNode,
    )

    class StoppedScience:
        def __init__(self, stop: Exception) -> None:
            self.stop = stop

        async def taxonomy(self, parent_id: str | None = None) -> Sequence[TaxonomyNode]:
            raise self.stop

    cases = [
        (ScienceConsentRequired(), 403, "consent_required"),
        (ScienceDailyLimit(datetime(2026, 11, 11, tzinfo=UTC)), 429, "openalex_daily_limit"),
        (ScienceUnavailable(), 502, "provider_unavailable"),
    ]
    for stop, status, code in cases:
        service = ExploreAreasService(ready, science=StoppedScience(stop))  # type: ignore[arg-type]
        with pytest.raises(ContractFailure) as caught:
            await service.map()
        assert (caught.value.status, caught.value.code) == (status, code)

    unwired = ExploreAreasService(ready, science=lambda: None)
    with pytest.raises(ContractFailure) as caught:
        await unwired.map()
    assert (caught.value.status, caught.value.code) == (503, "not_ready")

    class Nested:  # a dependency is taken as given, never guessed from its attributes
        client = StoppedScience(ScienceUnavailable())

    nested = ExploreAreasService(ready, science=Nested())  # type: ignore[arg-type]
    with pytest.raises((ContractFailure, AttributeError)):
        await nested.map()
