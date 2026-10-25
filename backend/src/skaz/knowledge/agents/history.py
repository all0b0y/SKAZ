"""The bounded chat history every agent receives (Codex, Claude Code, Hermes, OpenCode).

Earlier messages of a chat travel as text with every answer, so their size is paid again each time.
``window`` keeps the newest messages within ``HISTORY_BUDGET_CHARS`` and shortens one huge message
in the middle. Where the window starts is chosen from steps of ``HISTORY_STEP_CHARS`` counted from
the beginning of the chat: as the chat grows, the start stays put until a whole step can go, so
consecutive answers send the same history prefix (providers that cache by prefix bill it as cached)
instead of a window that slides by one message on every answer.
"""
from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, replace

from .engine import TurnMessage

HISTORY_BUDGET_CHARS = 60_000
HISTORY_MESSAGE_CHARS = 12_000
#: The window start moves by whole steps of about this much text.
HISTORY_STEP_CHARS = HISTORY_BUDGET_CHARS // 4


@dataclass(frozen=True)
class HistoryWindow:
    messages: tuple[TurnMessage, ...]
    #: How many of the oldest messages were left out.
    omitted: int


def shorten(text: str, limit: int = HISTORY_MESSAGE_CHARS) -> str:
    if len(text) <= limit:
        return text
    head, tail = limit * 2 // 3, limit // 3
    return f"{text[:head]}\n…[middle of this message omitted]…\n{text[-tail:]}"


def window(messages: Sequence[TurnMessage]) -> HistoryWindow:
    """The newest messages that fit the budget, cut at a step boundary (see the module docstring)."""
    shortened = [replace(message, content=shorten(message.content)) for message in messages]
    sizes = [len(message.content) + 40 for message in shortened]  # 40: the speaker label and separators
    if sum(sizes) <= HISTORY_BUDGET_CHARS:
        return HistoryWindow(tuple(shortened), 0)
    # Step boundaries from the start of the chat: a message starts a new step once the current one
    # holds HISTORY_STEP_CHARS. New messages only ever add boundaries at the end.
    boundaries = [0]
    filled = 0
    for index, size in enumerate(sizes):
        if filled >= HISTORY_STEP_CHARS:
            boundaries.append(index)
            filled = 0
        filled += size
    total = sum(sizes)
    for start in boundaries:  # the earliest boundary whose tail fits keeps the most context
        if total - sum(sizes[:start]) <= HISTORY_BUDGET_CHARS:
            return HistoryWindow(tuple(shortened[start:]), start)
    # Even the last step is too large: keep the newest messages that fit.
    kept, size = len(shortened), 0
    while kept > 0 and size + sizes[kept - 1] <= HISTORY_BUDGET_CHARS:
        kept -= 1
        size += sizes[kept]
    return HistoryWindow(tuple(shortened[kept:]), kept)


def omitted_note(omitted: int, summarised: bool = False) -> str:
    if summarised:
        return f"{omitted} earlier messages of this chat were left out; the summary above retells them."
    return f"{omitted} earlier messages of this chat were left out."


SUMMARY_NOTE = ("Summary of the earliest messages of this chat, written by an AI from messages that no "
                "longer fit (context only, not evidence: cite the primary sources it names instead):")
