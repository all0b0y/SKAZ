"""Work of an agent waits while the agent is updated (U1 decisions 5 and 5a).

An update of an agent that is busy is queued: answers and wiki builds already running finish,
new work for that agent waits (its chats and wiki pause), then the update runs; other agents keep
working. Work is counted where every agent run starts — ``engine.run`` — so chats, wiki builds,
recognition checks, study judging and web searches all count without each knowing about updates.
A wiki build holds its agent for the whole build (:func:`holding`), not just per run, so an
update never lands between two of its steps.

Nothing is closed or recreated after an update (5a): a chat's next answer simply continues its
live session on the new version; a session the new version can't read is the existing
``session_lost`` → one reseed.
"""
from __future__ import annotations

import asyncio
import contextlib
import weakref
from collections.abc import AsyncIterator, Awaitable, Callable
from contextvars import ContextVar
from typing import Any, cast

from .engine import AgentEvent, AgentTurn, Completed, EngineId, Failed

#: Work this task already holds (gate id, engine): its own runs never wait for that gate again.
_HELD: ContextVar[frozenset[tuple[int, str]]] = ContextVar("skaz_update_gate_held", default=frozenset())
#: Engine object → its gate, for :func:`holding` (weak: a test's engines don't stay alive).
_GATES: weakref.WeakKeyDictionary[Any, tuple[UpdateGate, EngineId]] = weakref.WeakKeyDictionary()
STOPPED = "Stopped."


class UpdateGate:
    """Per agent: how much work runs, and whether an update holds it (new work then waits)."""

    def __init__(self) -> None:
        self._active: dict[str, int] = {}
        self._blocked: set[str] = set()
        self._changed = asyncio.Event()

    def busy(self, engine: str) -> bool:
        return self._active.get(engine, 0) > 0

    def blocked(self, engine: str) -> bool:
        return engine in self._blocked

    def _signal(self) -> None:
        self._changed.set()
        self._changed = asyncio.Event()

    def _held(self, engine: str) -> bool:
        return (id(self), engine) in _HELD.get()

    async def _wait(self, stop: asyncio.Event | None) -> bool:
        """Wait for a change; ``False`` when ``stop`` was set meanwhile."""
        changed = asyncio.ensure_future(self._changed.wait())
        waits: set[asyncio.Future[Any]] = {changed}
        stopped = asyncio.ensure_future(stop.wait()) if stop is not None else None
        if stopped is not None:
            waits.add(stopped)
        try:
            await asyncio.wait(waits, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for waiting in waits:
                waiting.cancel()
        return not (stop is not None and stop.is_set())

    async def enter(self, engine: str, stop: asyncio.Event | None = None) -> bool:
        """Count one piece of work, after any update of the agent; ``False`` if stopped while waiting."""
        if not self._held(engine):
            while engine in self._blocked:
                if not await self._wait(stop):
                    return False
        self._active[engine] = self._active.get(engine, 0) + 1
        return True

    def leave(self, engine: str) -> None:
        self._active[engine] = max(self._active.get(engine, 0) - 1, 0)
        self._signal()

    @contextlib.asynccontextmanager
    async def work(self, engine: str) -> AsyncIterator[None]:
        """Hold the agent for a whole job (its runs inside don't wait again)."""
        if self._held(engine):
            yield
            return
        await self.enter(engine)
        token = _HELD.set(_HELD.get() | {(id(self), engine)})
        try:
            yield
        finally:
            _HELD.reset(token)
            self.leave(engine)

    @contextlib.asynccontextmanager
    async def exclusive(self, engine: str) -> AsyncIterator[None]:
        """New work waits from now on; enter once running work has finished; release on exit."""
        self._blocked.add(engine)
        self._signal()
        try:
            while self.busy(engine):
                await self._wait(None)
            yield
        finally:
            self._blocked.discard(engine)
            self._signal()


def guard(engine: Any, gate: UpdateGate) -> None:
    """Route every run of ``engine`` through ``gate`` (the instance's ``run`` / ``interrupt``).

    A run waiting for an update ends with "Stopped." when it is interrupted meanwhile; nothing has
    reached the model then.
    """
    engine_id: EngineId = engine.id
    run: Callable[[AgentTurn], AsyncIterator[AgentEvent]] = engine.run
    interrupt: Callable[[str], Any] = engine.interrupt
    waiting: dict[str, asyncio.Event] = {}

    async def close(events: AsyncIterator[AgentEvent]) -> None:
        closer = getattr(events, "aclose", None)
        if callable(closer):
            with contextlib.suppress(Exception):
                await cast(Callable[[], Awaitable[object]], closer)()

    async def counted(turn: AgentTurn, events: AsyncIterator[AgentEvent]) -> AsyncIterator[AgentEvent]:
        stop = asyncio.Event()
        waiting[turn.run_id] = stop
        try:
            entered = await gate.enter(engine_id, stop)  # at once unless an update holds the agent
        finally:
            waiting.pop(turn.run_id, None)
        if not entered:
            await close(events)
            yield Failed(turn.run_id, "cancelled", STOPPED, unsent=True)
            return
        left = False

        def release() -> None:
            nonlocal left
            if not left:
                left = True
                gate.leave(engine_id)

        try:
            async for event in events:
                if isinstance(event, Completed | Failed):
                    release()  # the run is over even if its reader never closes the stream
                yield event
        finally:
            release()
            await close(events)

    def gated(turn: AgentTurn) -> AsyncIterator[AgentEvent]:
        # The engine's own ``run`` is called right away as before (its bookkeeping stays the same);
        # the work counts, or waits for an update, once the stream is read.
        return counted(turn, run(turn))

    async def interrupted(run_id: str) -> None:
        stop = waiting.get(run_id)
        if stop is not None:
            stop.set()
            return
        await interrupt(run_id)

    setattr(engine, "run", gated)  # noqa: B010 - an instance attribute on purpose: every caller is covered
    setattr(engine, "interrupt", interrupted)  # noqa: B010
    with contextlib.suppress(TypeError):  # not weakly referenceable: no holding(), runs still gated
        _GATES[engine] = (gate, engine_id)


@contextlib.asynccontextmanager
async def holding(engine: Any) -> AsyncIterator[None]:
    """Hold ``engine`` for a whole job (a wiki build) when it is guarded; otherwise nothing."""
    try:
        found = _GATES.get(engine) if engine is not None else None
    except TypeError:
        found = None
    if found is None:
        yield
        return
    gate, engine_id = found
    async with gate.work(engine_id):
        yield
