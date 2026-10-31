"""N6: a SKAZ chat is one live agent session (prefix sync in ``ChatService``; fake engines at the seam).

The fake Codex here declares live sessions with revert: a turn with a plan first reports
``SessionBound`` (``codex-session-N`` for a new session, ``turn-N`` per turn). These tests prove what
SKAZ plans, sends, records and deletes — not a real agent's memory (the live probe is the user's).
"""
from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest

from skaz.knowledge.agents.engine import (
    AgentTurn,
    Compacted,
    Failed,
    SessionPlan,
    SessionSupport,
    TextDelta,
)
from skaz.knowledge.agents.fake import FakeEngine, ScriptItem
from skaz.knowledge.chats.live import COMPACTED_NOTE, MAX_DELETE_ATTEMPTS
from skaz.knowledge.chats.service import ChatService
from skaz.knowledge.ingest.settings import WIKI_LANGUAGE
from skaz.knowledge.skills.settings import set_enabled
from tests.knowledge.chat_support import Agents, all_text, connect, finished, install, limit_failure, text
from tests.knowledge.test_chats_api import Env

LIVE = SessionSupport(live=True, revert=True)


@pytest.fixture
async def env(kb_app: Any, kb_client: httpx.AsyncClient) -> AsyncIterator[Env]:
    runtime = kb_app.state.runtime
    agents = Agents()
    agents.engines["codex"].session_support = LIVE
    install(runtime, agents)
    library = await connect(kb_client, runtime)
    yield Env(kb_client, runtime, runtime.kb_chats, agents, library)
    await runtime.kb_chats.close()


def codex(env: Env) -> FakeEngine:
    return env.agents.engines["codex"]


def answers(env: Env) -> list[AgentTurn]:
    """Chat answers only (summary runs have no tools)."""
    return [turn for turn in codex(env).turns if turn.tools is not None]


def only(turn: AgentTurn, question: str) -> bool:
    """The turn carries one message: the current question (with the library context SKAZ adds to it)."""
    return len(turn.messages) == 1 and turn.messages[0].content.endswith(question)


def sent(turn: AgentTurn) -> str:
    return "\n".join(message.content for message in turn.messages)


def session_rows(env: Env, chat_id: str) -> list[dict[str, Any]]:
    with env.runtime.kb.db.read() as connection:
        return [dict(row) for row in connection.execute(
            "SELECT message_id, turn_id FROM agent_session_items WHERE chat_id = ? ORDER BY ord", (chat_id,))]


def pending(env: Env) -> list[tuple[str, str]]:
    return [(item.engine, item.session_id) for item in env.runtime.kb_chats.sessions.pending()]


async def deletions_done(env: Env) -> None:
    task = env.chats._deleting
    if task is not None:
        await asyncio.wait_for(asyncio.shield(task), 5)


async def test_the_second_answer_continues_the_session_with_only_the_new_message(env: Env) -> None:
    chat = await env.chat()
    first = await env.answered(chat["id"], "Что такое энтропия? KIWI-WORD")
    second = await env.answered(chat["id"], "А при чём тут Клаузиус?")
    assert first["state"] == second["state"] == "done"
    start, follow = answers(env)
    assert start.session == SessionPlan("start")
    assert follow.session == SessionPlan("continue", "codex-session-1")
    assert only(follow, "А при чём тут Клаузиус?")
    assert "KIWI-WORD" not in sent(follow) and follow.history_summary is None
    rows = session_rows(env, chat["id"])
    assert [row["turn_id"] for row in rows] == ["turn-1", "turn-1", "turn-2", "turn-2"]
    assert rows[1]["message_id"] == first["id"] and rows[3]["message_id"] == second["id"]
    # A model change keeps the session: the model goes with the turn (decision 12).
    changed = await env.client.patch(f"/kb/chats/{chat['id']}", json={"model": "fake-model"})
    assert changed.status_code == 200
    await env.answered(chat["id"], "Третий вопрос")
    assert answers(env)[-1].session == SessionPlan("continue", "codex-session-1")
    assert answers(env)[-1].model == "fake-model"


async def test_editing_the_last_question_reverts_its_turn_and_never_resends_dropped_text(env: Env) -> None:
    chat = await env.chat()
    await env.answered(chat["id"], "Первый вопрос")
    env.agents.scripts["codex"] = lambda _turn: text("Кодовое слово MANGO.")
    await env.answered(chat["id"], "Запомни кодовое слово")
    env.agents.scripts["codex"] = lambda _turn: text("OK.")
    question = next(m for m in (await env.client.get(f"/kb/chats/{chat['id']}")).json()["messages"]
                    if m["role"] == "user" and m["input"]["text"] == "Запомни кодовое слово")
    edited = await env.client.post(f"/kb/chats/{chat['id']}/messages/{question['id']}/edit",
                                   json={"text": "Какое было кодовое слово?"})
    assert edited.status_code == 202
    await finished(env.chats)
    turn = answers(env)[-1]
    assert turn.session == SessionPlan("revert", "codex-session-1", "turn-2")
    assert only(turn, "Какое было кодовое слово?")
    assert "MANGO" not in sent(turn) and "Запомни" not in sent(turn)
    turns = [row["turn_id"] for row in session_rows(env, chat["id"])]
    assert turns == ["turn-1", "turn-1", "turn-3", "turn-3"]
    await env.answered(chat["id"], "Дальше")
    assert answers(env)[-1].session == SessionPlan("continue", "codex-session-1")


async def test_regenerating_the_last_answer_reverts_and_the_chat_continues(env: Env) -> None:
    chat = await env.chat()
    await env.answered(chat["id"], "Первый вопрос")
    last = await env.answered(chat["id"], "Второй вопрос")
    again = await env.client.post(f"/kb/chats/{chat['id']}/messages/{last['id']}/regenerate")
    assert again.status_code == 202
    await finished(env.chats)
    turn = answers(env)[-1]
    assert turn.session == SessionPlan("revert", "codex-session-1", "turn-2")
    assert only(turn, "Второй вопрос")
    # The replaced answer stays in the chat but not in the session: the next question continues.
    await env.answered(chat["id"], "Третий вопрос")
    assert answers(env)[-1].session == SessionPlan("continue", "codex-session-1")
    assert codex(env).deleted_sessions == []


async def test_resuming_an_interrupted_last_answer_reverts_its_unrecorded_turn(env: Env) -> None:
    chat = await env.chat()
    await env.answered(chat["id"], "Первый вопрос")
    env.agents.scripts["codex"] = lambda _turn: [*text("Половина отв"), limit_failure()]
    broken = await env.answered(chat["id"], "Второй вопрос")
    assert broken["state"] == "interrupted"
    rows = session_rows(env, chat["id"])
    assert [row["turn_id"] for row in rows] == ["turn-1", "turn-1"]  # the failed answer records nothing
    env.agents.scripts["codex"] = lambda _turn: text("OK.")
    resumed = await env.client.post(f"/kb/chats/{chat['id']}/messages/{broken['id']}/resume")
    assert resumed.status_code == 202
    await finished(env.chats)
    turn = answers(env)[-1]
    assert turn.session == SessionPlan("revert", "codex-session-1", "turn-2")
    assert only(turn, "Второй вопрос")


async def test_regenerating_an_old_answer_reverts_or_reseeds_and_never_keeps_a_stale_tail(env: Env) -> None:
    chat = await env.chat()
    first = await env.answered(chat["id"], "Первый вопрос")
    middle = await env.answered(chat["id"], "Второй вопрос")
    await env.answered(chat["id"], "Третий вопрос")
    # A middle answer: dropping its turn and every later one leaves exactly the history before it.
    again = await env.client.post(f"/kb/chats/{chat['id']}/messages/{middle['id']}/regenerate")
    assert again.status_code == 202
    await finished(env.chats)
    assert answers(env)[-1].session == SessionPlan("revert", "codex-session-1", "turn-2")
    # The chat now holds the old tail too (Q3, A3), which the session lost: the next answer reseeds.
    await env.answered(chat["id"], "Четвёртый вопрос")
    reseed = answers(env)[-1]
    assert reseed.session == SessionPlan("start")
    assert "Третий вопрос" in sent(reseed) and "Четвёртый вопрос" in sent(reseed)
    await deletions_done(env)
    assert codex(env).deleted_sessions == ["codex-session-1"]
    # The very first answer: its turn was the seed, nothing is left to revert to: a new session.
    again = await env.client.post(f"/kb/chats/{chat['id']}/messages/{first['id']}/regenerate")
    assert again.status_code == 202
    await finished(env.chats)
    assert answers(env)[-1].session == SessionPlan("start")
    await deletions_done(env)
    assert codex(env).deleted_sessions == ["codex-session-1", "codex-session-2"]


async def test_an_engine_switch_deletes_the_old_session_and_switching_back_reseeds(env: Env) -> None:
    chat = await env.chat()
    await env.answered(chat["id"], "Вопрос для Codex KIWI-WORD")
    switched = await env.client.patch(f"/kb/chats/{chat['id']}", json={"engine": "hermes"})
    assert switched.status_code == 200
    await deletions_done(env)
    assert codex(env).deleted_sessions == ["codex-session-1"] and pending(env) == []
    await env.answered(chat["id"], "Вопрос для Hermes")
    hermes = env.agents.engines["hermes"].turns[-1]
    assert hermes.session is None and "KIWI-WORD" in sent(hermes)  # stateless engines: today's behaviour
    assert (await env.client.patch(f"/kb/chats/{chat['id']}", json={"engine": "codex"})).status_code == 200
    await env.answered(chat["id"], "Снова Codex")
    back = answers(env)[-1]
    assert back.session == SessionPlan("start")
    assert "KIWI-WORD" in sent(back) and "Вопрос для Hermes" in sent(back)


async def test_deleting_a_chat_deletes_its_session_and_a_failed_delete_survives_a_restart(env: Env) -> None:
    chat = await env.chat()
    await env.answered(chat["id"], "Вопрос")
    codex(env).delete_failures = 1
    assert (await env.client.delete(f"/kb/chats/{chat['id']}")).status_code == 204
    await deletions_done(env)
    assert codex(env).deleted_sessions == [] and pending(env) == [("codex", "codex-session-1")]
    # A restart: a new service over the same database finds the queued session and deletes it — an app
    # start tries every queued session once, whatever its backoff (FIX-1: a failure waits before a retry).
    restarted = ChatService(env.runtime.kb, agents=lambda: env.runtime.kb_agents.registry,
                            tools=env.chats.tools)
    assert await restarted.delete_sessions() == 1  # backed off: not due yet
    restarted.start()
    assert restarted._deleting is not None
    await asyncio.wait_for(asyncio.shield(restarted._deleting), 5)
    assert codex(env).deleted_sessions == ["codex-session-1"] and pending(env) == []
    await restarted.close()


async def test_a_session_that_never_deletes_is_given_up_after_the_attempt_limit(env: Env) -> None:
    chat = await env.chat()
    await env.answered(chat["id"], "Вопрос")
    codex(env).delete_failures = MAX_DELETE_ATTEMPTS + 1
    assert (await env.client.delete(f"/kb/chats/{chat['id']}")).status_code == 204
    await deletions_done(env)
    for day in range(1, MAX_DELETE_ATTEMPTS):  # FIX-1: each retry waits for its backoff
        def clock(day: int = day) -> datetime:
            return datetime.now(UTC) + timedelta(days=day)
        env.chats.sessions.clock = clock
        await env.chats.delete_sessions()
    assert pending(env) == [] and codex(env).deleted_sessions == []


async def test_sign_out_deletes_the_engines_sessions_first(env: Env) -> None:
    chat = await env.chat()
    await env.answered(chat["id"], "Вопрос")
    await env.chats.end_sessions("codex")
    assert codex(env).deleted_sessions == ["codex-session-1"] and pending(env) == []
    await env.answered(chat["id"], "После выхода")
    assert answers(env)[-1].session == SessionPlan("start")


async def test_a_failed_answer_records_nothing_and_the_next_question_reseeds(env: Env) -> None:
    chat = await env.chat()
    await env.answered(chat["id"], "Первый вопрос")
    env.agents.scripts["codex"] = lambda _turn: [*text("Начал"), Failed("", "other", "boom")]
    failed = await env.answered(chat["id"], "Второй вопрос")
    assert failed["state"] == "failed"
    assert [row["turn_id"] for row in session_rows(env, chat["id"])] == ["turn-1", "turn-1"]
    env.agents.scripts["codex"] = lambda _turn: text("OK.")
    await env.answered(chat["id"], "Третий вопрос")
    turn = answers(env)[-1]
    # The unanswered question is history the session never recorded: correctness over cache.
    assert turn.session == SessionPlan("start") and "Второй вопрос" in sent(turn)
    await deletions_done(env)
    assert codex(env).deleted_sessions == ["codex-session-1"]


async def test_a_session_that_cant_be_continued_is_reseeded_once_not_in_a_loop(env: Env) -> None:
    chat = await env.chat()
    await env.answered(chat["id"], "Первый вопрос KIWI-WORD")
    lost = Failed("", "other", "Codex couldn't continue this chat's conversation.", unsent=True,
                  session_lost=True)

    def gone(turn: AgentTurn) -> list[ScriptItem]:
        return [lost] if turn.session is not None and turn.session.mode != "start" else text("Новая сессия.")

    env.agents.scripts["codex"] = gone
    answer = await env.answered(chat["id"], "Второй вопрос")
    assert answer["state"] == "done" and all_text(answer) == "Новая сессия."
    plans = [turn.session for turn in answers(env)]
    assert plans == [SessionPlan("start"), SessionPlan("continue", "codex-session-1"), SessionPlan("start")]
    assert "KIWI-WORD" in sent(answers(env)[-1])
    await deletions_done(env)
    assert codex(env).deleted_sessions == ["codex-session-1"]

    always: list[AgentTurn] = []

    def broken(turn: AgentTurn) -> list[ScriptItem]:
        always.append(turn)
        return [lost]

    env.agents.scripts["codex"] = broken
    codex(env).session_support = SessionSupport(live=True, revert=True)
    failed = await env.answered(chat["id"], "Третий вопрос")
    assert failed["state"] == "failed" and len(always) == 2  # one continue, one reseed, then it stops


async def test_compaction_leaves_a_history_compressed_line_in_the_chat(env: Env) -> None:
    chat = await env.chat()
    await env.answered(chat["id"], "Первый вопрос")
    env.agents.scripts["codex"] = lambda _turn: [TextDelta("", "Ответ"), Compacted(""), Compacted(""),
                                                 TextDelta("", " после сжатия.")]
    answer = await env.answered(chat["id"], "Второй вопрос")
    assert answer["state"] == "done"
    messages = (await env.client.get(f"/kb/chats/{chat['id']}")).json()["messages"]
    notes = [m for m in messages if m["role"] == "system"]
    assert len(notes) == 1 and all_text(notes[0]) == COMPACTED_NOTE and notes[0]["engine"] == "codex"
    # The note is SKAZ's, not history: the next turn continues the session.
    env.agents.scripts["codex"] = lambda _turn: text("OK.")
    await env.answered(chat["id"], "Третий вопрос")
    assert answers(env)[-1].session == SessionPlan("continue", "codex-session-1")


async def test_a_context_note_tells_the_session_about_a_setting_change_exactly_once(env: Env) -> None:
    chat = await env.chat()
    await env.answered(chat["id"], "Первый вопрос")
    set_enabled(env.runtime.kb.settings, "humanizer", False)
    env.runtime.kb.settings.set(WIKI_LANGUAGE, "en")
    await env.answered(chat["id"], "Второй вопрос")
    noted = answers(env)[-1].messages[-1].content
    assert noted.startswith("[context]") and noted.endswith("Второй вопрос")
    assert "humanizer" in noted and "wiki language is now en" in noted
    await env.answered(chat["id"], "Третий вопрос")
    assert only(answers(env)[-1], "Третий вопрос") and "[context]" not in sent(answers(env)[-1])


async def test_a_deleted_cited_material_is_noted_once(env: Env) -> None:
    chat = await env.chat()
    lecture = env.library.lecture
    env.agents.scripts["codex"] = lambda _turn: text(f"Энтропия ⟦m:{lecture}:1|мера беспорядка системы⟧.")
    await env.answered(chat["id"], "Что такое энтропия?")
    env.agents.scripts["codex"] = lambda _turn: text("OK.")
    env.runtime.kb_wiki.delete_material(lecture)  # the user deletes the material from the library
    await env.answered(chat["id"], "А ещё?")
    noted = answers(env)[-1].messages[-1].content
    assert f"Material {lecture} was deleted" in noted
    await env.answered(chat["id"], "И ещё?")
    assert only(answers(env)[-1], "И ещё?") and "[context]" not in sent(answers(env)[-1])


async def test_stateless_engines_and_summary_runs_get_no_session_plan(env: Env) -> None:
    chat = await env.chat(engine="hermes")
    await env.answered(chat["id"], "Первый вопрос")
    await env.answered(chat["id"], "Второй вопрос")
    turns = env.agents.engines["hermes"].turns
    assert [turn.session for turn in turns] == [None, None] and "Первый вопрос" in sent(turns[-1])
    with env.runtime.kb.db.read() as connection:
        assert connection.execute("SELECT COUNT(*) FROM agent_sessions").fetchone()[0] == 0


async def test_the_long_chat_summary_is_written_only_to_seed_a_new_session(env: Env) -> None:
    """Decision 13: on a live continue the agent compacts its own conversation; SKAZ's retelling of the
    messages that left the history window is used only when a new session is seeded."""
    long_answer = "Ответ про энтропию. " * 400  # ~8k characters: the history window fills after a few

    def script(turn: AgentTurn) -> list[ScriptItem]:
        return text("Пересказ ранних сообщений.") if turn.tools is None else text(long_answer)

    env.agents.scripts["codex"] = script
    env.agents.scripts["hermes"] = script
    chat = await env.chat()
    for number in range(9):
        await env.answered(chat["id"], f"Вопрос {number}")
    assert all(turn.tools is not None for turn in codex(env).turns)  # no summary run while it continues
    assert all(turn.history_summary is None for turn in answers(env)[1:])
    switched = await env.client.patch(f"/kb/chats/{chat['id']}", json={"engine": "hermes"})
    assert switched.status_code == 200
    assert (await env.client.patch(f"/kb/chats/{chat['id']}", json={"engine": "codex"})).status_code == 200
    await env.answered(chat["id"], "Снова Codex")
    summaries = [turn for turn in codex(env).turns if turn.tools is None]
    assert summaries and all(turn.session is None for turn in summaries)  # summary runs stay stateless
    seed = answers(env)[-1]
    assert seed.session == SessionPlan("start") and seed.history_summary == "Пересказ ранних сообщений."
    await env.answered(chat["id"], "И дальше")
    follow = answers(env)[-1]
    assert follow.session == SessionPlan("continue", "codex-session-2") and follow.history_summary is None
