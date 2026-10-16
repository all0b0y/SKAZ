"""Library scope contract at HTTP boundary; vectors are authored fixtures."""

import httpx
import pytest

from tests.conftest import FakeHttp
from tests.test_agent_ask import add_transcript, prompt_text, stub_answer
from tests.test_ask_embeddings import embedding_inputs, setup


async def corpus(client: httpx.AsyncClient, outbound: FakeHttp) -> tuple[str, str, str]:
    current = await setup(client, outbound)
    others = []
    for text in ("GROUP_EVIDENCE энтропия", "OUTSIDE_EVIDENCE энтропия"):
        sid = (await client.post("/sessions", json={"title": text})).json()["id"]
        await add_transcript(client, outbound, sid, 0, 0, text)
        others.append(sid)
    stub_answer(outbound, "Источник [P1].")
    return current, others[0], others[1]


@pytest.mark.parametrize("scope,expected", [("session", 2), ("group", 3), ("all", 4)])
async def test_scope_isolates_sources_and_queries_once(
    client: httpx.AsyncClient, outbound: FakeHttp, scope: str, expected: int
) -> None:
    current, sibling, _outside = await corpus(client, outbound)
    body: dict[str, object] = {"question": "энтропия", "search_scope": scope}
    if scope == "group":
        body["group_session_ids"] = [current, sibling]
    stub_answer(outbound, "Источник [P1].")
    response = await client.post(f"/sessions/{current}/ask", json=body)
    assert response.status_code == 200, response.text
    assert response.json()["context"]["source_count"] == expected
    assert response.json()["context"]["search_scope"] == scope
    sent = str(embedding_inputs(outbound)) + prompt_text(outbound)
    assert ("GROUP_EVIDENCE" in sent) == (scope != "session")
    assert ("OUTSIDE_EVIDENCE" in sent) == (scope == "all")
    assert sum("Query:" in text for batch in embedding_inputs(outbound) for text in batch) == 1
    citations = response.json()["citations"]
    assert citations and citations[0]["session_id"]
    assert citations[0]["session_title"]
    saved = (await client.get(f"/sessions/{current}")).json()["messages"][-1]
    assert saved["citations"] == citations


async def test_group_without_membership_refuses_without_transmission(
    client: httpx.AsyncClient, outbound: FakeHttp
) -> None:
    current = await setup(client, outbound)
    before = len(outbound.requests)
    response = await client.post(
        f"/sessions/{current}/ask",
        json={
            "question": "Тема?",
            "search_scope": "group",
        },
    )
    assert response.status_code == 400
    assert not any(r.method == "POST" for r in outbound.requests[before:])


async def test_scope_budget_is_combined_before_first_upload(
    client: httpx.AsyncClient,
    outbound: FakeHttp,
) -> None:
    current, _, _ = await corpus(client, outbound)
    await client.put("/settings", json={"embedding_budget_usd": 0.0003})
    response = await client.post(
        f"/sessions/{current}/ask",
        json={
            "question": "Тема?",
            "search_scope": "all",
        },
    )
    assert response.status_code == 400
    assert not embedding_inputs(outbound)


async def test_invalid_group_snapshot_refuses(client: httpx.AsyncClient, outbound: FakeHttp) -> None:
    current = await setup(client, outbound)
    response = await client.post(
        f"/sessions/{current}/ask",
        json={
            "question": "Тема?",
            "search_scope": "group",
            "group_session_ids": [current, "missing"],
        },
    )
    assert response.status_code == 400
    assert not embedding_inputs(outbound)
