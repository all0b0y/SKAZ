"""``skaz_ask_user``: SKAZ's own question tool for agents whose native one can't work (Q-A1).

Checked against the installed versions (0.3.1 P):

* Codex 0.160.0: ``request_user_input`` exists, but the binary says "request_user_input is
  unavailable in <mode>" / "This tool is only available in <mode>" — Plan mode only; SKAZ runs
  Default mode, so the model never gets it. → ``skaz_ask_user``.
* Claude Code 2.1.281: ``AskUserQuestion`` in ``-p`` is answered only through the SDK's
  ``canUseTool`` control request ("canUseTool returned a schema-invalid permission result",
  "Interrupting parked AskUserQuestion" in the binary); SKAZ runs ``--tools ""`` and
  ``--permission-prompts none`` (no permission channel, A-1). → ``skaz_ask_user``.
* Hermes 0.22.1: ``clarify`` → ACP ``elicitation/create`` for a client that declares
  ``elicitation.form`` (``acp_adapter/elicitation.py``, ``gateway_server.py:866-893``). Turning it
  on means enabling the ``clarify`` toolset in SKAZ's pinned policy and letting it through the
  "only SKAZ tools" check of the ``/tools`` listing — which refuses the whole run when it doesn't
  match, and that listing can't be recorded without starting Hermes. Not switched on unverified.
  → ``skaz_ask_user`` for now.
"""
from __future__ import annotations

from collections.abc import Callable
from typing import Any

from pydantic import Field

from ..agents.engine import EngineId
from ..agents.tools import SkazTool, ToolContext, ToolInputError, _Args
from .questions import MAX_OPTIONS, QuestionBroker
from .store import QuestionOption, RunRef

ASK_TOOL = "skaz_ask_user"
#: Engines whose native question tool works with SKAZ (the card says "Questions: through SKAZ" otherwise).
NATIVE_QUESTIONS: frozenset[EngineId] = frozenset()
NOT_IN_CHAT = "Questions to the user are only possible in a chat."


class _Option(_Args):
    label: str = Field(min_length=1, max_length=120, description="Short answer the user can pick.")
    description: str = Field(default="", max_length=300, description="One line: what this choice means.")


class AskArgs(_Args):
    question: str = Field(min_length=1, max_length=2_000)
    options: list[_Option] = Field(default_factory=list, max_length=MAX_OPTIONS,
                                   description="Up to 4 choices; the user may also answer in own words.")
    recommended_index: int | None = Field(default=None, ge=0, lt=MAX_OPTIONS,
                                          description="Index of the option you recommend (shown first).")


def ask_tool(questions: QuestionBroker, runs: Callable[[str], RunRef | None]) -> SkazTool:
    async def run(context: ToolContext | None, args: Any) -> dict[str, Any]:
        ref = runs(context.run_id) if context is not None else None
        if ref is None:
            raise ToolInputError(NOT_IN_CHAT)
        if args.recommended_index is not None and args.recommended_index >= len(args.options):
            raise ToolInputError("recommended_index points past the options.")
        options = [QuestionOption(option.label, option.description, index == args.recommended_index)
                   for index, option in enumerate(args.options)]
        reply = await questions.ask(ref, args.question, options)
        if reply.status == "cancelled":
            return {"status": "cancelled", "reason": "The user stopped the answer."}
        return {"status": "answered", "answer": reply.text}

    return SkazTool(
        ASK_TOOL,
        "Ask the user a question with up to 4 choices (or their own answer) and wait for it. Ask only "
        "when you can't go on without the user's choice; the chat shows the question, and the user may "
        "instead just write a message — then the answer says so.",
        AskArgs, run=run, timeout_s=None)
