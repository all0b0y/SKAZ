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

Live sessions (N6, ``.dev/docs/backlog-2026-10-26/N6-CONTRACT.md``): a chat turn may carry a
``SessionPlan``. ``None`` is the stateless behaviour every non-chat run keeps (ingest, judge, W-3b,
summaries). An engine that says ``sessions.live`` keeps one agent session per chat: ``start`` opens it
seeded with ``messages``; ``continue``/``revert`` send only the last message into the existing session
(after dropping ``before_turn_id`` and every later turn for ``revert``). Such an engine emits
``SessionBound`` once the agent accepted the turn, ``Compacted`` when the agent compacted the
conversation, and fails with ``session_lost`` when the session can't be continued.
"""
from __future__ import annotations

from collections.abc import AsyncIterator, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal, Protocol, runtime_checkable

from .web import WebSearchGate

EngineId = Literal["codex", "claude_code", "hermes", "opencode"]
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


SessionMode = Literal["start", "continue", "revert"]


@dataclass(frozen=True)
class SessionPlan:
    """How a chat turn uses the chat's live agent session (N6).

    * ``start``: open a new session, seeded with the turn's ``messages`` (history + current message,
      ``history_summary`` for a long chat), the instructions and the full tool set.
    * ``continue``: send only the last message of ``messages`` into ``session_id``.
    * ``revert``: drop ``before_turn_id`` and every later turn of ``session_id``, then continue.
    """

    mode: SessionMode
    session_id: str | None = None
    before_turn_id: str | None = None

    def __post_init__(self) -> None:
        if self.mode == "start" and (self.session_id or self.before_turn_id):
            raise ValueError("A new session has no id yet.")
        if self.mode != "start" and not self.session_id:
            raise ValueError("Continuing a session needs its id.")
        if (self.mode == "revert") != bool(self.before_turn_id):
            raise ValueError("Only a revert names the turn it reverts to.")


@dataclass(frozen=True)
class SessionSupport:
    """What an engine can do with live sessions; the default is none (stateless runs only)."""

    #: Keeps one agent session per chat (``start``/``continue`` plans, ``SessionBound``).
    live: bool = False
    #: Can drop the last turns of a session in place (``revert`` plans).
    revert: bool = False


NO_SESSIONS = SessionSupport()


def session_support(engine: object) -> SessionSupport:
    """An engine's ``sessions`` capability; engines that don't declare it have none."""
    support = getattr(engine, "sessions", None)
    return support if isinstance(support, SessionSupport) else NO_SESSIONS


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
    #: W-2: chat turns of an agent whose web search SKAZ can hold; each query waits here first.
    #: ``None`` = no web search at all (wiki jobs, other agents).
    web: WebSearchGate | None = None
    #: Chat turns of a long chat: an AI-written retelling of the messages left out of the history
    #: window (``chats.summary``); sent ahead of the window as untrusted context, never evidence.
    history_summary: str | None = None
    #: N6: chat turns of an engine with live sessions; ``None`` = a stateless run (today's behaviour).
    session: SessionPlan | None = None


@dataclass(frozen=True)
class Usage:
    """Tokens of one run, in the one meaning of ``usage.py``; ``None`` = the engine didn't say."""

    input_tokens: int | None = None
    output_tokens: int | None = None
    #: Part of ``input_tokens`` read from the provider's prompt cache.
    cached_input_tokens: int | None = None
    #: Part of ``input_tokens`` written to the provider's prompt cache.
    cache_write_tokens: int | None = None
    #: Part of ``output_tokens`` spent on reasoning.
    reasoning_tokens: int | None = None


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
    #: The request certainly never reached the model (refused or failed before it was sent), so a
    #: retry costs nothing. ``False`` = it may have been sent and paid for: adapters set this only
    #: where they know. Not part of equality (the same failure, with or without this knowledge).
    unsent: bool = field(default=False, compare=False)
    #: The same request would be refused again (too long, no tool access, the first check not done):
    #: retrying it is pointless, so it fails at once. Only set with ``unsent``.
    permanent: bool = field(default=False, compare=False)
    #: N6: the live session of a ``continue``/``revert`` plan can't be used (gone, locked, refused the
    #: revert); nothing was sent to the model. The caller may start a new seeded session instead.
    session_lost: bool = field(default=False, compare=False)


@dataclass(frozen=True)
class SessionBound:
    """N6: the agent accepted this turn into a live session: its session id and this turn's id."""

    run_id: str
    session_id: str
    turn_id: str


@dataclass(frozen=True)
class Compacted:
    """N6: the agent compacted (summarised) the conversation of the live session during this run."""

    run_id: str


AgentEvent = TextDelta | ToolCall | ToolResult | SessionBound | Compacted | Completed | Failed
TerminalEvent = Completed | Failed


@runtime_checkable
class AgentEngine(Protocol):
    @property
    def id(self) -> EngineId: ...

    async def status(self) -> EngineStatus: ...

    async def models(self) -> Sequence[ModelOption]: ...

    def run(self, turn: AgentTurn) -> AsyncIterator[AgentEvent]: ...

    async def interrupt(self, run_id: str) -> None: ...


@runtime_checkable
class LiveSessionEngine(Protocol):
    """N6: an engine with live sessions also deletes them (chat deleted, engine switched, signed out).

    ``delete_session`` raises when the session could not be deleted (the caller retries a bounded
    number of times); where the engine can tell the session is already gone, it returns normally.
    """

    @property
    def sessions(self) -> SessionSupport: ...

    async def delete_session(self, session_id: str) -> None: ...


class SessionDeleteDeferred(RuntimeError):
    """``delete_session`` can't even try now (the agent is not installed, or SKAZ is repairing it): the
    session stays queued and this is not counted as a failed attempt.

    Optional engine hooks the chat service uses when present (``getattr``): ``forget_session(id)`` —
    SKAZ gave the session up after its attempts: drop SKAZ's own local traces of it (kept prompts,
    lists); ``sweep_sessions(known)`` — app start: remove local sessions no chat and no deletion entry
    knows (``known(id) -> bool``)."""


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
