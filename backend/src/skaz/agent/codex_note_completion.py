"""Assemble intentional multi-turn Notes, never append an interrupted attempt on resume."""
from __future__ import annotations

from collections.abc import Awaitable, Callable

from ..gateways import ProviderError
from ..gateways.codex_session import AgentSession, TurnResult
from .note_completion import (
    CONTINUE_REQUEST,
    MAX_DOCUMENT_CHARS,
    MAX_PARTS,
    check_progress,
    split_continuation,
)


async def ask_note(
    session: AgentSession, question: str, *, on_answer: Callable[[str], Awaitable[None]],
) -> TurnResult:
    # Local to one execution (and one correction). A resumed task starts over.
    parts: list[str] = []
    for _ in range(MAX_PARTS):
        current = ""

        async def checkpoint(text: str) -> None:
            nonlocal current
            current = text
            clean, _more = split_continuation(text)
            # Partial deltas may temporarily match an earlier paragraph. Check repetition
            # only at turn completion; bound size before exposing the growing document.
            if sum(map(len, parts)) + len(clean) > MAX_DOCUMENT_CHARS:
                raise ProviderError("The note exceeds the editor capacity; no note was saved.")
            await on_answer("".join(parts) + clean)

        result = await session.ask(question, on_answer=checkpoint)
        if result.status != "completed":
            return result
        # Only classified callback text is evidence; never the raw TurnResult tail.
        text, more = split_continuation(current)
        check_progress(parts, text)
        parts.append(text)
        if not more:
            return result
        question = CONTINUE_REQUEST
    raise ProviderError("The notes model did not finish after multiple responses; no note was saved.")
