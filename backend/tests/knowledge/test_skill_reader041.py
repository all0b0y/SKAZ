"""Installed skill data is requested inside a turn. Only sessions that received it need replacement."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import pytest

from skaz.knowledge.agents.engine import AgentTurn, Failed, SessionPlan, TextDelta
from skaz.knowledge.agents.fake import Gate
from skaz.knowledge.agents.tools import ToolContext
from skaz.knowledge.permissions.store import RunRef
from tests.knowledge.chat_support import finished
from tests.knowledge.ingest_support import settle
from tests.knowledge.test_chats_api import Env
from tests.knowledge.test_n6_live_chats import answers
from tests.knowledge.test_n6_live_chats import env as live_fixture
from tests.knowledge.test_tools_files041 import TOOLS, checked, data
from tests.knowledge.test_tools_files_trust041 import TRUSTED, install_fixture

env = live_fixture
READER = "skaz_skill_read"
MARKER = "ZEPHYR-704"


async def install_skill(env: Env) -> str:
    await install_fixture(env)
    ticket = await checked(env.client, TRUSTED, "skill")
    response = await env.client.post(TOOLS, json={"url": TRUSTED, "check_id": ticket["check_id"]})
    return str(data(response, 201)["id"])


@asynccontextmanager
async def tool_turn(env: Env, chat: str, *, fail: bool = False) -> AsyncIterator[AgentTurn]:
    gate = asyncio.Event()
    terminal = Failed("", "other", "Fixture failure") if fail else TextDelta("", "Separate fixture reply.")
    env.agents.scripts["codex"] = lambda _: [Gate(gate), terminal]
    before = len(answers(env))
    try:
        await env.ask(chat, "Make a lecture brief. Keep this question in the chat.")
        await settle(lambda: len(answers(env)) > before)
        turn = answers(env)[-1]
        await settle(lambda: bool((held := env.chats.sessions.get(chat)) and held.tail_turn_id))
        yield turn
    finally:
        gate.set()
        await finished(env.chats)
        env.agents.scripts.pop("codex")


async def test_only_the_live_session_that_read_the_skill_is_replaced(env: Env) -> None:
    ident = await install_skill(env)
    used = (await env.chat())["id"]
    unopened = (await env.chat())["id"]
    registry = env.runtime.kb_tools
    async with tool_turn(env, used) as turn:
        assert turn.tools and READER in {tool.name for tool in turn.tools}
        assert MARKER not in turn.instructions
        catalog = await registry.call(READER, {}, ToolContext(turn.run_id))
        assert "Lecture brief" in catalog.text and MARKER not in catalog.text
        instructions = await registry.call(READER, {"skill_id": ident}, ToolContext(turn.run_id))
        assert not instructions.is_error and MARKER in instructions.text
        used_start = turn

    async with tool_turn(env, unopened) as turn:
        catalog = await registry.call(READER, {}, ToolContext(turn.run_id))
        assert "Lecture brief" in catalog.text
        unopened_start = turn
    original = env.chats.sessions.get(unopened)
    assert original is not None
    data(await env.client.patch(f"{TOOLS}/{ident}", json={"active": False}))

    async with tool_turn(env, unopened) as turn:
        assert turn.session == SessionPlan("continue", original.session_id)
        assert turn.instructions == unopened_start.instructions and turn.tools == unopened_start.tools
        catalog = await registry.call(READER, {}, ToolContext(turn.run_id))
        assert "Lecture brief" not in catalog.text

    async with tool_turn(env, used) as turn:
        assert turn.session == SessionPlan("start")
        assert turn.instructions == used_start.instructions and turn.tools == used_start.tools
        assert len(turn.messages) > 1
        assert all(MARKER not in message.content for message in turn.messages)
        assert "Keep this question in the chat." in turn.messages[0].content
        refusal = await registry.call(READER, {"skill_id": ident}, ToolContext(turn.run_id))
        assert refusal.is_error and MARKER not in refusal.text
    data(await env.client.patch(f"{TOOLS}/{ident}", json={"active": True}))
    async with tool_turn(env, unopened) as turn:
        assert turn.session == SessionPlan("continue", original.session_id)
        assert turn.instructions == unopened_start.instructions and turn.tools == unopened_start.tools


async def test_long_skill_instructions_can_be_read_in_order(env: Env) -> None:
    fixture = await install_fixture(env)
    source = "https://community.test/SKILL.md"
    text = "---\nname: Brief\ndescription: Write a short brief.\n---\n" + "Use brief paragraphs. ё\n" * 420
    fixture.skill_bytes = text.encode()
    ticket = await checked(env.client, source, "skill")
    response = await env.client.post(TOOLS, json={"url": source, "check_id": ticket["check_id"]})
    ident = data(response, 201)["id"]
    chat = (await env.chat())["id"]
    chunks = []
    async with tool_turn(env, chat) as turn:
        offset: int | None = 0
        while offset is not None:
            outcome = await env.runtime.kb_tools.call(
                READER, {"skill_id": ident, "offset": offset}, ToolContext(turn.run_id),
            )
            assert not outcome.is_error
            page = json.loads(outcome.text)
            chunks.append(page["instructions"])
            offset = page["next_offset"]
            assert len(chunks) <= 3
    assert len(chunks) == 3 and "".join(chunks) == text


async def test_disable_while_recording_a_read_stops_the_pending_delivery(
    env: Env, monkeypatch: pytest.MonkeyPatch,
) -> None:
    ident = await install_skill(env)
    chat = (await env.chat())["id"]
    started, finish = asyncio.Event(), asyncio.Event()
    record = env.chats.record_external_skill_read

    async def block_read(ref: RunRef, skill_id: str) -> bool:
        started.set()
        await finish.wait()
        return await record(ref, skill_id)

    monkeypatch.setattr(env.chats, "record_external_skill_read", block_read)
    async with tool_turn(env, chat) as turn:
        call = asyncio.create_task(
            env.runtime.kb_tools.call(READER, {"skill_id": ident}, ToolContext(turn.run_id))
        )
        try:
            await asyncio.wait_for(started.wait(), 3)
            data(await env.client.patch(f"{TOOLS}/{ident}", json={"active": False}))
        finally:
            finish.set()
        outcome = await call
    assert outcome.is_error
    assert "This skill is disabled or unavailable." in outcome.text and MARKER not in outcome.text


async def test_skill_read_is_persisted_before_a_failed_turn_finishes(env: Env) -> None:
    ident = await install_skill(env)
    chat = (await env.chat())["id"]
    await env.answered(chat, "Remember this prior question.")
    async with tool_turn(env, chat, fail=True) as turn:
        outcome = await env.runtime.kb_tools.call(READER, {"skill_id": ident}, ToolContext(turn.run_id))
        assert not outcome.is_error and MARKER in outcome.text
        session = env.chats.sessions.get(chat)
        assert session and session.context and ident in session.context.external_skill_reads
    data(await env.client.patch(f"{TOOLS}/{ident}", json={"active": False}))
    await env.answered(chat, "Continue.")
    assert answers(env)[-1].session == SessionPlan("start")


def legacy_session(env: Env, chat_id: str) -> str:
    with env.runtime.kb.db.write() as connection:
        row = connection.execute(
            "SELECT session_id, context FROM agent_sessions WHERE chat_id=?", (chat_id,)
        ).fetchone()
        context = json.loads(row["context"])
        context["tools"] = [tool for tool in context["tools"] if tool != READER]
        context.pop("external_skill_reads", None)
        connection.execute(
            "UPDATE agent_sessions SET context=? WHERE chat_id=?", (json.dumps(context), chat_id)
        )
        return str(row["session_id"])


async def test_legacy_session_without_exposure_continues_with_identical_tools_and_prompt(env: Env) -> None:
    chat = (await env.chat())["id"]
    await env.answered(chat, "First answer.")
    starting = answers(env)[-1]
    session_id = legacy_session(env, chat)
    await env.answered(chat, "Second answer.")
    later = answers(env)[-1]
    assert later.session == SessionPlan("continue", session_id)
    assert later.instructions == starting.instructions
    assert later.tools == tuple(tool for tool in starting.tools or () if tool.name != READER)


@pytest.mark.parametrize("remove", [False, True], ids=["disabled", "deleted"])
async def test_legacy_inline_skill_is_removed(env: Env, remove: bool) -> None:
    ident = await install_skill(env)
    chat = (await env.chat())["id"]
    await env.answered(chat, "First answer.")
    legacy_session(env, chat)
    # The old row listed only currently active skills after the earlier disable. A saved vendor
    # prompt can still contain the original text. Simulate its old installation metadata.
    with env.runtime.kb.db.write() as connection:
        rows = connection.execute("SELECT details FROM external_tools WHERE id=?", (ident,)).fetchone()
        details = json.loads(rows["details"])
        details.pop("description", None)
        connection.execute("UPDATE external_tools SET details=? WHERE id=?", (json.dumps(details), ident))
    if remove:
        assert (await env.client.delete(f"{TOOLS}/{ident}")).status_code == 204
    else:
        data(await env.client.patch(f"{TOOLS}/{ident}", json={"active": False}))
    await env.answered(chat, "Second answer.")
    assert answers(env)[-1].session == SessionPlan("start")
    assert MARKER not in answers(env)[-1].instructions
