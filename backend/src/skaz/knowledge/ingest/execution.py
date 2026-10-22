"""A task-local, durable wiki profile and aggregate model-attempt accounting.

Profiles are selected, not proof of a provider's actual model. Missing usage stays
unknown. The data contains counters only, never prompts, material text or replies.
A started attempt remains charged as unknown if the process dies before its end.

C1-d: a material's execution root may carry a budget in characters (``budget.py``). The seam
refuses to send once it is used up and stops a streamed answer that runs past it; an answer
stopped that way is still charged for what it streamed.
"""
from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Awaitable, Callable, Iterator, Mapping
from contextlib import contextmanager, suppress
from contextvars import ContextVar
from dataclasses import asdict, dataclass, field, replace
from time import monotonic
from typing import Any, cast

from ...native_io import disk_call
from ..agents.engine import (
    AgentEngine,
    AgentEvent,
    AgentTurn,
    Completed,
    EngineId,
    Failed,
    RunResult,
    TextDelta,
    collect,
)
from ..agents.registry import EngineUnavailable
from ..store.database import KnowledgeDatabase
from .budget import BudgetReached
from .settings import WikiSettings


@dataclass(frozen=True)
class ProcessingProfile:
    engine: EngineId | None
    model: str | None
    effort: str | None
    language: str

    @classmethod
    def selected(cls, settings: WikiSettings, engine: AgentEngine | None) -> ProcessingProfile:
        return cls(cast(EngineId | None, engine.id if engine else settings.engine),
                   settings.model, settings.effort, settings.language)


@dataclass(frozen=True)
class AttemptUsage:
    calls: int
    cache_hits: int
    completed_calls: int
    failed_calls: int
    unknown_usage_calls: int
    input_tokens: int | None
    output_tokens: int | None
    instruction_characters: int
    message_characters: int
    output_characters: int
    duration_ms: int


@dataclass(frozen=True)
class StageUsage:
    stage: str
    usage: AttemptUsage


@dataclass(frozen=True)
class ExecutionView:
    profile: ProcessingProfile
    root_job_id: str
    usage: AttemptUsage
    stages: tuple[StageUsage, ...]
    #: The adapters do not yet report these. Never relabel a requested selection as observed.
    observed_model: str | None = None
    observed_effort: str | None = None
    #: C1-d: characters in + out the material's processing may use in this portion; ``None`` = no budget.
    budget_characters: int | None = None


def _usage(counters: Mapping[str, int]) -> AttemptUsage:
    calls = counters.get("calls", 0)
    return AttemptUsage(
        calls=calls, cache_hits=counters.get("cache_hits", 0),
        completed_calls=counters.get("completed_calls", 0),
        failed_calls=counters.get("failed_calls", 0),
        unknown_usage_calls=calls - counters.get("known_usage_calls", 0),
        input_tokens=counters.get("input_tokens", 0) if counters.get("known_inputs", 0) == calls else None,
        output_tokens=counters.get("output_tokens", 0) if counters.get("known_outputs", 0) == calls else None,
        instruction_characters=counters.get("instruction_characters", 0),
        message_characters=counters.get("message_characters", 0),
        output_characters=counters.get("output_characters", 0), duration_ms=counters.get("duration_ms", 0),
    )


def new_execution(profile: ProcessingProfile, job_id: str, root_job_id: str | None = None, *,
                  budget: int | None = None, material_id: str | None = None) -> str:
    """The snapshot of a job; children (follow-up jobs) inherit the root, budget and material."""
    return json.dumps({"profile": asdict(profile), "root_job_id": root_job_id or job_id,
                       "budget": budget, "material_id": material_id,
                       "totals": {}, "stages": {}}, ensure_ascii=False)


def execution_view(raw: str | None) -> ExecutionView | None:
    if raw is None:
        return None
    data = json.loads(raw)
    budget = data.get("budget")
    return ExecutionView(ProcessingProfile(**data["profile"]), data["root_job_id"], _usage(data["totals"]),
                         tuple(StageUsage(stage, _usage(counts)) for stage, counts in data["stages"].items()),
                         budget_characters=budget if isinstance(budget, int) else None)


@dataclass(frozen=True)
class ExecutionScope:
    db: KnowledgeDatabase
    job_id: str
    root_job_id: str
    profile: ProcessingProfile
    checked_models: set[tuple[EngineId, str, str | None]] = field(
        default_factory=set, compare=False, repr=False,
    )
    #: C1-d: the budget of this root in characters, and the material it belongs to (``None``: none).
    budget: int | None = None
    material_id: str | None = None

    def spent(self) -> tuple[int, int]:
        """Characters in + out and completed calls of every job under this root (this portion)."""
        characters = completed = 0
        with self.db.read() as connection:
            for row in connection.execute(
                    "SELECT data FROM wiki_execution WHERE json_extract(data, '$.root_job_id') = ?",
                    (self.root_job_id,)):
                totals = json.loads(row["data"]).get("totals", {})
                characters += sum(int(totals.get(key, 0)) for key in (
                    "instruction_characters", "message_characters", "output_characters"))
                completed += int(totals.get("completed_calls", 0))
        return characters, completed

    def _add(self, stage: str, changes: Mapping[str, int]) -> None:
        with self.db.write() as connection:
            row = connection.execute("SELECT data FROM wiki_execution WHERE job_id = ?",
                                     (self.job_id,)).fetchone()
            if row is None:
                raise RuntimeError("The wiki processing snapshot is missing.")
            data = json.loads(row["data"])
            # Schema names are application-owned; bound the number of categories even on a bad caller.
            if stage not in data["stages"] and len(data["stages"]) >= 32:
                stage = "other"
            counts = data["stages"].setdefault(stage, {})
            for target in (data["totals"], counts):
                for key, amount in changes.items():
                    target[key] = target.get(key, 0) + amount
            connection.execute("UPDATE wiki_execution SET data = ? WHERE job_id = ?",
                               (json.dumps(data, ensure_ascii=False), self.job_id))

    def cache_hit(self, stage: str) -> None:
        self._add(stage, {"cache_hits": 1})

    def begin(self, stage: str, turn: AgentTurn) -> None:
        self._add(stage, {"calls": 1, "instruction_characters": len(turn.instructions),
                          "message_characters": sum(len(message.content) for message in turn.messages)})

    def finish(self, stage: str, result: RunResult | None, duration_ms: int, streamed: int = 0) -> None:
        completed = result is not None and isinstance(result.terminal, Completed)
        usage = (result.terminal.usage
                 if result is not None and isinstance(result.terminal, Completed) else None)
        known_input = usage is not None and usage.input_tokens is not None
        known_output = usage is not None and usage.output_tokens is not None
        changes = {"completed_calls": int(completed), "failed_calls": int(not completed),
                   "known_inputs": int(known_input), "known_outputs": int(known_output),
                   "known_usage_calls": int(known_input and known_output), "duration_ms": duration_ms,
                   # A stopped stream has no result; it is charged for what it streamed (C1-d).
                   "output_characters": len(result.text) if result is not None else streamed}
        if usage is not None:
            if usage.input_tokens is not None:
                changes["input_tokens"] = usage.input_tokens
            if usage.output_tokens is not None:
                changes["output_tokens"] = usage.output_tokens
        self._add(stage, changes)


_CURRENT: ContextVar[ExecutionScope | None] = ContextVar("skaz_wiki_execution", default=None)


def current_execution() -> ExecutionScope | None:
    return _CURRENT.get()


@contextmanager
def execution_scope(scope: ExecutionScope | None) -> Iterator[None]:
    token = _CURRENT.set(scope)
    try:
        yield
    finally:
        _CURRENT.reset(token)


def stored_scope(db: KnowledgeDatabase, job_id: str) -> ExecutionScope | None:
    with db.read() as connection:
        row = connection.execute("SELECT data FROM wiki_execution WHERE job_id = ?", (job_id,)).fetchone()
    if row is None:
        return None
    view = execution_view(row["data"])
    assert view is not None
    material_id = json.loads(row["data"]).get("material_id")
    return ExecutionScope(db, job_id, view.root_job_id, view.profile, budget=view.budget_characters,
                          material_id=material_id if isinstance(material_id, str) else None)


#: A break the next call would repeat (limit, sign-in, incompatible agent) or the user's stop: no retry.
STOP_KINDS = frozenset({"cancelled", "limit", "auth", "incompatible"})
#: Retries of a call that failed before it was sent (user decision 2026-10-20); one after possible dispatch.
UNSENT_RETRIES = 3
#: Seconds before each retry (the last value repeats).
RETRY_DELAYS_S: tuple[float, ...] = (5.0, 15.0, 30.0)


def never_sent(failure: Failed) -> bool:
    """The engine says the request never reached the model; where it can't tell, it may have."""
    return failure.unsent or failure.transient


#: Called with each piece of answer text as it arrives (C1-f); raising stops the answer.
OnText = Callable[[str], Awaitable[None]]

#: Seconds to let a stopped run finish its clean-up at the engine.
DRAIN_S = 10.0


async def _streamed(engine: AgentEngine, turn: AgentTurn, on_text: OnText) -> RunResult:
    """Like ``collect``, but hands each text piece to ``on_text``; if it raises, the run is
    interrupted at the engine, drained, and the error goes on."""
    events: AsyncIterator[AgentEvent] = engine.run(turn)
    seen: list[AgentEvent] = []
    try:
        async for event in events:
            seen.append(event)
            if isinstance(event, TextDelta):
                await on_text(event.text)
            if isinstance(event, Completed | Failed):
                break
    except BaseException:
        with suppress(Exception):
            await engine.interrupt(turn.run_id)
            async with asyncio.timeout(DRAIN_S):
                async for _event in events:  # the engine's own clean-up runs to its end
                    pass
        raise
    terminal = seen[-1] if seen else None
    if not isinstance(terminal, Completed | Failed):
        terminal = Failed(turn.run_id, "other", "The agent stopped without finishing the answer.")
        seen.append(terminal)
    text = "".join(event.text for event in seen if isinstance(event, TextDelta))
    return RunResult(text, tuple(seen), terminal)


async def run_wiki_turn(engine: AgentEngine, turn: AgentTurn, on_text: OnText | None = None) -> RunResult:
    """The external-model seam; all continuations/repairs/retries pass through it too."""
    scope = current_execution()
    if scope is not None and engine.id == scope.profile.engine:
        turn = replace(turn, model=turn.model if turn.model is not None else scope.profile.model,
                       effort=turn.effort if turn.effort is not None else scope.profile.effort)
    if scope is not None and engine.id == scope.profile.engine and turn.model is not None:
        key = (engine.id, turn.model, turn.effort)
        if key not in scope.checked_models:
            try:
                models = await engine.models()
            except Exception as error:
                raise EngineUnavailable(engine.id, "The wiki model catalog couldn’t be checked. "
                                        "Check the agent in Settings → Accounts & keys.", "check") from error
            chosen = next((model for model in models if model.id == turn.model), None)
            if chosen is None:
                raise EngineUnavailable(engine.id, "The selected wiki model isn’t available. "
                                        "Choose another in Settings → Models.", "check")
            if turn.effort is not None and turn.effort not in chosen.efforts:
                raise EngineUnavailable(engine.id, "The wiki model doesn’t support this reasoning. "
                                        "Choose a supported level in Settings → Models.", "check")
            scope.checked_models.add(key)
    schema: Mapping[str, Any] = turn.response_schema or {}
    stage = str(schema.get("title", "wiki"))[:128]
    budget = scope.budget if scope is not None else None
    spent = size = completed = 0
    if scope is not None and budget is not None:
        spent, completed = await disk_call(scope.spent)
        size = len(turn.instructions) + sum(len(message.content) for message in turn.messages)
        if spent + size > budget:  # refused before sending: nothing is paid for it
            raise BudgetReached(budget, spent, progressed=completed > 0)
    streamed = 0

    async def counted(text: str) -> None:
        nonlocal streamed
        # Checked before each new piece: an answer that arrives in one piece is never thrown away.
        if budget is not None and spent + size + streamed > budget:
            raise BudgetReached(budget, spent + size + streamed, progressed=completed > 0)
        streamed += len(text)
        assert on_text is not None
        await on_text(text)

    if scope is not None:
        await disk_call(scope.begin, stage, turn)
    started = monotonic()
    result: RunResult | None = None
    try:
        result = await (collect(engine.run(turn)) if on_text is None else _streamed(engine, turn, counted))
        return result
    finally:
        if scope is not None:
            await disk_call(scope.finish, stage, result, round((monotonic() - started) * 1000), streamed)
