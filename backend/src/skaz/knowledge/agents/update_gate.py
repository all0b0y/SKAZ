"""Work of an agent waits while the agent is updated (U1 decisions 5 and 5a).

An update of an agent that is busy is queued: answers and wiki builds already running finish,
new work for that agent waits (its chats and wiki pause), then the update runs; other agents keep
working. Work is counted where every agent run starts — ``engine.run`` — so chats, wiki builds,
recognition checks, study judging and web searches all count without each knowing about updates.
A wiki build holds its agent for the whole build (:func:`holding`), not just per run, so an
update never lands between two of its steps.

Work started from inside running work of the same agent (a tool of a Codex answer that searches
with Codex, a task the answer spawns) is part of it: it never waits for an update that itself
waits for the outer work (FIX-1 F3.2). The engine's own ``run`` is called only once the gate lets
a run in, so a run stopped while it waits leaves nothing behind in the engine (F3.6).

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

STOPPED = "Stopped."


class _Hold:
    """One piece of work holding an agent; ``active`` ends with the work, wherever its context went."""

    __slots__ = ("active", "engine", "gate")

    def __init__(self, gate: UpdateGate, engine: str) -> None:
        self.gate = gate
        self.engine = engine
        self.active = True


#: Work this context holds (its runs never wait for that gate again). Copied into tasks spawned from
#: it (asyncio copies the context), so a tool task of an answer counts as the answer's own work.
_HELD: ContextVar[tuple[_Hold, ...]] = ContextVar("skaz_update_gate_held", default=())
#: Engine object → its gate, for :func:`holding` (weak: a test's engines don't stay alive).
_GATES: weakref.WeakKeyDictionary[Any, tuple[UpdateGate, EngineId]] = weakref.WeakKeyDictionary()


def _take(hold: _Hold) -> None:
    """Mark the current context as holding (only live holds are kept)."""
    _HELD.set((*(held for held in _HELD.get() if held.active), hold))


def _drop(hold: _Hold) -> None:
    hold.active = False
    with contextlib.suppress(Exception):  # only this hold: other holds of the context stay
        _HELD.set(tuple(held for held in _HELD.get() if held.active and held is not hold))


class UpdateGate:
    """Per agent: how much work runs, and whether an update holds it (new work then waits)."""

    def __init__(self) -> None:
        self._active: dict[str, int] = {}
        self._blocked: set[str] = set()
        #: Runs waiting for an update, by agent (the chat says "Waiting for the … update").
        self._waiting: dict[str, dict[str, None]] = {}
        self._changed = asyncio.Event()

    def busy(self, engine: str) -> bool:
        return self._active.get(engine, 0) > 0

    def blocked(self, engine: str) -> bool:
        """An update holds the agent (queued behind its work, or running): new work of it waits."""
        return engine in self._blocked

    def waiting(self, engine: str) -> tuple[str, ...]:
        """Run ids waiting at the gate for an update of ``engine``, oldest first."""
        return tuple(self._waiting.get(engine, ()))

    def _signal(self) -> None:
        self._changed.set()
        self._changed = asyncio.Event()

    def _held(self, engine: str) -> bool:
        return any(held.active and held.gate is self and held.engine == engine for held in _HELD.get())

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

    async def enter(self, engine: str, stop: asyncio.Event | None = None, run_id: str | None = None) -> bool:
        """Count one piece of work, after any update of the agent; ``False`` if stopped (before or while
        waiting). ``run_id`` is reported by :meth:`waiting` while it waits."""
        if stop is not None and stop.is_set():
            return False
        if not self._held(engine) and engine in self._blocked:
            listed = self._waiting.setdefault(engine, {})
            if run_id is not None:
                listed[run_id] = None
            try:
                while engine in self._blocked:
                    if not await self._wait(stop):
                        return False
            finally:
                if run_id is not None:
                    listed.pop(run_id, None)
                if not listed:
                    self._waiting.pop(engine, None)
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
        hold = _Hold(self, engine)
        _take(hold)
        try:
            yield
        finally:
            _drop(hold)
            self.leave(engine)

    @contextlib.asynccontextmanager
    async def exclusive(self, engine: str) -> AsyncIterator[None]:
        """New work waits from now on; enter once running work has finished; release on exit."""
        # The update's own task may have been started from inside held work (Update pressed while
        # an answer's context was current): what it starts is not that work.
        _HELD.set(())
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

    A run waiting for an update ends with "Stopped." when it is interrupted meanwhile (or before its
    stream was first read); the engine's own ``run`` is called only once the gate lets the run in,
    so nothing reached the model or the engine's bookkeeping then.
    """
    engine_id: EngineId = engine.id
    run: Callable[[AgentTurn], AsyncIterator[AgentEvent]] = engine.run
    interrupt: Callable[[str], Any] = engine.interrupt
    #: Runs not let in yet (read or not): an interrupt stops them here, the engine never sees them.
    waiting: dict[str, asyncio.Event] = {}

    async def close(events: AsyncIterator[AgentEvent]) -> None:
        closer = getattr(events, "aclose", None)
        if callable(closer):
            with contextlib.suppress(Exception):
                await cast(Callable[[], Awaitable[object]], closer)()

    async def counted(turn: AgentTurn, stop: asyncio.Event) -> AsyncIterator[AgentEvent]:
        try:
            entered = await gate.enter(engine_id, stop, turn.run_id)  # at once unless an update holds it
        finally:
            if waiting.get(turn.run_id) is stop:
                del waiting[turn.run_id]
        if not entered:
            yield Failed(turn.run_id, "cancelled", STOPPED, unsent=True)
            return
        hold = _Hold(gate, engine_id)
        _take(hold)  # what this run starts meanwhile (its tools' runs) is part of it
        left = False

        def release() -> None:
            nonlocal left
            if not left:
                left = True
                _drop(hold)
                gate.leave(engine_id)

        events: AsyncIterator[AgentEvent] | None = None
        try:
            events = run(turn)  # only now: a run that never got in left nothing in the engine
            async for event in events:
                if isinstance(event, Completed | Failed):
                    release()  # the run is over even if its reader never closes the stream
                yield event
        finally:
            release()
            if events is not None:
                await close(events)

    def gated(turn: AgentTurn) -> AsyncIterator[AgentEvent]:
        stop = asyncio.Event()
        waiting[turn.run_id] = stop
        return counted(turn, stop)

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


def _gate_of(engine: Any) -> tuple[UpdateGate, EngineId] | None:
    try:
        return _GATES.get(engine) if engine is not None else None
    except TypeError:
        return None


def blocked(engine: Any) -> bool:
    """Whether an update holds ``engine`` (an engine object) now: queued behind its work or running.

    For housekeeping that starts the agent's own process outside a run (deleting live sessions): skip
    the agent meanwhile and try later — that is not a failed attempt.
    """
    found = _gate_of(engine)
    return found is not None and found[0].blocked(found[1])


@contextlib.asynccontextmanager
async def holding(engine: Any) -> AsyncIterator[None]:
    """Hold ``engine`` for a whole job (a wiki build, a web search) when it is guarded; otherwise nothing."""
    found = _gate_of(engine)
    if found is None:
        yield
        return
    gate, engine_id = found
    async with gate.work(engine_id):
        yield
