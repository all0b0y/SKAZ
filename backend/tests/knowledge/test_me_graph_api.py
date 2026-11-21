from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from dataclasses import replace
from datetime import UTC, datetime
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
    assert view["chat"] and view["study"]
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
    view = (await client.get("/kb/me")).json()
    assert (await client.put("/kb/me/learning", json={
        "expected_revision": view["revision"], "study": False, "chat": False,
    })).is_success
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


async def test_new_profile_enables_both_sources_without_special_flags(kb_client: httpx.AsyncClient) -> None:
    view = (await kb_client.get("/kb/me")).json()
    assert view["schema_version"] == 2 and view["enabled"] and view["study"] and view["chat"]
    changed = (await kb_client.put("/kb/me/learning", json={
        "chat": False, "expected_revision": view["revision"],
    })).json()
    assert changed["study"] and not changed["chat"]


async def test_settings_explain_same_scope_conflict(graph_env: Env) -> None:
    client = graph_env.client
    for text in [RULE, "When introducing a term, skip examples."]:
        revision = (await client.get("/kb/me")).json()["revision"]
        assert (await client.post("/kb/me/entries", json={
            "text": text, "area": "chat", "expected_revision": revision,
        })).is_success
    entries = (await client.get("/kb/me/entries")).json()["entries"]
    assert len(entries) == 2 and all(item["status"] == "conflict" for item in entries)
    assert all("conflict" in item["why"].lower() for item in entries)
    assert entries[1]["text"] in entries[0]["why"]
    removed = entries[1]
    assert (await client.delete(f"/kb/me/entries/{removed['id']}", params={
        "expected_revision": removed["revision"],
    })).is_success
    assert (await client.get("/kb/me/entries")).json()["entries"][0]["status"] == "ready"


@pytest.mark.parametrize("keep", [True, False])
async def test_delete_chat_replays_selected_retention_after_recovery(graph_env: Env, keep: bool) -> None:
    from skaz.knowledge.me.graph import MeGraphStore
    from skaz.knowledge.me.observations import SHARED_CHAT, Offer, TrustedEvent

    chat_id = (await graph_env.chat())["id"]
    graph = graph_env.runtime.kb_me_graph
    epoch = graph.source_epoch("chat")
    for index in range(2):
        event = TrustedEvent(
            producer="chat", family="chat_return", scope=SHARED_CHAT, session_id=chat_id,
            epoch=epoch, event_id=f"open_{index}", episode_id=f"episode_{index}",
            source_ref=f"source_{index}", context_key="branching", sequence=0,
            occurred_at=datetime(2026, 1, 1, 13, tzinfo=UTC), kind="opportunity", actor="system",
            offered_set=(Offer(action="return_to_goal"), Offer(action="continue_branch")),
        )
        assert graph.observe(event) == "accepted"
        choice = event.model_copy(update={
            "event_id": f"choice_{index}", "actor": "user", "kind": "choice", "sequence": 1,
            "selected": "return_to_goal", "uncued": True,
        })
        assert graph.observe(choice) == "accepted"
    graph.remember(text=RULE, area="chat", chat_id=chat_id, source_id="declaration",
                   answer_id="answer", epoch=graph.current_epoch())
    key = graph.vault.key_path.read_bytes()
    graph.vault.key_path.unlink()
    graph.revoke_sources({"source_0"})  # an older pending edit must never be kept by deletion
    params = {} if keep else {"keep_experience": "false"}
    response = await graph_env.client.delete(f"/kb/chats/{chat_id}", params=params)
    assert response.status_code == 204
    assert (await graph_env.client.get(f"/kb/chats/{chat_id}")).status_code == 404
    graph.vault.key_path.write_bytes(key)
    reopened = MeGraphStore(graph.directory, source_committed=graph_env.chats.repo.source_change_committed)
    state = reopened.open()
    assert not state.entries and not state.edits and not state.ledger.episodes
    assert chat_id not in state.model_dump_json()
    assert "source_0" not in state.model_dump_json() and "episode_1" not in state.model_dump_json()
    if keep:
        [pattern] = state.ledger.patterns.values()
        assert (pattern.positive, pattern.negative, pattern.sessions) == (1, 0, 1)
        assert state.ledger.retained_chat is not None
        reopened.revoke_sources(set(), scope=chat_id, keep_experience=True)
        assert reopened.open().ledger == state.ledger
        assert not reopened.forget_pattern(pattern.id, pattern.revision).ledger.patterns
    else:
        assert not state.ledger.patterns and state.ledger.retained_chat is None
    assert reopened.observe(event) == "ignored"


async def test_runtime_keeps_existing_profile_and_erasure_preferences(kb_config: AppConfig) -> None:
    def open_app(config: AppConfig) -> Any:
        return create_app(config, secret_store=MemorySecretStore(),
                          http_client=httpx.AsyncClient(transport=httpx.MockTransport(
                              lambda _: httpx.Response(599))))

    old_app = open_app(replace(kb_config, use_legacy_me=True))
    await old_app.state.runtime.http.aclose()
    old_app.state.runtime.close()
    for _ in range(2):
        app = open_app(kb_config)
        try:
            graph = app.state.runtime.kb_me_graph
            state = graph.open()
            assert state.controls.enabled and not state.controls.chat and not state.controls.study
            state = graph.set_controls(state.revision, chat=True, study=True)
            graph.erase(state.revision)
        finally:
            await app.state.runtime.http.aclose()
            app.state.runtime.close()


async def test_scoped_exception_does_not_mark_other_chats_in_conflict(graph_env: Env) -> None:
    store = graph_env.runtime.kb_me_graph
    store.create(text=RULE, area="chat")
    store.remember(text="When introducing a term, skip examples.", area="chat", chat_id="physics",
                   source_id="physics_source", answer_id="physics_answer", epoch=store.current_epoch())
    entries = (await graph_env.client.get("/kb/me/entries")).json()["entries"]
    assert len(entries) == 2 and all(item["status"] == "ready" for item in entries)


@pytest.mark.parametrize("failure", ["chat", "journal"])
async def test_failed_chat_delete_preserves_withdrawable_sources(
    graph_env: Env, monkeypatch: pytest.MonkeyPatch, failure: str,
) -> None:
    chat_id = (await graph_env.chat())["id"]
    graph = graph_env.runtime.kb_me_graph
    graph.remember(text=RULE, area="chat", chat_id=chat_id, source_id="decl",
                   answer_id="answer", epoch=graph.current_epoch())

    def unavailable(*args: object) -> bool:
        raise OSError("Synthetic chat storage failure.")

    with monkeypatch.context() as fault:
        if failure == "chat":
            fault.setattr(graph_env.chats.repo, "delete", unavailable)
        else:
            fault.setattr(graph._revocations, "write", unavailable)
        from skaz.knowledge.me.graph import GraphUnavailable

        with pytest.raises(GraphUnavailable):
            await graph_env.chats.delete(chat_id)
    assert (await graph_env.client.get(f"/kb/chats/{chat_id}")).is_success
    assert [item[-1].text for item in graph.open().entries.values()] == [RULE]
    response = await graph_env.client.delete(f"/kb/chats/{chat_id}", params={"keep_experience": "false"})
    assert response.status_code == 204 and not graph.open().entries


async def test_edit_receipt_remains_valid_after_answer_replacement(graph_env: Env) -> None:
    from skaz.knowledge.chats.model import MessageInput
    from skaz.knowledge.me.graph import MeGraphStore
    from tests.knowledge.chat_support import finished

    chat = (await graph_env.chat())["id"]
    answer = await graph_env.answered(chat, "Synthetic first question")
    prior_answer = graph_env.chats.repo.message(chat, answer["id"])
    assert prior_answer is not None and prior_answer.reply_to is not None
    question_id = prior_answer.reply_to
    graph = graph_env.runtime.kb_me_graph
    graph.remember(text=RULE, area="chat", chat_id=chat, source_id=question_id,
                   answer_id=answer["id"], epoch=graph.current_epoch())
    key = graph.vault.key_path.read_bytes()
    graph.vault.key_path.unlink()
    _, edited_answer = await graph_env.chats.edit(chat, question_id, MessageInput("Synthetic edit"))
    await finished(graph_env.chats)
    repo = graph_env.chats.repo
    saved = repo.message(chat, edited_answer.id)
    assert saved is not None
    repo.replace_answer(saved, replace(saved, id="regenerated_answer"), {"unread": False})
    graph.vault.key_path.write_bytes(key)
    reopened = MeGraphStore(graph.directory, source_committed=repo.source_change_committed)
    assert not reopened.open().entries
