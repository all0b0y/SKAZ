"""A scripted agent that really calls the SKAZ tools of a run (a fake at the agent seam only).

It stands where Codex/Claude Code/Hermes stand: it calls ``ToolRegistry.call`` with the run's
context as their MCP / dynamic-tool calls do, and asks questions through the question broker
as Hermes' ACP ``elicitation/create`` does. Not a model; it proves SKAZ's side of the protocol.
"""
from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Callable, Sequence
from dataclasses import dataclass, field, replace
from typing import Any

from skaz.knowledge.agents.engine import (
    AgentEvent,
    AgentTurn,
    Completed,
    EngineId,
    EngineStatus,
    Failed,
    ModelOption,
    TextDelta,
    ToolCall,
    ToolResult,
)
from skaz.knowledge.agents.tools import ToolContext
from skaz.knowledge.permissions.store import QuestionOption


@dataclass(frozen=True)
class Invoke:
    name: str
    arguments: dict[str, Any]


@dataclass(frozen=True)
class Ask:
    question: str
    options: tuple[tuple[str, str, bool], ...] = ()


Item = TextDelta | Invoke | Ask
Script = Callable[[AgentTurn], Sequence[Item]]


@dataclass
class ToolEngine:
    runtime: Any
    engine_id: EngineId = "codex"
    script: Script = field(default=lambda _turn: [TextDelta("", "OK.")])
    #: What each tool call / question returned to the agent, in order.
    outcomes: list[str] = field(default_factory=list)
    turns: list[AgentTurn] = field(default_factory=list)
    _cancels: dict[str, asyncio.Event] = field(default_factory=dict)

    @property
    def id(self) -> EngineId:
        return self.engine_id

    async def status(self) -> EngineStatus:
        return EngineStatus(self.engine_id, installed=True, version="0.0-fake", signed_in=True)

    async def models(self) -> Sequence[ModelOption]:
        return (ModelOption("fake-model", "Fake model"),)

    def active_runs(self) -> set[str]:
        return set(self._cancels)

    def run(self, turn: AgentTurn) -> AsyncIterator[AgentEvent]:
        self._cancels[turn.run_id] = asyncio.Event()
        self.turns.append(turn)
        return self._events(turn)

    async def _events(self, turn: AgentTurn) -> AsyncIterator[AgentEvent]:
        run_id = turn.run_id
        cancel = self._cancels[run_id]
        try:
            for number, item in enumerate(self.script(turn)):
                if cancel.is_set():
                    yield Failed(run_id, "cancelled", "The answer was stopped.")
                    return
                if isinstance(item, TextDelta):
                    yield replace(item, run_id=run_id)
                elif isinstance(item, Invoke):
                    yield ToolCall(run_id, f"call-{number}", item.name, item.arguments)
                    outcome = await self.runtime.kb_tools.call(item.name, item.arguments,
                                                               ToolContext(run_id, self.engine_id))
                    self.outcomes.append(outcome.text)
                    yield ToolResult(run_id, f"call-{number}", outcome.text, outcome.is_error)
                else:
                    ref = self.runtime.kb_chats.run_ref(run_id)
                    reply = await self.runtime.kb_questions.ask(
                        ref, item.question, [QuestionOption(*option) for option in item.options])
                    self.outcomes.append(f"{reply.status}:{reply.text}")
            yield (Failed(run_id, "cancelled", "The answer was stopped.") if cancel.is_set()
                   else Completed(run_id))
        finally:
            self._cancels.pop(run_id, None)

    async def interrupt(self, run_id: str) -> None:
        cancel = self._cancels.get(run_id)
        if cancel is not None:
            cancel.set()
