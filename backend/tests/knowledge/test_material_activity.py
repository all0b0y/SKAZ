"""E4: durable, library-scoped usage and nonempty manual topics; no providers."""
from datetime import UTC, datetime, timedelta

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from skaz.knowledge.api.contract_routes import ContractFailure
from skaz.knowledge.errors import NotFound
from skaz.knowledge.service import KnowledgeService

NOW = datetime(2026, 11, 12, tzinfo=UTC)


def paper(kb: KnowledgeService, days: int = 30, folder: str | None = None) -> str:
    folder = folder or kb.explore_folder().id
    files = kb.create_material(folder, f"Paper {len(kb.materials())}", "text", [])
    # Persist the historical timestamp in files as a scan must see it too.
    import json

    from skaz.knowledge.library.layout import MATERIAL_MANIFEST
    path = files.directory / MATERIAL_MANIFEST
    data = json.loads(path.read_text())
    data["created_at"] = (NOW - timedelta(days=days)).isoformat()
    path.write_text(json.dumps(data))
    kb.rescan()
    return files.manifest.id


def activity(kb: KnowledgeService):  # type: ignore[no-untyped-def]
    from skaz.knowledge.library.activity import MaterialActivity
    return MaterialActivity(kb, clock=lambda: NOW)


def test_unused_boundary_open_keep_and_rescan(ready: KnowledgeService) -> None:
    old = paper(ready)
    paper(ready, 29)
    paper(ready, 40, "fld-inbox")
    store = activity(ready)
    assert store.unused().material_ids == [old]
    store.opened(old)
    ready.rescan()
    assert store.unused().material_ids == []
    future = NOW + timedelta(days=30)
    store.clock = lambda: future
    assert old in store.unused().material_ids
    store.keep([old])
    ready.rescan()
    assert old not in store.unused().material_ids
    store.clock = lambda: future + timedelta(days=30)
    assert old in store.unused().material_ids


def test_wiki_sources_and_active_jobs_are_never_offered_for_removal(ready: KnowledgeService) -> None:
    mid = paper(ready, 40)
    with ready.db.write() as conn:
        conn.execute("INSERT INTO jobs(id,kind,target_id,state,created_at,updated_at) "
                     "VALUES ('job','ingest',?,'queued','now','now')", (mid,))
    assert activity(ready).unused().material_ids == []
    with ready.db.write() as conn:
        conn.execute("DELETE FROM jobs")
        conn.execute("INSERT INTO pages VALUES ('p','concept','Concept','Wiki/p.md',NULL,'en','x','now')")
        conn.execute("INSERT INTO page_sources VALUES ('p',?)", (mid,))
    assert activity(ready).unused().material_ids == []


def test_new_topic_is_atomic_and_manual_label_survives_agent_sort(ready: KnowledgeService) -> None:
    from skaz.knowledge.api.schemas_material_activity import KbMaterialTopicCreate
    from skaz.knowledge.areas.topics import TopicStore
    store = activity(ready)
    mid = paper(ready)
    result = store.new_topic(mid, KbMaterialTopicCreate(name="My topic"))
    topics = TopicStore(ready)
    assert result.origin == "user"
    other = topics.create("Other", None)
    assert not topics.label(mid, other, "agent")
    assert topics.material_topic(mid).area_id == result.area_id
    with pytest.raises(NotFound):
        store.new_topic("missing", KbMaterialTopicCreate(name="No orphan"))
    assert [t.name for t in topics.topics()] == ["My topic", "Other"]


def test_activity_routes_fail_closed_and_validate_without_echoing() -> None:
    from skaz.knowledge.api.material_activity import router
    app = FastAPI()
    app.include_router(router)
    with TestClient(app) as client:
        for method, url, body in [
            ("GET", "/kb/materials-activity/explore-unused", None),
            ("POST", "/kb/materials-activity/explore-unused/keep", {"material_ids": ["m"]}),
            ("POST", "/kb/materials/m/opened", None),
            ("POST", "/kb/materials/m/new-topic", {"name": "Topic"}),
        ]:
            response = client.request(method, url, json=body)
            assert response.status_code == 503
            assert response.json() == {"code": "not_ready"}


def test_new_topic_failure_rolls_back_and_validates_two_level_parent(ready: KnowledgeService) -> None:
    import sqlite3

    from skaz.knowledge.api.schemas_material_activity import KbMaterialTopicCreate
    from skaz.knowledge.areas.topics import TopicStore

    mid = paper(ready)
    topics = TopicStore(ready)
    parent = topics.create("Parent", None)
    child = topics.create("Child", parent)
    store = activity(ready)
    for body in (KbMaterialTopicCreate(name="Duplicate", parent_id=child),
                 KbMaterialTopicCreate(name="..."), KbMaterialTopicCreate(name="parent")):
        with pytest.raises(ContractFailure):
            store.new_topic(mid, body)
    with ready.db.write() as conn:
        conn.execute("CREATE TRIGGER reject_label BEFORE INSERT ON explore_area_materials "
                     "BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END")
    with pytest.raises(sqlite3.IntegrityError):
        store.new_topic(mid, KbMaterialTopicCreate(name="Rolled back", parent_id=parent))
    assert [topic.name for topic in topics.topics()] == ["Parent", "Child"]


def test_keep_only_defers_the_requested_eligible_snapshot(ready: KnowledgeService) -> None:
    first = paper(ready, 60)
    second = paper(ready, 60)
    recent = paper(ready, 10)
    store = activity(ready)
    store.keep([first, recent, "missing"])
    assert store.unused().material_ids == [second]
    store.clock = lambda: NOW + timedelta(days=29, hours=23, minutes=59)
    assert first not in store.unused().material_ids
    store.clock = lambda: NOW + timedelta(days=30)
    assert first in store.unused().material_ids


def test_usage_survives_reopen_and_does_not_leak_to_another_library(ready: KnowledgeService) -> None:
    mid = paper(ready, 60)
    store = activity(ready)
    # A row belonging to another library must never change this one's eligibility.
    with ready.db.write() as conn:
        conn.execute("INSERT INTO material_activity VALUES ('other',?,?,?)",
                     (mid, NOW.isoformat(), (NOW + timedelta(days=30)).isoformat()))
    assert store.unused().material_ids == [mid]
    store.opened(mid)
    ready.rescan()
    assert activity(ready).unused().material_ids == []


async def test_ready_routes_use_real_local_service(kb_app: object, kb_client: object) -> None:
    from typing import Any, cast

    import httpx

    app = cast(Any, kb_app)
    client = cast(httpx.AsyncClient, kb_client)
    kb = app.state.runtime.kb
    kb.connect(None)
    mid = paper(kb, 60)
    app.state.runtime.kb_material_activity = activity(kb)
    result = await client.get('/kb/materials-activity/explore-unused')
    assert result.status_code == 200 and result.json() == {"material_ids": [mid]}
    result = await client.post(f'/kb/materials/{mid}/opened')
    assert result.status_code == 200
    assert (await client.get('/kb/materials-activity/explore-unused')).json() == {"material_ids": []}
    result = await client.post(f'/kb/materials/{mid}/new-topic', json={"name": "My topic"})
    assert result.status_code == 200 and result.json()['origin'] == 'user'
    result = await client.post(
        f'/kb/materials/{mid}/new-topic', json={"name": "PRIVATE", "secret": "PRIVATE"},
    )
    assert result.status_code == 422 and 'PRIVATE' not in result.text
