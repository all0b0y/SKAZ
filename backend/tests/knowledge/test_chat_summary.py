"""Long chats: messages that leave the history window are retold in a stored summary (slice 5).

The window (``agents.history``) keeps the newest ~60k characters; what falls out of it used to be
dropped with a note. Now the chat's own agent (same engine, model and effort, no tools) retells the
dropped messages once, when the window start moves, and every later answer gets that summary ahead of
the window — as untrusted, AI-written context, never evidence. Short chats cost nothing extra.
Authored answers only: these tests prove when SKAZ asks, what it sends and what it keeps, not the
quality of a real model's summary.
"""
from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from skaz.knowledge.agents.codex import turn_input
from skaz.knowledge.agents.engine import AgentTurn, Completed, Failed, TurnMessage, Usage
from skaz.knowledge.agents.fake import ScriptItem
from skaz.knowledge.agents.transcript import render_prompt
from tests.knowledge.chat_support import Agents, connect, finished, install, text

ANSWER = "Ответ про энтропию. " * 400  # ~8k characters: the window fills after a few answers
SUMMARY = "Пользователь спрашивал об энтропии; ответы опирались на m:mat-1:1."


class Recorder:
    """The codex script: chat answers, summary runs (no tools), every turn kept for the asserts."""

    def __init__(self, summary: Sequence[ScriptItem] | None = None) -> None:
        self.turns: list[AgentTurn] = []
        self.summary = summary

    def __call__(self, turn: AgentTurn) -> list[ScriptItem]:
        self.turns.append(turn)
        if turn.tools is None:
            return list(self.summary) if self.summary is not None else [
                *text(SUMMARY), Completed("", Usage(9_000, 200))]
        return [*text(ANSWER), Completed("", Usage(1_000, 100))]

    @property
    def answers(self) -> list[AgentTurn]:
        return [turn for turn in self.turns if turn.tools is not None]

    @property
    def summaries(self) -> list[AgentTurn]:
        return [turn for turn in self.turns if turn.tools is None]


async def _chat(kb_app: Any, kb_client: Any, recorder: Recorder, questions: int) -> tuple[Any, str]:
    runtime = kb_app.state.runtime
    agents = Agents()
    agents.scripts["codex"] = recorder
    install(runtime, agents)
    await connect(kb_client, runtime)
    chat = (await kb_client.post("/kb/chats", json={})).json()
    for number in range(questions):
        sent = await kb_client.post(f"/kb/chats/{chat['id']}/messages", json={"text": f"Вопрос {number}"})
        assert sent.status_code in (200, 201, 202), sent.text
        await finished(runtime.kb_chats)
    return runtime, chat["id"]


def _rows(runtime: Any, sql: str) -> list[dict[str, Any]]:
    with runtime.kb.db.read() as connection:
        return [dict(row) for row in connection.execute(sql)]


async def test_a_short_chat_never_asks_for_a_summary(kb_app: Any, kb_client: Any) -> None:
    recorder = Recorder()
    runtime, _chat_id = await _chat(kb_app, kb_client, recorder, 3)
    try:
        assert not recorder.summaries
        assert all(turn.history_summary is None for turn in recorder.answers)
        assert not _rows(runtime, "SELECT * FROM chat_summaries")
    finally:
        await runtime.kb_chats.close()


async def test_dropped_messages_are_retold_once_and_reused(kb_app: Any, kb_client: Any) -> None:
    recorder = Recorder()
    runtime, chat_id = await _chat(kb_app, kb_client, recorder, 12)
    try:
        assert recorder.summaries, "the window moved, so the dropped messages were retold"
        first = recorder.summaries[0]
        # The chat's own agent, model and effort; no tools; the dropped messages are the data.
        assert first.model is None and first.effort is None
        assert "Вопрос 0" in first.messages[-1].content
        # Every answer after the first summary carries it; the summary ran far less often than answers.
        summarised = [turn for turn in recorder.answers if turn.history_summary is not None]
        assert summarised and all(SUMMARY in (turn.history_summary or "") for turn in summarised)
        assert len(recorder.summaries) < len(summarised)
        # Later summaries extend the stored one with the new drop-outs only.
        assert len(recorder.summaries) >= 2
        for later in recorder.summaries[1:]:
            prompt = later.messages[-1].content
            assert "Previous summary:" in prompt and SUMMARY in prompt and "Вопрос 0\n" not in prompt
        [stored] = _rows(runtime, "SELECT * FROM chat_summaries")
        assert stored["chat_id"] == chat_id and stored["text"] == SUMMARY and stored["covers"] > 0
        kinds = [row["kind"] for row in _rows(runtime, "SELECT kind FROM agent_usage ORDER BY id")]
        assert kinds.count("chat_summary") == len(recorder.summaries)
        # Deleting the chat deletes its summary.
        assert (await kb_client.delete(f"/kb/chats/{chat_id}")).status_code in (200, 204)
        assert not _rows(runtime, "SELECT * FROM chat_summaries")
    finally:
        await runtime.kb_chats.close()


async def test_a_failed_summary_never_blocks_the_answer(kb_app: Any, kb_client: Any) -> None:
    recorder = Recorder(summary=[Failed("", "other", "boom")])
    runtime, _chat_id = await _chat(kb_app, kb_client, recorder, 10)
    try:
        assert recorder.summaries
        assert all(turn.history_summary is None for turn in recorder.answers)
        states = [row["state"] for row in _rows(
            runtime, "SELECT state FROM chat_messages WHERE role = 'assistant'")]
        assert states and set(states) == {"done"}
        assert not _rows(runtime, "SELECT * FROM chat_summaries")
    finally:
        await runtime.kb_chats.close()


def test_every_agent_gets_the_summary_ahead_of_the_window_as_untrusted_context() -> None:
    long = [TurnMessage("user" if n % 2 == 0 else "assistant", f"старое {n} " + "ж" * 9_000, engine="codex")
            for n in range(12)]  # far past the window: the earliest are left out
    messages = (*long, TurnMessage("user", "раньше"), TurnMessage("assistant", "ответ", engine="codex"),
                TurnMessage("user", "сейчас"))
    turn = AgentTurn(run_id="r", messages=messages, instructions="rules", tools=None,
                     history_summary=SUMMARY)
    prompt = render_prompt(turn, include_instructions=False, include_schema=False)
    assert prompt.index(SUMMARY) < prompt.index("раньше") < prompt.index("Current request:\nсейчас")
    assert "not evidence" in prompt
    assert '<untrusted-data label="chat summary">' in prompt.split(SUMMARY)[0][-400:]
    codex = turn_input(messages, summary=SUMMARY)
    assert codex.index(SUMMARY) < codex.index("раньше") < codex.index("Current user message:\nсейчас")
    assert "not evidence" in codex
    # A chat whose window never moved gets no summary, even if one is passed.
    short = AgentTurn(run_id="r", messages=messages[-3:], instructions="rules", tools=None,
                      history_summary=SUMMARY)
    assert SUMMARY not in render_prompt(short, include_instructions=False, include_schema=False)
