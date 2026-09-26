"""Notes API transport contracts, not an evaluation of generated prose."""
from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from tests import test_notes_api as fixtures
from tests.conftest import FakeHttp, chat_completion

_catalog = fixtures._catalog
session = fixtures.session
add = fixtures.add
stub_notes = fixtures.stub_notes


@pytest.mark.parametrize("provider", ["openai", "anthropic"])
async def test_notes_continue_provider_truncation_before_saving(
    client: httpx.AsyncClient, session: str, outbound: FakeHttp, provider: str,
) -> None:
    await add(client, outbound, session, 0, "Definition, explanation and a distinct example.")
    await client.put("/settings", json={
        "provider_keys": {provider: "test-only"},
        "notes": {"provider": provider, "model": "fixture"},
    })
    bodies: list[dict[str, Any]] = []
    first = "# Topic\n\n" + "Detailed recorded explanation. " * 400 + "[P1]\n\n## Example\n"
    last = "The complete worked example and its qualification. [P1]"

    def reply(request: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(request.content))
        text = first if len(bodies) == 1 else last
        payload: dict[str, Any]
        if provider == "anthropic":
            payload = {"content": [{"type": "text", "text": text}],
                       "stop_reason": "max_tokens" if len(bodies) == 1 else "end_turn"}
        else:
            payload = chat_completion(text)
            payload["choices"][0]["finish_reason"] = "length" if len(bodies) == 1 else "stop"
        return httpx.Response(200, json=payload)

    outbound.routes[("POST", "api.anthropic.com/v1/messages" if provider == "anthropic"
                     else "chat/completions")] = reply
    response = await client.post(f"/sessions/{session}/notes", json={})
    assert response.status_code == 200, response.text
    note = response.json()
    assert len(bodies) == 2, "transport truncation must not be saved as a finished note"
    assert "complete worked example" in note["content"]
    assert note["content"].count("Detailed recorded explanation.") == 400
    assert "[P1]" not in note["content"]
    assert any(m["role"] == "assistant" and m["content"] == first for m in bodies[1]["messages"])
    assert (await client.get(f"/sessions/{session}")).json()["notes"]["content"] == note["content"]


async def test_api_section_continuation_keeps_one_document_and_clean_markdown(
    client: httpx.AsyncClient, session: str, outbound: FakeHttp,
) -> None:
    await add(client, outbound, session, 0, "Definition and worked example.")
    answers = [
        "# Topic\n\nDefinition [P1]\n<!-- SKAZ_NOTE_CONTINUE -->",
        "## Worked example\n\n| Step | Explanation |\n| --- | --- |\n| 1 | Recorded step [P1] |",
    ]
    calls = 0

    def reply(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        text = answers[min(calls, 1)]
        calls += 1
        return httpx.Response(200, json=chat_completion(text))

    outbound.routes[("POST", "chat/completions")] = reply
    response = await client.post(f"/sessions/{session}/notes", json={})
    assert response.status_code == 200, response.text
    assert calls == 2
    content = response.json()["content"]
    assert content == (
        "# Topic\n\nDefinition\n\n## Worked example\n\n"
        "| Step | Explanation |\n| --- | --- |\n| 1 | Recorded step |"
    )


@pytest.mark.parametrize("case", ["empty", "repeated", "oversized", "never_finishes"])
async def test_api_incomplete_output_is_not_stored(
    client: httpx.AsyncClient, session: str, outbound: FakeHttp, case: str,
) -> None:
    await add(client, outbound, session, 0, "Recorded material.")
    calls = 0

    def reply(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        text = "# Topic\n\nRecorded fact [P1]"
        if case == "empty":
            text = "" if calls > 1 else text
        elif case == "oversized":
            text += "x" * 200_001
        elif case == "never_finishes":
            text += str(calls)
        payload = chat_completion(text)
        payload["choices"][0]["finish_reason"] = "length"
        return httpx.Response(200, json=payload)

    outbound.routes[("POST", "chat/completions")] = reply
    response = await client.post(f"/sessions/{session}/notes", json={})
    assert response.status_code == 502
    assert (await client.get(f"/sessions/{session}")).json()["notes"] is None
    assert calls <= 64


async def test_merge_of_long_drafts_can_itself_span_multiple_responses(
    client: httpx.AsyncClient, session: str, outbound: FakeHttp, app: Any,
) -> None:
    from dataclasses import replace

    app.state.runtime.config = replace(app.state.runtime.config, max_notes_chunk_chars=100)
    await fixtures.add_at(client, outbound, session, 0, 0, "First explanation and its example.")
    await fixtures.add_at(client, outbound, session, 1, 60_000, "Second explanation and its qualification.")
    first, second = "First full explanation [P1]", "Second full explanation [P2]"
    answers = [first, second, "# Combined\n\n" + first + "\n\n", second]
    bodies: list[dict[str, Any]] = []

    def reply(request: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(request.content))
        index = len(bodies) - 1
        payload = chat_completion(answers[index])
        payload["choices"][0]["finish_reason"] = "length" if index == 2 else "stop"
        return httpx.Response(200, json=payload)

    outbound.routes[("POST", "chat/completions")] = reply
    response = await client.post(f"/sessions/{session}/notes", json={})
    assert response.status_code == 200, response.text
    assert len(bodies) == 4
    editorial = bodies[2]["messages"][-1]["content"]
    assert first in editorial and second in editorial
    assert "NOT a shorter summary" in editorial and "Check every draft topic" in editorial
    assert response.json()["content"] == "# Combined\n\nFirst full explanation\n\nSecond full explanation"
    assert len(response.json()["citations"]) == 2


async def test_failed_continuation_never_replaces_existing_note(
    client: httpx.AsyncClient, session: str, outbound: FakeHttp,
) -> None:
    await add(client, outbound, session, 0, "Recorded explanation.")
    stub_notes(outbound, "# Original\n\nKept [P1]")
    original = (await client.post(f"/sessions/{session}/notes", json={})).json()
    calls = 0

    def reply(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls == 1:
            payload = chat_completion("# Incomplete\n\nBeginning [P1]")
            payload["choices"][0]["finish_reason"] = "length"
            return httpx.Response(200, json=payload)
        return httpx.Response(400, json={"error": "fixture failure"})

    outbound.routes[("POST", "chat/completions")] = reply
    response = await client.post(f"/sessions/{session}/notes", json={
        "replace_note_id": original["id"], "expected_revision": original["revision"],
    })
    assert response.status_code == 502
    saved = (await client.get(f"/sessions/{session}")).json()["notes"]
    assert saved["content"] == original["content"]
    assert saved["revision"] == original["revision"]
