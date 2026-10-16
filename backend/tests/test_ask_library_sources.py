"""Cross-session search regressions against temporary SQLite and fake provider HTTP."""

import json
from typing import Any

import httpx

from tests.conftest import FakeHttp
from tests.test_agent_ask import prompt_text, stub_answer
from tests.test_ask_embeddings import embedding_inputs
from tests.test_ask_library_scope import corpus


async def test_managed_groups_override_client_snapshot_and_follow_moves(
    client: httpx.AsyncClient,
    outbound: FakeHttp,
    app: Any,
) -> None:
    current, sibling, outside = await corpus(client, outbound)
    layout: dict[str, Any] = {
        "version": 1,
        "groups": [{"id": "group-a", "name": "A", "tag": ""}],
        "membership": {current: "group-a", sibling: "group-a", outside: None},
    }
    with app.state.runtime.db.write() as connection:
        connection.execute("INSERT INTO physical_storage VALUES (1,0,?)", (json.dumps(layout),))
    body = {"question": "энтропия", "search_scope": "group", "group_session_ids": [current, outside]}
    result = await client.post(f"/sessions/{current}/ask", json=body)
    assert result.status_code == 200, result.text
    assert "GROUP_EVIDENCE" in prompt_text(outbound)
    assert "OUTSIDE_EVIDENCE" not in prompt_text(outbound)
    layout["membership"][sibling] = None
    layout["membership"][outside] = "group-a"
    with app.state.runtime.db.write() as connection:
        connection.execute("UPDATE physical_storage SET revision=1,doc=?", (json.dumps(layout),))
    outbound.requests.clear()
    result = await client.post(f"/sessions/{current}/ask", json=body)
    assert result.status_code == 200, result.text
    assert "OUTSIDE_EVIDENCE" in prompt_text(outbound)
    assert "GROUP_EVIDENCE" not in prompt_text(outbound)


async def test_all_cache_reuses_vectors_in_session_scope_and_returns_foreign_citations(
    client: httpx.AsyncClient,
    outbound: FakeHttp,
) -> None:
    current, sibling, outside = await corpus(client, outbound)
    stub_answer(outbound, "Все источники [P1-P4].")
    result = await client.post(
        f"/sessions/{current}/ask", json={"question": "энтропия", "search_scope": "all"}
    )
    assert result.status_code == 200, result.text
    assert {c["session_id"] for c in result.json()["citations"]} == {current, sibling, outside}
    assert sorted(label for c in result.json()["citations"] for label in c["labels"]) == [
        "P1",
        "P2",
        "P3",
        "P4",
    ]
    outbound.requests.clear()
    stub_answer(outbound, "Источник [P1].")
    result = await client.post(
        f"/sessions/{current}/ask", json={"question": "энтропия", "search_scope": "session"}
    )
    assert result.status_code == 200, result.text
    assert len(embedding_inputs(outbound)) == 1
    assert all(c["session_id"] == current for c in result.json()["citations"])


async def test_unconfigured_embedding_is_explicit_lexical_search(
    client: httpx.AsyncClient,
    outbound: FakeHttp,
) -> None:
    current, _, _ = await corpus(client, outbound)
    await client.put("/settings", json={"embedding": {"model": ""}})
    stub_answer(outbound, "Источник [P1].")
    result = await client.post(
        f"/sessions/{current}/ask", json={"question": "GROUP_EVIDENCE", "search_scope": "all"}
    )
    assert result.status_code == 200, result.text
    assert result.json()["context"]["retrieval"] == "lexical"
    assert "Только точный поиск" in result.json()["answer"]
    assert not embedding_inputs(outbound)
    assert "OUTSIDE_EVIDENCE" not in prompt_text(outbound)


async def test_empty_current_session_still_searches_other_sessions(
    client: httpx.AsyncClient,
    outbound: FakeHttp,
) -> None:
    await corpus(client, outbound)
    empty = (await client.post("/sessions", json={"title": "Empty"})).json()["id"]
    result = await client.post(f"/sessions/{empty}/ask", json={"question": "энтропия", "search_scope": "all"})
    assert result.status_code == 200, result.text
    assert result.json()["context"]["source_count"] == 4
    assert result.json()["context"]["session_count"] == 4
    assert result.json()["citations"][0]["session_id"] != empty
