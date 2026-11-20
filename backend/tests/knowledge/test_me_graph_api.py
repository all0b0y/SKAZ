from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from dataclasses import replace
from pathlib import Path
from typing import Any

import httpx
import pytest

from skaz.app import create_app
from skaz.config import AppConfig
from skaz.knowledge.agents.engine import AgentTurn, SessionSupport
from skaz.knowledge.me.prompt import EDIT_TOOL, SKILL_TOOL
from skaz.knowledge.permissions.store import RunRef
from skaz.secrets import MemorySecretStore
from tests.conftest import TOKEN
from tests.knowledge.test_chats_api import Env
from tests.knowledge.test_n6_me_chat import _env, agent, answers
from tests.knowledge.test_s0_study_separation import RUN_ID, _test_block

RULE = "When introducing a term, give one example."


@pytest.fixture(params=[None, SessionSupport(live=True, revert=True)], ids=["stateless", "live"])
async def graph_env(
    kb_config: AppConfig, tmp_path: Path, request: pytest.FixtureRequest,
) -> AsyncIterator[Env]:
    config = replace(kb_config, documents_sandbox=tmp_path, me_graph_isolated=True)
    app = create_app(config, secret_store=MemorySecretStore(),
                     http_client=httpx.AsyncClient(transport=httpx.MockTransport(
                         lambda _: httpx.Response(599))))
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8765",
        headers={"Authorization": f"Bearer {TOKEN}"},
    ) as client:
        env = await _env(app, client, request.param)
        try:
            yield env
        finally:
            await env.chats.close()
            await env.runtime.http.aclose()
            env.runtime.close()


async def test_graph_projects_only_for_matching_requests(graph_env: Env) -> None:
    client = graph_env.client
    view = (await client.get("/kb/me")).json()
    assert view["schema_version"] == 2
    assert not view["chat"] and not view["study"]
    assert (await client.get("/kb/me/skills/profile")).status_code == 404
    entry = (await client.post("/kb/me/entries", json={
        "text": RULE, "area": "chat", "expected_revision": view["revision"],
    })).json()
    private_fact = "I study synthetic physics."
    assert (await client.post("/kb/me/entries", json={
        "text": private_fact, "area": "personal", "expected_revision": entry["revision"],
    })).is_success
    chat = await graph_env.chat()
    await graph_env.answered(chat["id"], "Define entropy.")
    matched = answers(graph_env)[-1]
    held = "\n".join(message.content for message in matched.messages)
    assert RULE in held and private_fact not in held and RULE not in matched.instructions
    assert SKILL_TOOL not in {spec.name for spec in matched.tools or ()}
    await graph_env.answered(chat["id"], "Please list the next steps.")
    missed = answers(graph_env)[-1]
    assert all(RULE not in msg.content for msg in missed.messages)
    assert missed.session is None or missed.session.mode == "start"

    removed = await client.delete(
        f"/kb/me/entries/{entry['id']}", params={"expected_revision": entry["revision"]},
    )
    assert removed.is_success
    await graph_env.answered(chat["id"], "Define velocity.")
    assert all(RULE not in msg.content for msg in answers(graph_env)[-1].messages)


async def test_declaration_bound_to_user_turn_and_undo(graph_env: Env) -> None:
    chat = await graph_env.chat()
    sentence = "Always use short answers."
    engine = agent(graph_env)
    engine.calls = [(EDIT_TOOL, {"start": 0, "end": len(sentence)})]
    await graph_env.answered(chat["id"], "This turn only, be brief.")
    assert engine.outcomes[-1].is_error

    engine.calls = [(EDIT_TOOL, {"start": 0, "end": len(sentence)})]
    answer = await graph_env.answered(chat["id"], sentence)
    assert not engine.outcomes[-1].is_error
    [chip] = [part for part in answer["parts"] if part["type"] == "memory"]
    assert sentence not in repr(chip)
    entries = (await graph_env.client.get("/kb/me/entries")).json()["entries"]
    assert [entry["text"] for entry in entries] == [sentence]
    assert (await graph_env.client.post(f"/kb/me/edits/{chip['edit_id']}/undo")).is_success
    entries = (await graph_env.client.get("/kb/me/entries")).json()["entries"]
    assert not entries


async def test_store_revocation_during_turn_assembly_prevents_dispatch(
    graph_env: Env, monkeypatch: pytest.MonkeyPatch,
) -> None:
    graph = graph_env.runtime.kb_me_graph
    graph.create(text=RULE, area="chat")
    made = asyncio.Event()
    release = asyncio.Event()
    turn_before = graph_env.chats._turn

    async def waiting(*args: Any, **options: Any) -> AgentTurn:
        turn = await turn_before(*args, **options)
        if not made.is_set():
            assert any(RULE in msg.content for msg in turn.messages)
            made.set()
            await release.wait()
        return turn

    monkeypatch.setattr(graph_env.chats, "_turn", waiting)
    chat = await graph_env.chat()
    task = asyncio.create_task(graph_env.answered(chat["id"], "Define angular momentum."))
    try:
        await asyncio.wait_for(made.wait(), 3)
        # Simulate the store commit before the live-session cleanup reaches this chat.
        graph.set_controls(graph.open().revision, enabled=False)
    finally:
        release.set()
    assert (await task)["state"] == "done"
    assert all(RULE not in msg.content for turn in answers(graph_env) for msg in turn.messages)


async def test_study_adapter_needs_consent_and_does_not_assume_two_choices(graph_env: Env) -> None:
    runtime = graph_env.runtime
    graph = runtime.kb_me_graph
    chat = await graph_env.chat()
    ref = RunRef(RUN_ID, chat["id"], RUN_ID, "claude_code")
    runtime.kb_study_tools.runs = lambda run_id: ref if run_id == RUN_ID else None
    block = await _test_block(runtime, graph_env.library, "Synthetic test", save=False)
    question = runtime.kb_study.questions(block)[0]
    client = graph_env.client
    answer = f"/kb/study/{block.id}/answer"
    response_text = "Synthetic private response."
    assert (await client.post(answer, json={"item_id": question.id, "text": response_text})).is_success
    assert not graph.open().ledger.episodes
    view = (await client.get("/kb/me")).json()
    enabled = (await client.put("/kb/me/learning", json={
        "expected_revision": view["revision"], "study": True,
    })).json()
    assert enabled["study"] and not enabled["chat"]
    assert (await client.post(answer, json={"item_id": question.id, "text": response_text})).is_success
    ledger = graph.open().ledger
    [episode] = ledger.episodes.values()
    assert episode.kind == "attempt" and not episode.eligible
    assert not ledger.patterns
    assert response_text not in ledger.model_dump_json()
