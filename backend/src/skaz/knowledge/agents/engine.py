"""``AgentEngine``: the single agent interface of SKAZ (WIKI-BACKEND-SPEC, B2).

Contract for every adapter:

* ``run(turn)`` streams events and ends with exactly one terminal event,
  ``Completed`` or ``Failed``; nothing follows it.
* Parallel runs are allowed (no queues). ``run_id`` is chosen by the caller
  and unique among the engine's active runs.
* ``interrupt(run_id)`` ends that run with ``Failed(kind="cancelled")``;
  unknown/finished ids are ignored.
* ``turn.tools is None`` means no tools of any kind (ingest mode, poisoning
  layer 1); a tuple is the exact SKAZ tool set, built-in agent tools stay off.
* Never substitute another model or engine silently: an unavailable model is
  ``Failed(kind="incompatible")``, an exhausted plan ``Failed(kind="limit")``.
* Switching engines in a chat passes the conversation as ``messages``; each
  assistant message records which engine wrote it.
"""
from __future__ import annotations

from collections.abc import AsyncIterator, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal, Protocol, runtime_checkable

EngineId = Literal["codex", "claude_code", "hermes"]
FailureKind = Literal["limit", "auth", "incompatible", "network", "cancelled", "other"]
Role = Literal["user", "assistant"]


@dataclass(frozen=True)
class EngineStatus:
    engine: EngineId
    installed: bool
    version: str | None = None
    signed_in: bool = False
    #: Installed but too old/new for SKAZ (minimum-version rule, like ``MIN_CODEX_VERSION``).
    incompatible: bool = False
    #: Plain-words reason when not ready ("Claude Code is not installed.").
    reason: str | None = None
    #: The agent itself says how it is fixed (Hermes: ``hermes pm repair``) and SKAZ can run that.
    repairable: bool = False

    @property
    def missing(self) -> bool:
        return not self.installed

    @property
    def ready(self) -> bool:
        return self.installed and self.signed_in and not self.incompatible


@dataclass(frozen=True)
class ModelOption:
    id: str
    label: str
    #: Reasoning effort levels the model accepts; empty when the engine has none (Hermes).
    efforts: tuple[str, ...] = ()
    default_effort: str | None = None


@dataclass(frozen=True)
class TurnMessage:
    role: Role
    content: str
    #: For assistant messages: the engine that wrote it (kept across an engine switch).
    engine: EngineId | None = None


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    input_schema: Mapping[str, Any]


@dataclass(frozen=True)
class AgentTurn:
    run_id: str
    messages: tuple[TurnMessage, ...]
    instructions: str
    #: ``None`` = no tools at all (ingest); otherwise exactly these SKAZ tools.
    tools: tuple[ToolSpec, ...] | None
    model: str | None = None
    effort: str | None = None
    #: Optional JSON schema the final answer must satisfy (structured ingest output).
    response_schema: Mapping[str, Any] | None = None


@dataclass(frozen=True)
class Usage:
    input_tokens: int | None = None
    output_tokens: int | None = None


@dataclass(frozen=True)
class TextDelta:
    run_id: str
    text: str


@dataclass(frozen=True)
class ToolCall:
    run_id: str
    call_id: str
    name: str
    arguments: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class ToolResult:
    run_id: str
    call_id: str
    output: str
    is_error: bool = False


@dataclass(frozen=True)
class Completed:
    run_id: str
    usage: Usage | None = None


@dataclass(frozen=True)
class Failed:
    run_id: str
    kind: FailureKind
    #: Plain words for the "answer interrupted" card.
    message: str
    #: When the limit resets, if the engine says so.
    retry_at: datetime | None = None
    #: The engine was only busy (all its parallel slots taken): the same turn can run a bit later.
    transient: bool = False


AgentEvent = TextDelta | ToolCall | ToolResult | Completed | Failed
TerminalEvent = Completed | Failed


@runtime_checkable
class AgentEngine(Protocol):
    @property
    def id(self) -> EngineId: ...

    async def status(self) -> EngineStatus: ...

    async def models(self) -> Sequence[ModelOption]: ...

    def run(self, turn: AgentTurn) -> AsyncIterator[AgentEvent]: ...

    async def interrupt(self, run_id: str) -> None: ...


@dataclass(frozen=True)
class RunResult:
    text: str
    events: tuple[AgentEvent, ...]
    terminal: TerminalEvent


async def collect(events: AsyncIterator[AgentEvent]) -> RunResult:
    """Drain one run; the text is the concatenated deltas. A stream without a terminal is a failure."""
    seen: list[AgentEvent] = []
    async for event in events:
        seen.append(event)
        if isinstance(event, Completed | Failed):
            break
    terminal = seen[-1] if seen else None
    if not isinstance(terminal, Completed | Failed):
        run_id = seen[0].run_id if seen else ""
        terminal = Failed(run_id, "other", "The agent stopped without finishing the answer.")
        seen.append(terminal)
    text = "".join(event.text for event in seen if isinstance(event, TextDelta))
    return RunResult(text, tuple(seen), terminal)
