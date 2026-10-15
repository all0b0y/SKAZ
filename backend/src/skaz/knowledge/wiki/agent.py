"""Agent calls of the wiki jobs: no tools, a JSON schema, library text only as untrusted data.

Same rules as ingest (layers 1 and 6): ``AgentTurn.tools is None``; one
structure repair per answer; a failed or limited run ends the job with the
agent's plain reason — never a substitute engine or model.
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import Sequence
from typing import Any, TypeVar

from pydantic import BaseModel

from ..agents.engine import AgentEngine, AgentTurn, Failed, TurnMessage, collect
from ..ingest.model import AnswerInvalid, parse_answer
from ..ingest.prompts import repair_message

M = TypeVar("M", bound=BaseModel)


class WikiJobFailed(Exception):
    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class AgentCaller:
    def __init__(self, engine: AgentEngine, prefix: str) -> None:
        self.engine = engine
        self.prefix = prefix
        self._runs = 0

    async def ask(self, instructions: str, messages: Sequence[TurnMessage], schema: dict[str, Any]) -> str:
        self._runs += 1
        run_id = f"{self.prefix}-{self._runs}"
        turn = AgentTurn(
            run_id=run_id,
            messages=tuple(messages),
            instructions=instructions,
            tools=None,
            response_schema=schema,
        )
        try:
            result = await collect(self.engine.run(turn))
        except asyncio.CancelledError:
            with contextlib.suppress(Exception):
                await self.engine.interrupt(run_id)
            raise
        terminal = result.terminal
        if isinstance(terminal, Failed):
            when = (
                f" It should work again after {terminal.retry_at.isoformat()}." if terminal.retry_at else ""
            )
            raise WikiJobFailed(f"The agent stopped: {terminal.message}{when}")
        return result.text

    async def ask_json(
        self, instructions: str, prompt: str, schema: dict[str, Any], model: type[M]
    ) -> M | None:
        """The parsed answer, or ``None`` when it was not in the expected format twice."""
        messages = [TurnMessage("user", prompt)]
        for attempt in range(2):
            text = await self.ask(instructions, messages, schema)
            try:
                return parse_answer(text, model)
            except AnswerInvalid as error:
                if attempt == 1:
                    return None
                messages += [
                    TurnMessage("assistant", text, self.engine.id),
                    TurnMessage("user", repair_message(str(error))),
                ]
        return None
