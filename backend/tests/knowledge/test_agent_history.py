"""One bounded chat history for every agent (slice 3 of the call audit, .dev/docs/CODEX-CALLS-AUDIT.md).

Codex had a 60k-character history window; Claude Code, Hermes and OpenCode got the whole chat, so a
long chat could outgrow their context window and cost more on every answer. All four now take the
same window. Its start moves only in whole steps of about a quarter of the budget, counted from the
start of the chat, so consecutive answers share the same history prefix (cacheable by providers that
cache by prefix) instead of shifting by one message every time.
"""
from __future__ import annotations

import json
from itertools import pairwise as pairs_of

from skaz.knowledge.agents.codex import turn_input
from skaz.knowledge.agents.engine import AgentTurn, TurnMessage
from skaz.knowledge.agents.history import (
    HISTORY_BUDGET_CHARS,
    HISTORY_MESSAGE_CHARS,
    HISTORY_STEP_CHARS,
    window,
)
from skaz.knowledge.agents.transcript import render_prompt


def _chat(pairs: int, size: int = 3_000) -> list[TurnMessage]:
    messages: list[TurnMessage] = []
    for n in range(pairs):
        messages.append(TurnMessage("user", f"q{n} " + "в" * size))
        messages.append(TurnMessage("assistant", f"a{n} " + "о" * size, engine="codex"))
    return messages


def _prompt(messages: list[TurnMessage]) -> str:
    turn = AgentTurn(run_id="r", messages=(*messages, TurnMessage("user", "now")), instructions="rules",
                     tools=None)
    return render_prompt(turn, include_instructions=False, include_schema=False)


def test_cli_agents_get_a_bounded_history_that_keeps_the_newest() -> None:
    prompt = _prompt(_chat(60))  # 360k characters of chat
    assert len(prompt) < HISTORY_BUDGET_CHARS + 5_000
    assert "a59 " in prompt and "q0 " not in prompt
    assert "earlier messages of this chat were left out" in prompt
    assert prompt.endswith("Current request:\nnow")


def test_a_short_chat_is_sent_whole_and_unchanged() -> None:
    messages = _chat(3, size=100)
    assert window(messages).omitted == 0 and window(messages).messages == tuple(messages)
    assert "left out" not in _prompt(messages)


def test_one_huge_message_is_shortened_in_the_middle() -> None:
    kept = window([TurnMessage("user", "начало " + "ж" * 50_000 + " конец")]).messages
    assert len(kept[0].content) <= HISTORY_MESSAGE_CHARS + 100
    assert kept[0].content.startswith("начало") and kept[0].content.endswith("конец")


def test_the_window_start_moves_in_steps_so_answers_share_a_prefix() -> None:
    answers = range(30, 130)  # the chat grows answer by answer (2k characters each), far past the budget
    starts = [window(_chat(pairs, size=1_000)).omitted for pairs in answers]
    moves = sum(1 for before, after in pairs_of(starts) if after != before)
    # A window sliding by one message would move on every one of these 100 answers.
    added = len(answers) * 2 * 1_000
    assert moves <= added // HISTORY_STEP_CHARS + 2
    assert all(after >= before for before, after in pairs_of(starts))


def test_codex_and_the_cli_agents_cut_the_same_history() -> None:
    messages = _chat(40)
    first_kept = window(messages).messages[0].content[:4]
    codex = turn_input((*messages, TurnMessage("user", "now")))
    lines = [json.loads(line) for line in codex.split("\n") if line.startswith('{"role"')]
    assert lines[0]["content"].startswith(first_kept)
    assert f"{first_kept}" in _prompt(messages)
