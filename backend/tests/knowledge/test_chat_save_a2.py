"""A2 save ownership, fallback disclosure and interruption on the synthetic chat host."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from threading import Event

import pytest

from skaz.knowledge.agents.engine import AgentTurn, EngineId, EngineStatus, Failed, ModelOption
from skaz.knowledge.agents.fake import Gate, ScriptItem
from skaz.knowledge.agents.registry import EngineRegistry
from skaz.knowledge.chats.model import TextPart
from skaz.knowledge.chats.service import ChatConflict
from skaz.knowledge.library.library import INBOX_ID
from skaz.knowledge.markdown.page import PageDocument, parse_page
from skaz.knowledge.markdown.source import Origin
from skaz.knowledge.sources.visual import LinkedFramePolicy, RetrievedFrame
from tests.knowledge.chat_support import all_text, limit_failure, text
from tests.knowledge.ingest_support import settle
from tests.knowledge.test_chats_api import Env
from tests.knowledge.test_chats_api import env as env
from tests.knowledge.test_source_visual import make_png
from tests.knowledge.test_visual_transport041_wiring import _setup_routing_matrix

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


@pytest.mark.parametrize(("alternate", "reported", "configured"), [
    ("codex", "engine-choice", None), ("codex", None, None),
    ("claude_code", "engine-choice", None), ("claude_code", None, None),
    ("claude_code", "default", "default"),
])
async def test_unconfigured_wiki_model_discloses_default_without_guessing(
    env: Env, monkeypatch: pytest.MonkeyPatch, alternate: EngineId, reported: str | None,
    configured: str | None,
) -> None:
    async def models() -> list[ModelOption]:
        names = ("first-listed", "chat-choice", "engine-choice", "default")
        return [ModelOption(name, name) for name in names]

    for engine in env.agents.engines.values():
        monkeypatch.setattr(engine, "models", models)
    monkeypatch.setattr(env.agents.engines[alternate], "current_model", reported, raising=False)
    key = await answer_key(env, model="chat-choice")
    env.runtime.kb.settings.set("wiki_engine", alternate)
    if configured:
        env.runtime.kb.settings.set("wiki_model", configured)
    if alternate != "codex":
        # The model selected in the engine can change after its last check.
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
    confirmed = reported if reported != "default" else None
    assert "default" in notice.lower() and (confirmed or "not reported") in notice
    assert "first-listed" not in notice and "old-choice" not in notice and len(attempts) == 2
    assert attempts[-1].model == confirmed and attempts[-1].tools is None and attempts[-1].web is None


@pytest.mark.parametrize(("chat_engine", "chat_choice", "wiki_choice", "reported", "models"), [
    pytest.param("codex", "chat-choice", None, "new-model", ("chat-choice", "new-model"), id="cross-engine"),
    pytest.param("codex", "chat-choice", None, None, ("chat-choice", None), id="cross-engine-unknown"),
    pytest.param("hermes", "new-model", None, "new-model", ("new-model",), id="same-effective-model"),
    pytest.param("hermes", "chat-choice", None, None, ("chat-choice",), id="same-engine-unknown-wiki"),
    pytest.param("hermes", None, "new-model", None, (None,), id="same-engine-unknown-primary"),
    pytest.param("hermes", None, "new-model", "new-model", ("new-model",), id="explicit-wiki-matches"),
    pytest.param("hermes", None, "wiki-choice", "new-model", ("new-model", "wiki-choice"),
                 id="explicit-wiki"),
    pytest.param("hermes", "chat-choice", None, "new-model", ("chat-choice", "new-model"),
                 id="distinct-default"),
])
async def test_warm_registry_shapes_with_one_consistent_model_choice(
    env: Env, monkeypatch: pytest.MonkeyPatch, chat_engine: EngineId, chat_choice: str | None,
    wiki_choice: str | None, reported: str | None, models: tuple[str | None, ...],
) -> None:
    settings = env.runtime.kb.settings
    env.runtime.kb_agents.registry = EngineRegistry(env.agents.engines, settings)
    wiki = env.agents.engines["hermes"]
    selectable = ("first-listed", "old-model", "new-model", "chat-choice", "wiki-choice")

    async def options() -> list[ModelOption]:
        return [ModelOption(id_, id_) for id_ in selectable]

    for engine in env.agents.engines.values():
        monkeypatch.setattr(engine, "models", options)
    monkeypatch.setattr(wiki, "current_model", "old-model", raising=False)
    choices = {"engine": chat_engine, **({"model": chat_choice} if chat_choice else {})}
    chat_id, message_id = await answer_key(env, **choices)
    warm = await env.chats.registry.view("hermes", refresh=True)
    assert warm.current_model == "old-model"
    monkeypatch.setattr(wiki, "current_model", reported)
    settings.set("wiki_engine", "hermes")
    if wiki_choice:
        settings.set("wiki_model", wiki_choice)

    attempts: list[tuple[str | None, str]] = []

    def shape(turn: AgentTurn) -> list[ScriptItem]:
        # The engine's default can change after discovery and before the fallback runs.
        drifted = attempts and chat_engine == "codex" and reported
        effective_default = "changed-after-discovery" if drifted else "new-model"
        attempts.append((turn.model, turn.model or effective_default))
        assert turn.tools is None and turn.web is None and turn.visuals == ()
        if len(attempts) == 1:
            return [limit_failure()]
        return list(text(EDIT))

    env.agents.shape_scripts[chat_engine] = env.agents.shape_scripts["hermes"] = shape
    before = {page.id for page in env.runtime.kb.pages(kind="analysis")}
    response = await env.client.post(f"/kb/chats/{chat_id}/messages/{message_id}/save")
    message = await env.message(chat_id, message_id)
    after = {page.id for page in env.runtime.kb.pages(kind="analysis")}
    assert attempts == [(model, model or "new-model") for model in models]
    if len(models) == 1:
        assert response.status_code == 409 and response.json()["code"] == "ENGINE_LIMIT"
        assert "No distinct wiki model" in response.json()["detail"]
        assert before == after and message["saved_page_id"] is None
    else:
        assert response.status_code == 200, response.text
        notice = response.json()["warning"]
        model = models[-1]
        if wiki_choice:
            assert f"Shaped with Wiki LLM: Hermes Agent ({model})" in notice
        else:
            detail = f"reported as {model}" if model else "model not reported"
            assert f"Shaped with Wiki LLM: Hermes Agent (engine default, {detail})" in notice
        assert "old-model" not in notice and "first-listed" not in notice
        assert after - before == {message["saved_page_id"]} == {response.json()["id"]}


@pytest.mark.parametrize("mode", ["retained", "transient", "legacy", "borrowed"])
async def test_save_preserves_verified_frame_claim_and_actual_time(
    env: Env, monkeypatch: pytest.MonkeyPatch, mode: str,
) -> None:
    engine = _setup_routing_matrix(env.runtime)["claude_code"]
    video = env.runtime.kb.create_material(
        INBOX_ID, "Synthetic linked video", "video_link", [], status="ready",
        origin=Origin(type="url", url="https://vimeo.com/42424242"),
    )
    material_id = video.manifest.id
    sources = env.runtime.kb_sources
    sources.visual.frame_policy = LinkedFramePolicy(True, mode != "transient")
    pixels = make_png(3, 3)
    calls: list[tuple[int, ...]] = []

    def retrieve(_source: object, times: tuple[int, ...]) -> list[RetrievedFrame]:
        calls.append(times)
        assert times == (10_000,)
        return [RetrievedFrame(data=pixels, requested_timestamp_ms=10_000, actual_timestamp_ms=11_120)]

    sources.visual.frame_retriever = retrieve
    label = "[Video frame at 00:11.120](https://vimeo.com/42424242#t=11s)"
    rows: list[dict[str, str | int | bool]] = []

    def script(turn: AgentTurn) -> list[ScriptItem]:
        if turn.response_schema:
            assert turn.tools is None and turn.web is None and turn.visuals == ()
            rows.extend(json.loads(turn.messages[-1].content))
            omit = [row["id"] for row in rows
                    if not row["required"] and row["text"] != "Observation retained."]
            return list(text(json.dumps({"omit": omit, "break_before": []})))
        return list(text("Observation retained. The chart is red. ",
                         f"⟦frame:{turn.visuals[0].visual_id}⟧", "\n\nI can tell you more."))

    monkeypatch.setattr(engine, "_script", script)
    chat = (await env.chat(engine="claude_code", model="sonnet"))["id"]
    answer = await env.answered(chat, "Inspect the chart at 00:10", attachments=[material_id])
    assert label in all_text(answer)
    stored = env.chats.repo.message(chat, answer["id"])
    assert stored is not None
    (verified,) = [frame for part in stored.parts if isinstance(part, TextPart)
                   for frame in part.frame_citations]
    assert (verified.material_id, verified.timestamp_ms, verified.markdown) == (material_id, 11_120, label)
    frames = sources.list_retained_frames(material_id)
    if mode == "transient":
        assert frames == ()
    else:
        (frame,) = frames
        assert frame.citation_refs == (answer["id"],)
        assert frame.locator.material_id == material_id and frame.locator.timestamp_ms == 11_120
        assert sources.read_retained_frame(material_id, frame.frame_id).data == pixels

    if mode == "legacy":
        env.chats.repo.save_message(stored.with_parts([
            TextPart(part.text) if isinstance(part, TextPart) else part for part in stored.parts
        ]))
    if mode == "borrowed":
        # An identical Markdown link from a sibling does not inherit the first answer's evidence.
        monkeypatch.setattr(engine, "_script", lambda turn: (
            script(turn) if turn.response_schema else text(f"Observation retained. The chart is red. {label}")
        ))
        answer = await env.answered(chat, "Inspect the frame again at 00:10", attachments=[material_id])

    rendered = await env.client.post(f"/kb/chats/{chat}/messages/{answer['id']}/save")
    assert rendered.status_code == 200, rendered.text
    page_id = rendered.json()["id"]
    record = env.runtime.kb.page_repo.get(page_id)
    assert record is not None
    saved = parse_page((env.runtime.kb.library_root / record.rel_path).read_text())
    (block,) = saved.blocks()
    assert block.kind == "explanation" and not block.cites
    assert "I can tell you more." not in block.body
    assert saved.meta.extra["skaz_chat"] == chat
    assert (await env.message(chat, answer["id"]))["saved_page_id"] == page_id
    assert calls == [(10_000,)] * (2 if mode == "borrowed" else 1)
    assert sources.list_retained_frames(material_id) == frames
    if mode == "borrowed":
        assert "The chart is red." not in block.body and label not in block.body and not saved.meta.sources
    else:
        assert f"The chart is red. {label}" in block.body
        assert saved.meta.sources == (material_id,)
        protected = [row["text"] for row in rows if row["required"] and not row["breakable"]]
        assert "The chart is red." in protected and "[source]" in protected


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
