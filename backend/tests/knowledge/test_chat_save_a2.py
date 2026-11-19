"""A2 save ownership, fallback disclosure and interruption on the synthetic chat host."""
from __future__ import annotations

import asyncio
from pathlib import Path
from threading import Event

import pytest

from skaz.knowledge.agents.engine import AgentTurn, EngineId, EngineStatus, Failed, ModelOption
from skaz.knowledge.agents.fake import Gate, ScriptItem
from skaz.knowledge.chats.service import ChatConflict
from skaz.knowledge.markdown.page import PageDocument
from tests.knowledge.chat_support import limit_failure, text
from tests.knowledge.ingest_support import settle
from tests.knowledge.test_chats_api import Env
from tests.knowledge.test_chats_api import env as env

EDIT = '{"omit":[],"break_before":[]}'


async def answer_key(env: Env, **choices: str) -> tuple[str, str]:
    chat = await env.chat(**choices)
    answer = await env.answered(chat["id"], "Explain entropy")
    return chat["id"], answer["id"]


async def test_cancelled_caller_during_commit_detaches_while_retry_and_close_wait(
    env: Env, monkeypatch: pytest.MonkeyPatch,
) -> None:
    key = await answer_key(env)
    page_written, release = Event(), Event()
    create = env.runtime.kb.create_page
    before = {page.id for page in env.runtime.kb.pages(kind="analysis")}

    def hold_backlink(document: PageDocument) -> Path:
        path = Path(create(document))
        page_written.set()
        assert release.wait(10)
        return path

    monkeypatch.setattr(env.runtime.kb, "create_page", hold_backlink)
    caller = asyncio.create_task(env.chats.save_message(*key))
    await settle(page_written.is_set)
    caller.cancel()
    retry = asyncio.create_task(env.chats.save_message(*key))
    closing = asyncio.create_task(env.chats.close())
    try:
        await asyncio.sleep(0)  # deliver caller cancellation and start both waiters
        assert caller.cancelled()
        assert not retry.done() and not closing.done()
        closing.cancel()  # simulate the outer shutdown deadline while the disk transaction is held
        await asyncio.sleep(0)
        assert not closing.done()
    finally:
        release.set()
        await asyncio.gather(caller, retry, closing, return_exceptions=True)
    assert closing.cancelled()
    with pytest.raises(ChatConflict) as duplicate:
        retry.result()
    saved = (await env.message(*key))["saved_page_id"]
    assert duplicate.value.code == "ALREADY_SAVED" and duplicate.value.extra["saved_page_id"] == saved
    assert {page.id for page in env.runtime.kb.pages(kind="analysis")} - before == {saved}
    assert len(env.agents.engines["codex"].turns) == 2


async def test_cancelled_shaping_caller_leaves_cleanup_for_close_to_drain(
    env: Env, monkeypatch: pytest.MonkeyPatch,
) -> None:
    key = await answer_key(env)
    engine = env.agents.engines["codex"]
    started, release, finished = asyncio.Event(), asyncio.Event(), asyncio.Event()
    interrupts: list[str] = []

    async def interrupt(run_id: str) -> None:
        interrupts.append(run_id)
        started.set()
        await release.wait()
        finished.set()

    monkeypatch.setattr(engine, "interrupt", interrupt)
    env.agents.shape_scripts["codex"] = lambda _: [Gate(asyncio.Event())]
    caller = asyncio.create_task(env.chats.save_message(*key))
    await settle(lambda: bool(engine.active_runs()))
    duplicate = asyncio.create_task(env.chats.save_message(*key))
    await asyncio.sleep(0)
    duplicate.cancel()
    with pytest.raises(asyncio.CancelledError):
        await duplicate
    assert engine.active_runs() == {engine.turns[-1].run_id} and not started.is_set()
    caller.cancel()
    await asyncio.wait_for(started.wait(), 2)
    retry = asyncio.create_task(env.chats.save_message(*key))
    closing = asyncio.create_task(env.chats.close())
    try:
        await asyncio.sleep(0)  # both public calls have reached their first await
        assert caller.cancelled()
        assert not closing.done() and not retry.done()
    finally:
        release.set()
        await asyncio.gather(caller, retry, closing, return_exceptions=True)
    assert closing.result() is None
    assert finished.is_set() and interrupts == [engine.turns[-1].run_id]
    with pytest.raises(ChatConflict) as cancelled:
        retry.result()
    assert cancelled.value.code == "CANCELLED"
    assert len(engine.turns) == 2 and (await env.message(*key))["saved_page_id"] is None
    with pytest.raises(ChatConflict) as closed:
        await env.chats.save_message(*key)
    assert closed.value.code == "CLOSING"


async def test_close_cancels_active_shaping_before_any_page_is_written(env: Env) -> None:
    key = await answer_key(env)
    engine = env.agents.engines["codex"]
    env.agents.shape_scripts["codex"] = lambda _: [Gate(asyncio.Event())]
    before = {page.id for page in env.runtime.kb.pages(kind="analysis")}
    save = asyncio.create_task(env.chats.save_message(*key))
    await settle(lambda: bool(engine.active_runs()))
    await asyncio.wait_for(env.chats.close(), 2)
    with pytest.raises(ChatConflict) as cancelled:
        await save
    assert cancelled.value.code == "CANCELLED" and not engine.active_runs()
    assert {page.id for page in env.runtime.kb.pages(kind="analysis")} == before
    assert (await env.message(*key))["saved_page_id"] is None


async def test_failing_interrupt_returns_cancelled_and_allows_retry(
    env: Env, monkeypatch: pytest.MonkeyPatch,
) -> None:
    key = await answer_key(env)
    engine = env.agents.engines["codex"]
    interrupted: list[str] = []

    async def fail(run_id: str) -> None:
        interrupted.append(run_id)
        raise RuntimeError("synthetic interrupt failure")

    monkeypatch.setattr(engine, "interrupt", fail)
    env.agents.shape_scripts["codex"] = lambda _: [Gate(asyncio.Event())]
    url = f"/kb/chats/{key[0]}/messages/{key[1]}"
    before = {page.id for page in env.runtime.kb.pages(kind="analysis")}
    pending = asyncio.create_task(env.client.post(url + "/save"))
    await settle(lambda: bool(engine.active_runs()))
    assert (await env.client.post(url + "/stop")).status_code == 200
    result = await pending
    assert result.status_code == 409 and result.json()["code"] == "CANCELLED"
    assert interrupted == [engine.turns[-1].run_id] and not engine.active_runs()
    assert {page.id for page in env.runtime.kb.pages(kind="analysis")} == before
    assert (await env.message(*key))["saved_page_id"] is None
    del env.agents.shape_scripts["codex"]
    saved = await env.client.post(url + "/save")
    assert saved.status_code == 200 and (await env.message(*key))["saved_page_id"] == saved.json()["id"]


@pytest.mark.parametrize(("alternate", "reported"), [
    ("codex", "engine-choice"), ("codex", None), ("claude_code", "engine-choice"), ("claude_code", None),
])
async def test_unconfigured_wiki_model_discloses_default_without_guessing(
    env: Env, monkeypatch: pytest.MonkeyPatch, alternate: EngineId, reported: str | None,
) -> None:
    async def models() -> list[ModelOption]:
        return [ModelOption(name, name) for name in ("first-listed", "chat-choice", "engine-choice")]

    for engine in env.agents.engines.values():
        monkeypatch.setattr(engine, "models", models)
    monkeypatch.setattr(env.agents.engines[alternate], "current_model", reported, raising=False)
    key = await answer_key(env, model="chat-choice")
    env.runtime.kb.settings.set("wiki_engine", alternate)
    if alternate != "codex":
        # A cached catalog can outlive the selection it showed. require() checks the fake again.
        monkeypatch.setattr(env.agents.engines[alternate], "current_model", "old-choice")
        await env.chats.registry.view(alternate, refresh=True)
        monkeypatch.setattr(env.agents.engines[alternate], "current_model", reported)
    attempts: list[AgentTurn] = []

    def shape(turn: AgentTurn) -> list[ScriptItem]:
        attempts.append(turn)
        if len(attempts) == 1:
            return [limit_failure()]
        return list(text(EDIT))

    env.agents.shape_scripts["codex"] = shape
    env.agents.shape_scripts["claude_code"] = shape
    response = await env.client.post(f"/kb/chats/{key[0]}/messages/{key[1]}/save")
    if alternate == "codex" and reported is None:
        assert response.status_code == 409 and response.json()["code"] == "ENGINE_LIMIT"
        assert len(attempts) == 1 and (await env.message(*key))["saved_page_id"] is None
        return
    assert response.status_code == 200, response.text
    notice = response.json()["warning"]
    assert "Chat model reached its limit" in notice
    assert ("Codex" if alternate == "codex" else "Claude Code") in notice
    assert "default" in notice.lower() and (reported or "not reported") in notice
    assert "first-listed" not in notice and "old-choice" not in notice and len(attempts) == 2
    assert attempts[-1].model is None and attempts[-1].tools is None and attempts[-1].web is None


@pytest.mark.parametrize(("refusal", "status"), [
    ("paused", 409), ("stale", 409), ("offline", 409), ("transient", 422),
])
async def test_refused_fallback_creates_no_page(
    env: Env, monkeypatch: pytest.MonkeyPatch, refusal: str, status: int,
) -> None:
    key = await answer_key(env)
    settings = env.runtime.kb.settings
    settings.set("wiki_engine", "claude_code")
    if refusal == "paused":
        settings.set("wiki_engine_pause.claude_code", {})
    elif refusal == "offline":
        async def offline() -> EngineStatus:
            return EngineStatus("claude_code", installed=False, reason="Synthetic unavailable agent.")

        monkeypatch.setattr(env.agents.engines["claude_code"], "status", offline)
    elif refusal == "stale":
        settings.set("wiki_model", "removed")
    failure = Failed("", "limit", "Slot busy.", transient=True) if refusal == "transient" else limit_failure()
    env.agents.shape_scripts["codex"] = lambda _: [failure]
    before = {page.id for page in env.runtime.kb.pages(kind="analysis")}
    response = await env.client.post(f"/kb/chats/{key[0]}/messages/{key[1]}/save")
    assert response.status_code == status
    if refusal == "transient":
        assert response.json()["detail"] == "Slot busy."
    else:
        assert response.json()["code"] == ("ENGINE_LIMIT" if refusal == "paused" else "WIKI_UNAVAILABLE")
    assert not env.agents.engines["claude_code"].turns
    assert {page.id for page in env.runtime.kb.pages(kind="analysis")} == before
    assert (await env.message(*key))["saved_page_id"] is None
