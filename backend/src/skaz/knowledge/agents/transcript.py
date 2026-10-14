"""Turn an ``AgentTurn`` into the single prompt text CLI agents receive.

Claude Code (``-p``) and Hermes (ACP ``session/prompt``) take one user message
per run, so earlier messages of the chat — possibly written by another engine
after a switch — travel as context. Assistant text is model output, so the
whole earlier conversation enters only as an untrusted block (poisoning layer
6); the latest user message is the request.
"""
from __future__ import annotations

import json

from .engine import AgentTurn, TurnMessage
from .prompting import untrusted_block

_ENGINE_LABELS = {"codex": "Codex", "claude_code": "Claude Code", "hermes": "Hermes Agent"}


def _speaker(message: TurnMessage) -> str:
    if message.role == "user":
        return "User"
    return f"Assistant ({_ENGINE_LABELS.get(message.engine or '', 'another agent')})"


def render_history(messages: tuple[TurnMessage, ...]) -> str:
    return "\n\n".join(f"{_speaker(message)}:\n{message.content}" for message in messages)


def render_prompt(turn: AgentTurn, *, include_instructions: bool, include_schema: bool) -> str:
    """The user-message text for one run.

    ``include_instructions``: for engines without a system-prompt option (Hermes ACP).
    ``include_schema``: for engines without native structured output.
    """
    if not turn.messages or turn.messages[-1].role != "user":
        raise ValueError("A turn must end with a user message.")
    parts: list[str] = []
    if include_instructions and turn.instructions.strip():
        parts.append(f"Instructions from SKAZ:\n{turn.instructions.strip()}")
    earlier = turn.messages[:-1]
    if earlier:
        parts.append("Earlier messages of this chat (context only):\n"
                     + untrusted_block("chat-history", render_history(earlier)))
    if include_schema and turn.response_schema is not None:
        parts.append("Reply with a single JSON value that matches this JSON Schema, and nothing else:\n"
                     + json.dumps(turn.response_schema, ensure_ascii=False, sort_keys=True))
    request = turn.messages[-1].content
    parts.append(f"Current request:\n{request}" if parts else request)
    return "\n\n".join(parts)
