"""FIX-1 / F1: the R1 audit findings on live agent sessions and «Я» (fake engines at the agent seam).

What SKAZ plans, records, drops and deletes — never what a real agent remembers:
* the user's own message that answers the agent's question is recorded as held (no reseed after it);
* an Undo of the agent's «Я» edit, and switching off a profile the agent wrote, reach the live session;
* «Я» parts in chat messages carry no «Я» text (resolved from the vault when shown);
* switching Profile / How to work / «Я» off (or clearing them) drops every session that holds them;
* queued deletions back off in time, a missing / updating agent costs no attempt, a give-up drops SKAZ's
  local traces;
* the fixed-instructions hash covers the expanded texts.
"""
from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest

from skaz.knowledge.agents import codex as codex_module
from skaz.knowledge.agents.engine import AgentEvent, AgentTurn, EngineId, SessionPlan, SessionSupport
from skaz.knowledge.agents.fake import FakeEngine
from skaz.knowledge.chats import context as context_module
from skaz.knowledge.chats import live as live_module
from skaz.knowledge.chats.live import MAX_DELETE_ATTEMPTS
from skaz.knowledge.me import prompt as me_prompt
from skaz.knowledge.me.prompt import EDIT_TOOL
from tests.knowledge.chat_support import Agents, chips, connect, finished, install, text
from tests.knowledge.test_chats_api import Env
from tests.knowledge.test_n6_me_chat import HOW_TEXT, PROFILE_TEXT, MeEngine

LIVE = SessionSupport(live=True, revert=True)
NO_REVERT = SessionSupport(live=True, revert=False)


# -- fixtures ---------------------------------------------------------------------------------------


class AskingEngine(FakeEngine):
    """Asks the user a question through SKAZ (as ``skaz_ask_user`` / a native question does) when the
    request contains ``ASK``; the reply is the agent's tool result inside the same turn."""

    def __init__(self, runtime: Any, engine_id: EngineId, sessions: SessionSupport) -> None:
        super().__init__(engine_id, script=lambda _turn: text("OK."), sessions=sessions)
        self.runtime = runtime
        self.replies: list[str] = []

    def run(self, turn: AgentTurn) -> AsyncIterator[AgentEvent]:
        inner = super().run(turn)

        async def events() -> AsyncIterator[AgentEvent]:
            if "ASK" in turn.messages[-1].content:
                ref = self.runtime.kb_chats.run_ref(turn.run_id)
                reply = await self.runtime.kb_questions.ask(ref, "Which lecture?", [])
                self.replies.append(reply.text)
            async for event in inner:
                yield event

        return events()


@pytest.fixture
async def env(kb_app: Any, kb_client: httpx.AsyncClient) -> AsyncIterator[Env]:
    runtime = kb_app.state.runtime
    agents = Agents()
    agents.engines["codex"].session_support = LIVE
    install(runtime, agents)
    library = await connect(kb_client, runtime)
    yield Env(kb_client, runtime, runtime.kb_chats, agents, library)
    await runtime.kb_chats.close()


@pytest.fixture
async def me_live(kb_app: Any, kb_client: httpx.AsyncClient) -> AsyncIterator[Env]:
    runtime = kb_app.state.runtime
    agents = Agents()
    agents.engines["codex"] = MeEngine(runtime, LIVE)
    install(runtime, agents)
    library = await connect(kb_client, runtime)
    yield Env(kb_client, runtime, runtime.kb_chats, agents, library)
    await runtime.kb_chats.close()


def engine(env: Env, engine_id: EngineId = "codex") -> FakeEngine:
    return env.agents.engines[engine_id]


def answers(env: Env, engine_id: EngineId = "codex") -> list[AgentTurn]:
    return [turn for turn in engine(env, engine_id).turns if turn.tools is not None]


def pending(env: Env) -> list[tuple[str, str]]:
    return [(item.engine, item.session_id) for item in env.chats.sessions.pending()]


def session_row(env: Env, chat_id: str) -> Any:
    with env.runtime.kb.db.read() as connection:
        return connection.execute("SELECT session_id FROM agent_sessions WHERE chat_id = ?",
                                  (chat_id,)).fetchone()


async def deletions_done(env: Env) -> None:
    for _ in range(3):
        task = env.chats._deleting
        if task is not None:
            await asyncio.wait_for(asyncio.shield(task), 5)
        await asyncio.sleep(0)
    await finished(env.chats)


def later(minutes: float) -> datetime:
    return datetime.now(UTC) + timedelta(minutes=minutes)


# -- 1. the user's own answer to the agent's question --------------------------------------------------


@pytest.mark.parametrize(("engine_id", "support"), [("codex", LIVE), ("hermes", NO_REVERT)])
async def test_a_typed_answer_to_the_agents_question_is_held_and_never_reseeds(
        kb_app: Any, kb_client: httpx.AsyncClient, engine_id: EngineId, support: SessionSupport) -> None:
    runtime = kb_app.state.runtime
    agents = Agents()
    asking = AskingEngine(runtime, engine_id, support)
    agents.engines[engine_id] = asking
    install(runtime, agents)
    library = await connect(kb_client, runtime)
    env = Env(kb_client, runtime, runtime.kb_chats, agents, library)
    try:
        chat = await env.chat(engine=engine_id)
        await env.answered(chat["id"], "Первый вопрос")
        sent = await env.ask(chat["id"], "Сделай карточки ASK")
        for _ in range(300):
            if runtime.kb_questions.store.pending_questions(chat_id=chat["id"]):
                break
            await asyncio.sleep(0.01)
        own = await env.ask(chat["id"], "По лекции 3, пожалуйста")
        assert own["assistant"]["id"] == sent["assistant"]["id"]  # it answered the question
        await finished(env.chats)
        assert len(asking.replies) == 1 and "По лекции 3" in asking.replies[0]
        await env.answered(chat["id"], "Третий вопрос")
        turn = answers(env, engine_id)[-1]
        assert turn.session == SessionPlan("continue", f"{engine_id}-session-1")
        assert len(turn.messages) == 1 and turn.messages[0].content.endswith("Третий вопрос")
        assert asking.deleted_sessions == []
    finally:
        await runtime.kb_chats.close()


# -- 2. Undo / Profile off after the agent's own write reach the live session --------------------------


def _profile_write(env: Env, line: str = "Lives in Kazan") -> None:
    assert isinstance(engine(env), MeEngine)
    engine(env).calls = [(EDIT_TOOL, {"action": "append", "skill_id": "profile", "text": line})]  # type: ignore[attr-defined]


def sent_text(turn: AgentTurn) -> str:
    return "\n".join(message.content for message in turn.messages)


async def test_undo_of_the_agents_first_profile_write_drops_the_session_that_holds_it(me_live: Env) -> None:
    chat = await me_live.chat()
    _profile_write(me_live)
    answer = await me_live.answered(chat["id"], "Я живу в Казани")
    [part] = chips(answer, "memory")
    assert (await me_live.client.post(f"/kb/me/edits/{part['edit_id']}/undo")).status_code == 200
    await deletions_done(me_live)
    # The session holds the profile line the agent wrote: gone with it at once, not at the next answer.
    assert engine(me_live).deleted_sessions == ["codex-session-1"]
    assert session_row(me_live, chat["id"]) is None
    await me_live.answered(chat["id"], "Второй вопрос")
    turn = answers(me_live)[-1]
    assert turn.session == SessionPlan("start")
    assert "Lives in Kazan" not in turn.instructions + sent_text(turn)


async def test_undo_of_an_agents_profile_line_is_a_note_in_the_live_session(me_live: Env) -> None:
    await me_live.client.put("/kb/me/skills/profile", json={"text": PROFILE_TEXT})
    chat = await me_live.chat()
    await me_live.answered(chat["id"], "Первый вопрос")
    _profile_write(me_live)
    answer = await me_live.answered(chat["id"], "Я живу в Казани")
    [part] = chips(answer, "memory")
    assert (await me_live.client.post(f"/kb/me/edits/{part['edit_id']}/undo")).status_code == 200
    await me_live.answered(chat["id"], "Третий вопрос")
    turn = answers(me_live)[-1]
    assert turn.session == SessionPlan("continue", "codex-session-1")
    note = turn.messages[0].content
    assert note.startswith("[context] Me was updated. “Profile” now reads:")
    assert PROFILE_TEXT in note and "Lives in Kazan" not in note


async def test_profile_off_after_the_agents_first_profile_write_reseeds(me_live: Env) -> None:
    chat = await me_live.chat()
    _profile_write(me_live)
    await me_live.answered(chat["id"], "Я живу в Казани")
    assert (await me_live.client.put("/kb/me/skills/profile", json={"enabled": False})).status_code == 200
    await deletions_done(me_live)
    assert engine(me_live).deleted_sessions == ["codex-session-1"]
    await me_live.answered(chat["id"], "Второй вопрос")
    assert answers(me_live)[-1].session == SessionPlan("start")


# -- 5. switched off / cleared → every session holding it goes at once ---------------------------------


@pytest.mark.parametrize(("path", "body"), [
    ("/kb/me/skills/how-to-work", {"text": ""}),
    ("/kb/me/skills/how-to-work", {"enabled": False}),
    ("/kb/me/skills/profile", {"enabled": False}),
    ("/kb/me", {"enabled": False}),
])
async def test_switching_off_or_clearing_what_a_session_holds_drops_it_at_once(
        me_live: Env, path: str, body: dict[str, Any]) -> None:
    await me_live.client.put("/kb/me/skills/profile", json={"text": PROFILE_TEXT})
    await me_live.client.put("/kb/me/skills/how-to-work", json={"text": HOW_TEXT})
    held = await me_live.chat()
    await me_live.answered(held["id"], "Первый вопрос")
    assert (await me_live.client.put(path, json=body)).status_code == 200
    await deletions_done(me_live)
    assert engine(me_live).deleted_sessions == ["codex-session-1"] and pending(me_live) == []
    assert session_row(me_live, held["id"]) is None
    await me_live.answered(held["id"], "Второй вопрос")
    turn = answers(me_live)[-1]
    assert turn.session == SessionPlan("start") and "Первый вопрос" in sent_text(turn)


async def test_a_change_the_session_can_take_as_a_note_keeps_it(me_live: Env) -> None:
    await me_live.client.put("/kb/me/skills/how-to-work", json={"text": HOW_TEXT})
    chat = await me_live.chat()
    await me_live.answered(chat["id"], "Первый вопрос")
    await me_live.client.put("/kb/me/skills/how-to-work", json={"text": "Answer in bullet points."})
    await me_live.client.put("/kb/me/skills/search", json={"enabled": False})
    await deletions_done(me_live)
    assert engine(me_live).deleted_sessions == [] and session_row(me_live, chat["id"]) is not None


# -- 7. no «Я» text in the chat database, for any skill ------------------------------------------------


async def test_memory_parts_carry_no_me_text_for_any_skill_but_show_it(me_live: Env) -> None:
    secrets = ("Prefers short answers QX-HOW", "arXiv first QX-SEARCH", "ten questions QX-DRILL",
               "Exam drill QX-TITLE")
    engine(me_live).calls = [  # type: ignore[attr-defined]
        (EDIT_TOOL, {"action": "append", "skill_id": "how-to-work", "text": secrets[0]}),
        (EDIT_TOOL, {"action": "append", "skill_id": "search", "text": secrets[1]}),
        (EDIT_TOOL, {"action": "create", "title": secrets[3], "description": "drills",
                     "text": secrets[2]}),
    ]
    chat = await me_live.chat()
    answer = await me_live.answered(chat["id"], "Запомни, как мне удобно")
    shown = chips(answer, "memory")
    assert [part["summary"] for part in shown] == [f"+ {secrets[0]}", f"+ {secrets[1]}",
                                                   f"New skill “{secrets[3]}”"]
    assert shown[2]["skill_title"] == secrets[3]
    raw = b"".join(path.read_bytes() for path in me_live.runtime.kb.data_dir.glob("knowledge.sqlite3*"))
    for secret in (*secrets, "QX-"):
        assert secret.encode() not in raw
    # Undone: the chip still shows what was undone, the database still holds none of it.
    undone = await me_live.client.post(f"/kb/me/edits/{shown[0]['edit_id']}/undo")
    assert undone.status_code == 200
    [first, *_] = chips(await me_live.message(chat["id"], answer["id"]), "memory")
    assert first["undone"] is True and first["summary"] == f"+ {secrets[0]}"
    raw = b"".join(path.read_bytes() for path in me_live.runtime.kb.data_dir.glob("knowledge.sqlite3*"))
    assert b"QX-" not in raw


# -- 4. deletion retries ---------------------------------------------------------------------------------


async def test_a_failed_deletion_backs_off_in_time_instead_of_burning_attempts(env: Env) -> None:
    chat = await env.chat()
    await env.answered(chat["id"], "Вопрос")
    engine(env).delete_failures = MAX_DELETE_ATTEMPTS + 1
    assert (await env.client.delete(f"/kb/chats/{chat['id']}")).status_code == 204
    await deletions_done(env)
    assert engine(env).delete_calls == ["codex-session-1"]
    for _ in range(MAX_DELETE_ATTEMPTS):  # passes right after: not due yet
        await env.chats.delete_sessions()
    assert engine(env).delete_calls == ["codex-session-1"] and pending(env) == [("codex", "codex-session-1")]
    env.chats.sessions.clock = lambda: later(90)
    await env.chats.delete_sessions()
    assert len(engine(env).delete_calls) == 2


async def test_a_missing_or_updating_agent_costs_no_attempt(env: Env) -> None:
    chat = await env.chat()
    await env.answered(chat["id"], "Вопрос")
    engine(env).delete_deferred = True
    assert (await env.client.delete(f"/kb/chats/{chat['id']}")).status_code == 204
    await deletions_done(env)
    for hours in range(1, MAX_DELETE_ATTEMPTS + 3):
        env.chats.sessions.clock = lambda hours=hours: later(60 * 24 * hours)
        await env.chats.delete_sessions()
    assert [item.attempts for item in env.chats.sessions.pending()] == [0]
    # The agent is being updated / repaired (U1 gate): not even tried.
    engine(env).delete_deferred = False
    calls = len(engine(env).delete_calls)
    env.chats.hold_deletions = lambda engine_id: engine_id == "codex"
    await env.chats.delete_sessions()
    assert len(engine(env).delete_calls) == calls and pending(env) == [("codex", "codex-session-1")]
    env.chats.hold_deletions = lambda _engine_id: False
    await env.chats.delete_sessions()
    assert engine(env).deleted_sessions == ["codex-session-1"] and pending(env) == []


async def test_a_given_up_session_drops_the_agents_local_traces(env: Env) -> None:
    chat = await env.chat()
    await env.answered(chat["id"], "Вопрос")
    engine(env).delete_failures = MAX_DELETE_ATTEMPTS + 1
    assert (await env.client.delete(f"/kb/chats/{chat['id']}")).status_code == 204
    await deletions_done(env)
    for day in range(1, MAX_DELETE_ATTEMPTS + 1):
        env.chats.sessions.clock = lambda day=day: later(60 * 24 * day)
        await env.chats.delete_sessions()
    assert pending(env) == [] and engine(env).forgotten == ["codex-session-1"]
    assert len(engine(env).delete_calls) == MAX_DELETE_ATTEMPTS


async def test_an_app_start_tries_every_queued_session_once_whatever_the_backoff(env: Env) -> None:
    chat = await env.chat()
    await env.answered(chat["id"], "Вопрос")
    engine(env).delete_failures = 1
    assert (await env.client.delete(f"/kb/chats/{chat['id']}")).status_code == 204
    await deletions_done(env)
    assert pending(env) == [("codex", "codex-session-1")]
    env.chats.start()
    await deletions_done(env)
    assert engine(env).deleted_sessions == ["codex-session-1"] and pending(env) == []


async def test_the_end_of_a_deleted_chats_answer_runs_the_deletions(env: Env) -> None:
    """A pass that ran while the answer was still bound to the session skipped it; the answer's end
    starts the next pass."""
    chat = await env.chat()
    await env.answered(chat["id"], "Вопрос")
    gate = asyncio.Event()
    from skaz.knowledge.agents.fake import Gate
    env.agents.scripts["codex"] = lambda _turn: [*text("Начал"), Gate(gate)]
    await env.ask(chat["id"], "Второй")
    for _ in range(300):
        if env.chats._runs.get(chat["id"]) is not None and env.chats._runs[chat["id"]].bound is not None:
            break
        await asyncio.sleep(0.01)
    env.chats.sessions.drop(chat["id"])  # e.g. a sign-out queued it while the answer runs
    await env.chats.delete_sessions()
    assert engine(env).delete_calls == []  # bound to the running answer: waits
    run = env.chats._runs[chat["id"]]
    run.deleted = True  # the chat is being deleted: the answer records nothing
    gate.set()
    await finished(env.chats)
    await deletions_done(env)
    assert engine(env).deleted_sessions == ["codex-session-1"]


# -- 9. the fixed instructions a session started with ------------------------------------------------------


def test_the_fixed_instructions_hash_covers_the_expanded_texts(monkeypatch: pytest.MonkeyPatch) -> None:
    base = live_module.base_instructions()
    assert base == live_module.BASE_INSTRUCTIONS
    monkeypatch.setattr(context_module, "block_index", lambda: "- a new block")
    assert live_module.base_instructions() != base
    monkeypatch.undo()
    monkeypatch.setattr(codex_module, "BASE_INSTRUCTIONS", "Other Codex base text.")
    assert live_module.base_instructions() != base
    monkeypatch.undo()
    monkeypatch.setattr(me_prompt, "ME_RULES", "Other Me rules.")
    assert live_module.base_instructions() != base


# -- 3. the start-up sweep of agents' local sessions ---------------------------------------------------


async def test_an_app_start_asks_each_engine_to_sweep_sessions_nothing_knows(env: Env) -> None:
    chat = await env.chat()
    await env.answered(chat["id"], "Вопрос")
    gone = await env.chat()
    await env.answered(gone["id"], "Удалю")
    engine(env).delete_failures = 1
    assert (await env.client.delete(f"/kb/chats/{gone['id']}")).status_code == 204
    await deletions_done(env)
    seen: dict[str, bool] = {}

    async def sweep(known: Any) -> None:
        for session_id in ("codex-session-1", "codex-session-2", "codex-orphan"):
            seen[session_id] = known(session_id)

    engine(env).sweep_sessions = sweep  # type: ignore[attr-defined]
    env.chats.start()
    assert env.chats._sweeping is not None
    await asyncio.wait_for(asyncio.shield(env.chats._sweeping), 5)
    # Held by a chat, or waiting in the deletion list: known; anything else is the engine's to remove.
    assert seen == {"codex-session-1": True, "codex-session-2": True, "codex-orphan": False}


async def test_an_agent_update_holds_its_session_deletions_without_an_attempt(env: Env) -> None:
    from skaz.knowledge.agents.update_gate import UpdateGate, guard
    gate = UpdateGate()
    guard(engine(env), gate)
    chat = await env.chat()
    await env.answered(chat["id"], "Вопрос")
    async with gate.exclusive("codex"):  # an update of Codex runs
        assert (await env.client.delete(f"/kb/chats/{chat['id']}")).status_code == 204
        await deletions_done(env)
        assert engine(env).delete_calls == [] and pending(env) == [("codex", "codex-session-1")]
    await env.chats.delete_sessions()
    assert engine(env).deleted_sessions == ["codex-session-1"] and pending(env) == []
