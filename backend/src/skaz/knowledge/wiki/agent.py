"""Agent calls of the wiki jobs: no tools, a JSON schema, library text only as untrusted data.

Same rules as ingest (layers 1 and 6): ``AgentTurn.tools is None``; one
structure repair per answer; a failed or limited run ends the job with the
agent's plain reason — never a substitute engine or model. Retries as in ingest
(user decision 2026-10-20): up to 3 when the request was never sent, exactly one
when it may have been.
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import Sequence
from typing import Any, TypeVar

from pydantic import BaseModel

from ..agents.engine import AgentEngine, AgentTurn, Failed, TurnMessage
from ..ingest.execution import (
    RETRY_DELAYS_S,
    STOP_KINDS,
    UNSENT_RETRIES,
    never_sent,
    retry_unsent,
    run_wiki_turn,
)
from ..ingest.jobs import agent_failure_code, agent_failure_text
from ..ingest.model import AnswerInvalid, parse_answer
from ..ingest.prompts import repair_message

M = TypeVar("M", bound=BaseModel)


class WikiJobFailed(Exception):
    def __init__(self, message: str, code: str | None = None) -> None:
        super().__init__(message)
        self.message = message
        #: ``JobRecord.error_code`` (``AGENT_UNAVAILABLE``: fixed in Settings, not by a retry).
        self.code = code


class AgentCaller:
    def __init__(self, engine: AgentEngine, prefix: str, *, model: str | None = None,
                 effort: str | None = None, retry_delays_s: tuple[float, ...] = RETRY_DELAYS_S) -> None:
        self.engine = engine
        self.prefix = prefix
        self.retry_delays_s = retry_delays_s or (0.0,)
        #: The model and effort chosen for this work (Recognition check), ``None`` = the agent's default.
        self.model = model
        self.effort = effort
        self._runs = 0

    async def ask(self, instructions: str, messages: Sequence[TurnMessage], schema: dict[str, Any]) -> str:
        unsent = 0
        sent_again = False
        while True:
            terminal, text = await self._once(instructions, messages, schema)
            if terminal is None:
                return text
            when = (
                f" It should work again after {terminal.retry_at.isoformat()}." if terminal.retry_at else ""
            )
            reason = agent_failure_text(terminal.kind, terminal.message) + when
            delays = self.retry_delays_s
            if terminal.kind not in STOP_KINDS and retry_unsent(terminal) and unsent < UNSENT_RETRIES:
                await asyncio.sleep(delays[min(unsent, len(delays) - 1)])
                unsent += 1
                continue
            if terminal.kind not in STOP_KINDS and not never_sent(terminal):
                if not sent_again:
                    sent_again = True
                    await asyncio.sleep(delays[0])
                    continue
                reason += " SKAZ tried once more and it stopped again."
            raise WikiJobFailed(reason, agent_failure_code(terminal.kind))

    async def _once(self, instructions: str, messages: Sequence[TurnMessage],
                    schema: dict[str, Any]) -> tuple[Failed | None, str]:
        self._runs += 1
        run_id = f"{self.prefix}-{self._runs}"
        turn = AgentTurn(
            run_id=run_id,
            messages=tuple(messages),
            instructions=instructions,
            tools=None,
            model=self.model,
            effort=self.effort,
            response_schema=schema,
        )
        try:
            result = await run_wiki_turn(self.engine, turn)
        except asyncio.CancelledError:
            with contextlib.suppress(Exception):
                await self.engine.interrupt(run_id)
            raise
        terminal = result.terminal
        if isinstance(terminal, Failed):
            return terminal, ""
        return None, result.text

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
