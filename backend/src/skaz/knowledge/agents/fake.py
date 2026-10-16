"""Scripted ``AgentEngine`` for tests. A fake at the external seam — never evidence of quality."""
from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Callable, Sequence
from dataclasses import dataclass, replace

from .engine import (
    AgentEvent,
    AgentTurn,
    Completed,
    EngineId,
    EngineStatus,
    Failed,
    ModelOption,
)


@dataclass(frozen=True)
class Gate:
    """Pause the run until ``event`` is set (or the run is interrupted)."""

    event: asyncio.Event


ScriptItem = AgentEvent | Gate
Script = Sequence[ScriptItem] | Callable[[AgentTurn], Sequence[ScriptItem]]


class FakeEngine:
    def __init__(self, engine_id: EngineId = "codex", *, script: Script = (),
                 status: EngineStatus | None = None, models: Sequence[ModelOption] | None = None) -> None:
        self._id: EngineId = engine_id
        self._script = script
        self._status = status or EngineStatus(engine=engine_id, installed=True, version="0.0-fake",
                                              signed_in=True)
        self._models = tuple(models) if models is not None else (ModelOption("fake-model", "Fake model"),)
        self._cancels: dict[str, asyncio.Event] = {}
        #: Every turn received, in order (assert prompts/tools/handoff history on it).
        self.turns: list[AgentTurn] = []

    @property
    def id(self) -> EngineId:
        return self._id

    async def status(self) -> EngineStatus:
        return self._status

    async def models(self) -> Sequence[ModelOption]:
        return self._models

    def active_runs(self) -> set[str]:
        return set(self._cancels)

    def run(self, turn: AgentTurn) -> AsyncIterator[AgentEvent]:
        if turn.run_id in self._cancels:
            raise ValueError(f"Run {turn.run_id} is already active.")
        cancel = asyncio.Event()
        self._cancels[turn.run_id] = cancel
        self.turns.append(turn)
        items = self._script(turn) if callable(self._script) else self._script
        return self._events(turn.run_id, list(items), cancel)

    async def _events(self, run_id: str, items: list[ScriptItem],
                      cancel: asyncio.Event) -> AsyncIterator[AgentEvent]:
        cancelled = Failed(run_id, "cancelled", "The answer was stopped.")
        try:
            for item in items:
                if cancel.is_set():
                    yield cancelled
                    return
                if isinstance(item, Gate):
                    await _first_of(item.event, cancel)
                    if cancel.is_set():
                        yield cancelled
                        return
                    continue
                event = replace(item, run_id=run_id)
                yield event
                if isinstance(event, Completed | Failed):
                    return
            yield cancelled if cancel.is_set() else Completed(run_id)
        finally:
            self._cancels.pop(run_id, None)

    async def interrupt(self, run_id: str) -> None:
        cancel = self._cancels.get(run_id)
        if cancel is not None:
            cancel.set()


async def _first_of(*events: asyncio.Event) -> None:
    waiters = [asyncio.create_task(event.wait()) for event in events]
    try:
        await asyncio.wait(waiters, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for waiter in waiters:
            waiter.cancel()
