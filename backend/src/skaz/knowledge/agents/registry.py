"""The three agent engines, their statuses and the default engine for new chats.

No silent substitution: ``require`` returns the chosen engine only when it is
ready and otherwise raises ``EngineUnavailable`` with a plain reason and the
action that fixes it (install / update / login / check).
"""
from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncIterator, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal, Protocol, cast

from ...gateways.codex_connection import CodexConnection, parse_codex_version
from ..errors import KnowledgeError
from .engine import (
    AgentEngine,
    AgentEvent,
    AgentTurn,
    EngineId,
    EngineStatus,
    Failed,
    ModelOption,
)

ENGINE_IDS: tuple[EngineId, ...] = ("codex", "claude_code", "hermes", "opencode")
ENGINE_NAMES: dict[EngineId, str] = {"codex": "Codex", "claude_code": "Claude Code", "hermes": "Hermes Agent",
                                     "opencode": "OpenCode"}
DEFAULT_ENGINE_KEY = "agents.default_engine"
#: A new library starts with Codex, the engine SKAZ already used (A-n in the report).
DEFAULT_ENGINE: EngineId = "codex"
#: ``preparing``: Hermes' first check is running (wire name kept from the time it downloaded an
#: environment; the composer's agent picker reads it).
AgentState = Literal["ready", "not_installed", "outdated", "signed_out", "unavailable", "preparing"]
#: ``first_check``: Hermes' one-time check with SKAZ's own folder (B10); ``check``: look at the state again.
AgentAction = Literal["install", "update", "login", "check", "first_check", "repair"]
LoginMethod = Literal["terminal", "browser"]
#: A sign-in started in this SKAZ: ``waiting`` (browser page or Terminal window still open), ``done``
#: (finished: check the agent now) or ``failed``; ``idle`` when none was started.
SignInState = Literal["idle", "waiting", "done", "failed"]
#: Agents SKAZ doesn't sign out: why, in the user's words.
NO_SIGN_OUT: dict[EngineId, str] = {
    "claude_code": ("Claude Code in SKAZ uses the Claude Code sign-in of this Mac, so SKAZ doesn't sign "
                    "it out: that would sign Claude Code out in your other apps too. Sign out in Claude "
                    "Code itself."),
    "hermes": ("Hermes signs in per provider. Open a provider under Hermes Agent and choose Remove… to sign "
               "Hermes out of it."),
}


class EngineUnavailable(KnowledgeError):
    status_code = 409

    def __init__(self, engine: EngineId, message: str, action: AgentAction) -> None:
        super().__init__(message)
        self.engine = engine
        self.action = action


class SettingsStore(Protocol):
    def get(self, key: str, default: Any = None) -> Any: ...

    def set(self, key: str, value: Any) -> None: ...


@dataclass(frozen=True)
class FirstRun:
    """An agent SKAZ starts only after the user's one-time check (Hermes, decision B10)."""

    #: The user's ``first_check`` task passed; SKAZ may start the agent.
    checked: bool
    #: Set up and waiting only for the check: the action is ``first_check``.
    needed: bool
    #: What the check does, shown before it runs.
    note: str


@dataclass(frozen=True)
class AgentView:
    engine: EngineId
    name: str
    status: EngineStatus
    state: AgentState
    action: AgentAction | None
    models: tuple[ModelOption, ...]
    #: The model chosen in the agent itself (Hermes: in SKAZ's Hermes folder); None if not applicable.
    current_model: str | None
    checked_at: str
    first_run: FirstRun | None = None


@dataclass(frozen=True)
class LoginOutcome:
    engine: EngineId
    method: LoginMethod
    url: str | None
    message: str


@dataclass(frozen=True)
class SignInView:
    engine: EngineId
    method: LoginMethod | None
    state: SignInState


def codex_login_progress(view: Mapping[str, Any]) -> Literal["waiting", "done", "failed"] | None:
    """Codex's browser sign-in from its connection view (``login``: pending → idle once
    ``account/login/completed`` arrived; failed / cancelled / timed_out otherwise)."""
    state = view.get("login")
    if state == "pending":
        return "waiting"
    if state == "idle":
        return "done"
    return "failed" if isinstance(state, str) else None


def classify(status: EngineStatus, *, check_failed: bool = False) -> tuple[AgentState, AgentAction | None]:
    """State and fixing action. Installed without a known version and without sign-in = re-check."""
    if check_failed:
        return "unavailable", "check"
    if not status.installed:
        return "not_installed", "install"
    if status.repairable:
        return "unavailable", "repair"
    if status.incompatible:
        return "outdated", "update"
    if not status.signed_in:
        return ("signed_out", "login") if status.version else ("unavailable", "check")
    return "ready", None


class CodexStatusEngine:
    """Codex status/models/sign-in from the existing connection; runs belong to area A1's adapter.

    Placeholder until ``knowledge/agents/codex.py`` (A1) lands: ``run`` fails
    plainly instead of pretending, so nothing is silently routed elsewhere.
    """

    def __init__(self, connection: CodexConnection) -> None:
        self.connection = connection

    @property
    def id(self) -> EngineId:
        return "codex"

    async def status(self) -> EngineStatus:
        view = await self.connection.check()
        state = view.get("status")
        parsed = parse_codex_version(str(view.get("version") or ""))
        version = ".".join(map(str, parsed)) if parsed else None
        error = view.get("error")
        if state == "missing":
            return EngineStatus("codex", installed=False, reason="Codex is not installed.")
        if state == "incompatible":
            return EngineStatus("codex", installed=True, version=version, incompatible=True,
                                reason=str(error or "This Codex version can't be used. Update it."))
        if state == "signed_out":
            return EngineStatus("codex", installed=True, version=version,
                                reason="Sign in with ChatGPT to use Codex.")
        if state == "connected":
            return EngineStatus("codex", installed=True, version=version, signed_in=True)
        # Unknown connection state: no version shown, so the action is "check", not "sign in".
        return EngineStatus("codex", installed=True, reason="SKAZ couldn't connect to Codex. Check it again.")

    async def models(self) -> Sequence[ModelOption]:
        return tuple(ModelOption(str(m["id"]), str(m["label"]), tuple(m.get("efforts") or ()))
                     for m in self.connection.view.get("models") or [])

    def run(self, turn: AgentTurn) -> AsyncIterator[AgentEvent]:
        return self._not_connected(turn.run_id)

    async def _not_connected(self, run_id: str) -> AsyncIterator[AgentEvent]:
        yield Failed(run_id, "other", "Codex is not connected to the knowledge wiki yet.")

    async def interrupt(self, run_id: str) -> None:
        return None

    async def login_url(self, consent: bool) -> str:
        return await self.connection.login(consent)

    async def logout(self) -> None:
        """Codex's own ``account/logout`` in SKAZ's Codex profile (``CodexConnection.logout``)."""
        await self.connection.logout()

    def login_progress(self) -> Literal["waiting", "done", "failed"] | None:
        return codex_login_progress(self.connection.view)


def _first_run(target: object) -> FirstRun | None:
    reader = getattr(target, "first_run", None)
    if not callable(reader):
        return None
    info = reader()
    return info if isinstance(info, FirstRun) else None


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


class AbsentEngine:
    """An agent the caller didn't wire (engine doubles that predate OpenCode): honestly not installed,
    never started, and its runs fail plainly — nothing is routed to another engine."""

    def __init__(self, engine: EngineId) -> None:
        self._id: EngineId = engine

    @property
    def id(self) -> EngineId:
        return self._id

    async def status(self) -> EngineStatus:
        return EngineStatus(self._id, installed=False, reason=f"{ENGINE_NAMES[self._id]} is not installed.")

    async def models(self) -> Sequence[ModelOption]:
        return ()

    def run(self, turn: AgentTurn) -> AsyncIterator[AgentEvent]:
        return self._absent(turn.run_id)

    async def _absent(self, run_id: str) -> AsyncIterator[AgentEvent]:
        yield Failed(run_id, "incompatible", f"{ENGINE_NAMES[self._id]} is not installed.")

    async def interrupt(self, run_id: str) -> None:
        return None


#: Engines a caller may leave out (they are then :class:`AbsentEngine`); every other one is required.
OPTIONAL_ENGINES: tuple[EngineId, ...] = ("opencode",)


class EngineRegistry:
    def __init__(self, engines: Mapping[EngineId, AgentEngine], settings: SettingsStore, *,
                 check_timeout_s: float = 240.0, cache_s: float = 30.0) -> None:
        missing = [engine for engine in ENGINE_IDS
                   if engine not in engines and engine not in OPTIONAL_ENGINES]
        if missing:
            raise ValueError(f"Engines missing: {missing}")
        self.engines = {**{engine: AbsentEngine(engine) for engine in OPTIONAL_ENGINES}, **dict(engines)}
        self.settings = settings
        self._timeout = check_timeout_s
        self._cache_s = cache_s
        self._cache: dict[EngineId, tuple[float, AgentView]] = {}
        self._locks: dict[EngineId, asyncio.Lock] = {engine: asyncio.Lock() for engine in ENGINE_IDS}
        #: Sign-ins started in this SKAZ and how (watched until they end).
        self._sign_ins: dict[EngineId, LoginMethod] = {}

    def engine(self, engine: EngineId) -> AgentEngine:
        return self.engines[engine]

    def default(self) -> EngineId:
        value = self.settings.get(DEFAULT_ENGINE_KEY)
        return cast(EngineId, value) if value in ENGINE_IDS else DEFAULT_ENGINE

    def set_default(self, engine: EngineId) -> EngineId:
        if engine not in ENGINE_IDS:
            raise KnowledgeError("Unknown agent.")
        self.settings.set(DEFAULT_ENGINE_KEY, engine)
        return engine

    def forget(self, engine: EngineId) -> None:
        self._cache.pop(engine, None)

    def last_view(self, engine: EngineId) -> AgentView | None:
        """The latest checked view, however old (no check started): for cheap hints such as the
        agent card's web-search line (W-3b); ``None`` before the first check."""
        cached = self._cache.get(engine)
        return cached[1] if cached is not None else None

    async def view(self, engine: EngineId, *, refresh: bool = False) -> AgentView:
        async with self._locks[engine]:
            cached = self._cache.get(engine)
            if cached is not None and not refresh and time.monotonic() - cached[0] < self._cache_s:
                return cached[1]
            reset = getattr(self.engines[engine], "reset_cache", None)
            if refresh and callable(reset):
                reset()
            view = await self._check(engine)
            self._cache[engine] = (time.monotonic(), view)
            return view

    async def views(self, *, refresh: bool = False) -> list[AgentView]:
        return list(await asyncio.gather(*(self.view(engine, refresh=refresh) for engine in ENGINE_IDS)))

    async def _check(self, engine: EngineId) -> AgentView:
        target = self.engines[engine]
        name = ENGINE_NAMES[engine]
        failed = False
        try:
            async with asyncio.timeout(self._timeout):
                status = await target.status()
        except Exception:  # an engine check must never take the whole agents screen down
            failed = True
            status = EngineStatus(engine, installed=False, reason=f"SKAZ couldn't check {name}. Try again.")
        state, action = classify(status, check_failed=failed)
        first_run = _first_run(target)
        if first_run is not None and first_run.needed and state in ("signed_out", "unavailable"):
            state, action = "unavailable", "first_check"
        models: tuple[ModelOption, ...] = ()
        if state == "ready":
            try:
                async with asyncio.timeout(self._timeout):
                    models = tuple(await target.models())
            except Exception:
                models = ()
        current = getattr(target, "current_model", None)
        return AgentView(engine, name, status, state, action, models,
                         current if isinstance(current, str) else None, _now(), first_run)

    async def require(self, engine: EngineId) -> AgentEngine:
        """The engine for a run, or a plain error with the fixing action. Never another engine."""
        view = await self.view(engine)
        if view.state != "ready":
            view = await self.view(engine, refresh=True)
        if view.state != "ready":
            message = view.status.reason or f"{view.name} is not ready."
            raise EngineUnavailable(engine, message, view.action or "check")
        return self.engines[engine]

    async def logout(self, engine: EngineId) -> AgentView:
        """Sign out of an engine whose sign-in SKAZ owns (Codex: SKAZ's ``CODEX_HOME``), then re-check.

        Codex: ``account/logout`` in SKAZ's ``CODEX_HOME``; OpenCode: ``opencode auth logout`` for each
        provider of SKAZ's OpenCode folder. Claude Code uses this Mac's own sign-in and Hermes signs in
        per provider (:data:`NO_SIGN_OUT`): SKAZ never signs them out here.
        """
        target: Any = self.engines[engine]
        name = ENGINE_NAMES[engine]
        logout = getattr(target, "logout", None)
        if engine in NO_SIGN_OUT or not callable(logout):
            raise EngineUnavailable(
                engine, NO_SIGN_OUT.get(engine, f"{name} keeps its sign-in in its own app. Sign out there."),
                "check")
        self.forget(engine)
        try:
            await logout()
        except ValueError as error:  # SKAZ's own plain reasons ("Check the Codex connection first")
            detail = str(error).strip() or f"{name} didn't answer"
            raise EngineUnavailable(engine, f"SKAZ couldn't sign out of {name}: {detail}", "check") from error
        except Exception as error:  # the engine's own output is not shown: it is not SKAZ's text
            message = f"SKAZ couldn't sign out of {name}: it didn't answer. Check it and try again."
            raise EngineUnavailable(engine, message, "check") from error
        self._sign_ins.pop(engine, None)
        return await self.view(engine, refresh=True)

    def sign_in(self, engine: EngineId) -> SignInView:
        """How the sign-in started in this SKAZ goes (no agent command is run: a file or a flag)."""
        method = self._sign_ins.get(engine)
        reader = getattr(self.engines[engine], "login_progress", None)
        if method is None or not callable(reader):
            return SignInView(engine, method, "idle")
        progress = reader()
        state: SignInState = progress if progress is not None else "waiting"
        if state != "waiting":
            self.forget(engine)  # the next check reads the agent again
        return SignInView(engine, method, state)

    async def wait_sign_in(self, engine: EngineId, wait_s: float, *, step_s: float = 0.5) -> SignInView:
        """:meth:`sign_in`, waiting up to ``wait_s`` while it is still ``waiting``."""
        view = self.sign_in(engine)
        deadline = time.monotonic() + wait_s
        while view.state == "waiting" and time.monotonic() < deadline:
            await asyncio.sleep(min(step_s, max(deadline - time.monotonic(), 0)))
            view = self.sign_in(engine)
        return view

    async def login(self, engine: EngineId, *, consent: bool = False) -> LoginOutcome:
        target: Any = self.engines[engine]
        name = ENGINE_NAMES[engine]
        self.forget(engine)
        try:
            if hasattr(target, "login_url"):
                url = await target.login_url(consent)
                self._sign_ins[engine] = "browser"
                return LoginOutcome(engine, "browser", str(url),
                                    "Finish signing in in your browser. SKAZ checks as soon as it’s done.")
            await target.login()
            self._sign_ins[engine] = "terminal"
        except FileNotFoundError as error:
            raise EngineUnavailable(engine, f"{name} is not installed.", "install") from error
        except ValueError as error:
            raise EngineUnavailable(engine, str(error) or f"{name} can't sign in now.", "check") from error
        except OSError as error:
            raise EngineUnavailable(engine, f"SKAZ couldn't open Terminal for {name}.", "check") from error
        what = ("choose a model and provider" if engine == "hermes"
                else "sign in to a model provider" if engine == "opencode" else "sign in")
        return LoginOutcome(engine, "terminal", None,
                            f"Finish in Terminal: {what} there. SKAZ checks as soon as Terminal finishes.")
