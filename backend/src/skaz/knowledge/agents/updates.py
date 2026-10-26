"""Agent updates (U1): SKAZ checks by itself and offers a newer version; the user updates.

* **Check** (decisions 3, 9): installed agents only, ~1 min after start and then every 24 h while
  SKAZ is open, with the time of the last check kept (a restart doesn't ask again), plus
  **Check for updates**. One switch "Check for agent updates automatically" (on by default; off
  = no background requests). A failed check is silent: nothing about the agent changes, the
  result it had stays.
* **Offer** (decision 4): "Update available · X → Y", **Update**, **Skip this version** (that
  version isn't offered again, the next one is), and an unseen flag for the dot on Settings and
  its Agents section. No popups, no Health problem, nothing in chats.
* **Update** (decisions 2, 5, 5a, 6, 7, 8): the agent's own command (``recipes.py`` action
  ``upgrade``) for this whole Mac; a busy agent's update waits for its running work
  (:mod:`.update_gate`), new work for it waits meanwhile; after the run SKAZ's usual check
  (``InstallManager._check_result``). A failure keeps its reason, the command's output and the
  exact Terminal command; **Roll back to X** only where the agent's own command can
  (``channels.ROLLBACK_CHANNELS``), otherwise "roll back manually" with the vendor's page.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import re
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Literal, cast

from ...native_io import disk_call
from ..errors import KnowledgeError
from ..install.channels import (
    ROLLBACK_DOCS,
    Channel,
    ChannelInfo,
    can_roll_back,
    detect_channel,
    manual_update_command,
)
from ..install.latest import CheckOutput, Fetch, latest_version, newer, parse_version
from ..install.system import Located, base_env, run_capture
from ..install.tasks import InstallManager, InstallTask
from .engine import EngineId
from .registry import ENGINE_IDS, ENGINE_NAMES, EngineRegistry
from .update_gate import UpdateGate

log = logging.getLogger(__name__)

SETTINGS_KEY = "agents.updates"
START_DELAY = timedelta(minutes=1)
INTERVAL = timedelta(hours=24)
HTTP_TIMEOUT_S = 15.0
HERMES_CHECK_TIMEOUT_S = 120.0
MAX_OUTPUT_LINES = 20
SERVICES_NOTE = "Running Hermes services keep the old version until you restart them."

RunPhase = Literal["idle", "queued", "updating"]
RunAction = Literal["upgrade", "rollback"]
#: ``skaz``: SKAZ rolls back with the agent's own command; ``manual``: the user does (docs link);
#: ``none``: nothing to roll back (the previous version is still there).
Rollback = Literal["skaz", "manual", "none"]
LocateAgent = Callable[[EngineId], Located | None]
HermesRunner = Callable[[Located], Awaitable[CheckOutput]]

#: A package manager's command an agent tells the user to run ("Claude is managed by Homebrew …").
_HINT = re.compile(r"\b((?:brew|npm|pnpm|bun|yarn|mise|asdf|winget|apk|vp)\s+(?:upgrade|install|update|add|i)"
                   r"\b[^`'\"\n]*)")


class UpdateRefused(KnowledgeError):
    status_code = 409


@dataclass(frozen=True)
class UpdateFailure:
    reason: str
    #: The exact command to run in Terminal instead.
    command: str
    #: The last lines the command printed.
    output: tuple[str, ...]
    #: The version before the update (what a rollback installs).
    previous: str | None
    rollback: Rollback
    docs_url: str


@dataclass(frozen=True)
class AgentUpdateView:
    engine: EngineId
    name: str
    channel: Channel
    installed: str | None
    latest: str | None
    #: A newer version than the installed one, not skipped.
    available: bool
    #: Available and not yet seen in Settings (the dot).
    unseen: bool
    skipped: str | None
    #: The agent runs work now: Update waits for it ("Update after current work").
    busy: bool
    phase: RunPhase
    action: RunAction | None
    task_id: str | None
    #: Said before the update runs (decision 2).
    note: str
    #: Hermes: its running services keep the old version (decision 8).
    services_note: str | None
    failure: UpdateFailure | None
    checked_at: str | None


@dataclass(frozen=True)
class UpdatesView:
    auto: bool
    checking: bool
    checked_at: str | None
    next_check_at: str | None
    unseen: bool
    agents: tuple[AgentUpdateView, ...]


@dataclass
class _Run:
    action: RunAction
    previous: str | None
    values: dict[str, str]
    phase: RunPhase = "queued"
    task_id: str | None = None
    job: asyncio.Task[None] | None = None


@dataclass
class _State:
    auto: bool = True
    attempted_at: str | None = None
    checked_at: str | None = None
    agents: dict[str, dict[str, Any]] = field(default_factory=dict)

    @classmethod
    def read(cls, raw: Any) -> _State:
        if not isinstance(raw, dict):
            return cls()
        agents = raw.get("agents")
        return cls(auto=raw.get("auto") is not False, attempted_at=_text(raw.get("attempted_at")),
                   checked_at=_text(raw.get("checked_at")),
                   agents={k: dict(v) for k, v in agents.items() if isinstance(v, dict)}
                   if isinstance(agents, dict) else {})

    def dump(self) -> dict[str, Any]:
        return {"auto": self.auto, "attempted_at": self.attempted_at, "checked_at": self.checked_at,
                "agents": self.agents}


def _text(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _iso(moment: datetime) -> str:
    return moment.astimezone(UTC).isoformat(timespec="seconds")


def _parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        moment = datetime.fromisoformat(value)
    except ValueError:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)


def background_checks_enabled(env: Mapping[str, str]) -> bool:
    """No background update traffic from smoke, profile and test runs — the same switches as SKAZ's own
    update check (``electron/updates.ts::updateChecksEnabled``); development passes ``SKAZ_*`` through."""
    if env.get("SKAZ_UPDATE_CHECK") == "0":
        return False
    return not env.get("SKAZ_OPTIN_SMOKE_USER_DATA") and not env.get("SKAZ_PROFILE_SMOKE_HOME")


def next_check_at(started: datetime, attempted_at: datetime | None, *, start_delay: timedelta = START_DELAY,
                  interval: timedelta = INTERVAL) -> datetime:
    """~1 min after start, unless the last check was less than ``interval`` ago (then its next turn)."""
    first = started + start_delay
    return first if attempted_at is None else max(first, attempted_at + interval)


def terminal_hint(lines: list[str]) -> str | None:
    """The package-manager command the agent's own output tells the user to run, if any."""
    for line in reversed(lines[-200:]):
        if line.startswith("$ "):
            continue  # SKAZ's own echo of the command it ran
        match = _HINT.search(line)
        if match:
            return match[1].strip().rstrip(".,;:)").strip()[:200]
    return None


async def http_fetch(url: str) -> str:
    """One read-only GET (no cookies, no user data); raises on a network error or a non-2xx answer."""
    import httpx

    headers = {"User-Agent": "SKAZ agent update check", "Accept": "application/json, text/plain;q=0.9"}
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_S, follow_redirects=True, headers=headers) as client:
        response = await client.get(url)
        response.raise_for_status()
        return response.text[:2_000_000]


async def hermes_check_command(located: Located) -> CheckOutput:
    """``hermes update --check`` with the user's own Hermes, like ``hermes update`` itself runs."""
    result = await run_capture([str(located.binary), "update", "--check"], env=base_env(located.path),
                               timeout=HERMES_CHECK_TIMEOUT_S)
    return CheckOutput(result.returncode, f"{result.stdout}\n{result.stderr}")


class AgentUpdates:
    def __init__(self, registry: EngineRegistry, installs: InstallManager, gate: UpdateGate, *,
                 locate: LocateAgent, home: Path | None = None, fetch: Fetch | None = None,
                 hermes_check: HermesRunner | None = None, now: Callable[[], datetime] | None = None,
                 start_delay: timedelta = START_DELAY, interval: timedelta = INTERVAL) -> None:
        self.registry = registry
        self.installs = installs
        self.gate = gate
        self._locate = locate
        self._home = home or Path.home()
        self._fetch: Fetch = fetch or http_fetch
        self._hermes: HermesRunner = hermes_check or hermes_check_command
        self._now = now or (lambda: datetime.now(UTC))
        self._start_delay = start_delay
        self._interval = interval
        self._lock = asyncio.Lock()
        self._runs: dict[EngineId, _Run] = {}
        self._checking: asyncio.Task[None] | None = None
        self._loop: asyncio.Task[None] | None = None
        self._wake = asyncio.Event()
        self._started: datetime | None = None

    # -- persisted state ------------------------------------------------------------------------

    def _read(self) -> _State:
        try:
            return _State.read(self.registry.settings.get(SETTINGS_KEY))
        except Exception as error:  # an unreadable record must not take the agents screen down
            log.warning("agent updates: state unreadable (%s)", type(error).__name__)
            return _State()

    def _write(self, state: _State) -> None:
        self.registry.settings.set(SETTINGS_KEY, state.dump())

    async def _change(self, change: Callable[[_State], None]) -> _State:
        async with self._lock:
            state = await disk_call(self._read)
            change(state)
            await disk_call(self._write, state)
            return state

    # -- what the user sees ---------------------------------------------------------------------

    def _installed(self, engine: EngineId, record: Mapping[str, Any]) -> str | None:
        last = self.registry.last_view(engine)
        if last is None:
            return _text(record.get("installed"))
        return last.status.version if last.status.installed else None

    def _agent(self, engine: EngineId, state: _State) -> AgentUpdateView:
        record = state.agents.get(engine, {})
        name = ENGINE_NAMES[engine]
        channel: Channel = record.get("channel") or "unknown"
        installed = self._installed(engine, record)
        latest = _text(record.get("latest"))
        skipped = _text(record.get("skipped"))
        available = channel != "unknown" and newer(latest, installed) and latest != skipped
        run = self._runs.get(engine)
        return AgentUpdateView(
            engine=engine, name=name, channel=channel, installed=installed, latest=latest,
            available=available, unseen=available and record.get("seen") != latest, skipped=skipped,
            busy=self.gate.busy(engine), phase=run.phase if run else "idle",
            action=run.action if run else None, task_id=run.task_id if run else None,
            note=f"Updates {name} for this whole Mac, including Terminal.",
            services_note=SERVICES_NOTE if engine == "hermes" else None,
            failure=_failure(record.get("failure")), checked_at=_text(record.get("checked_at")),
        )

    def _view(self, state: _State) -> UpdatesView:
        agents = tuple(self._agent(engine, state) for engine in ENGINE_IDS)
        upcoming = None
        if state.auto and self._started is not None:
            upcoming = _iso(next_check_at(self._started, _parse_time(state.attempted_at),
                                          start_delay=self._start_delay, interval=self._interval))
        return UpdatesView(auto=state.auto, checking=self._checking is not None and not self._checking.done(),
                           checked_at=state.checked_at, next_check_at=upcoming,
                           unseen=any(agent.unseen for agent in agents), agents=agents)

    async def view(self) -> UpdatesView:
        return self._view(await disk_call(self._read))

    async def set_auto(self, on: bool) -> UpdatesView:
        def change(state: _State) -> None:
            state.auto = on
        state = await self._change(change)
        if on:
            self._started = self._now()  # first background check ~1 min from now (or its turn)
        self._wake.set()
        return self._view(state)

    async def mark_seen(self) -> UpdatesView:
        def change(state: _State) -> None:
            for engine in ENGINE_IDS:
                agent = self._agent(engine, state)
                if agent.available:
                    state.agents.setdefault(engine, {})["seen"] = agent.latest
        return self._view(await self._change(change))

    async def skip(self, engine: EngineId, version: str) -> UpdatesView:
        if parse_version(version) is None:
            raise UpdateRefused("That isn't a version SKAZ offered.")

        def change(state: _State) -> None:
            record = state.agents.setdefault(engine, {})
            record["skipped"] = version
        return self._view(await self._change(change))

    # -- checking -------------------------------------------------------------------------------

    async def check(self) -> UpdatesView:
        """Check every installed agent now (joins a check already on its way)."""
        if self._checking is None or self._checking.done():
            self._checking = asyncio.create_task(self._round())
        await asyncio.shield(self._checking)
        self._wake.set()  # the background turn counts from this check
        return await self.view()

    async def _round(self) -> None:
        moment = _iso(self._now())

        def attempted(state: _State) -> None:
            state.attempted_at = moment
        await self._change(attempted)
        found = await asyncio.gather(*(self._check_one(engine) for engine in ENGINE_IDS
                                       if engine not in self._runs), return_exceptions=True)
        results = [item for item in found if isinstance(item, tuple)]

        def store(state: _State) -> None:
            for engine, info, installed, latest in results:
                record = state.agents.setdefault(engine, {})
                record.update(channel=info.channel, detail=info.detail, installed=installed, latest=latest,
                              checked_at=moment)
                if latest is not None and installed is not None and not newer(latest, installed):
                    record.pop("failure", None)  # up to date now (updated by hand): nothing left to fix
            if results:
                state.checked_at = moment
        await self._change(store)

    async def _check_one(self, engine: EngineId) -> tuple[EngineId, ChannelInfo, str, str | None] | None:
        view = await self.registry.view(engine)
        version = view.status.version
        if not view.status.installed or not version:
            return None  # only installed agents with a known version are checked
        located = await disk_call(self._locate, engine)
        if located is None:
            return None
        info = await disk_call(detect_channel, engine, located.binary, home=self._home)

        async def hermes() -> CheckOutput:
            return await self._hermes(located)
        try:
            latest = await latest_version(info, fetch=self._fetch, hermes_check=hermes)
        except Exception as error:  # network or refusal: silent, the last result stays
            log.info("agent updates: %s check skipped (%s)", engine, type(error).__name__)
            raise
        return engine, info, version, latest

    # -- the background schedule ----------------------------------------------------------------

    def start(self) -> None:
        if self._loop is None or self._loop.done():
            self._started = self._now()
            self._loop = asyncio.create_task(self._schedule(), name="agent-update-checks")

    async def _schedule(self) -> None:
        while True:
            self._wake.clear()
            state = await disk_call(self._read)
            if not state.auto:
                await self._wake.wait()  # off: no background requests until switched on
                continue
            started = self._started or self._now()
            due = next_check_at(started, _parse_time(state.attempted_at), start_delay=self._start_delay,
                                interval=self._interval)
            delay = (due - self._now()).total_seconds()
            if delay > 0:
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(self._wake.wait(), delay)
                    continue  # switched, or checked by hand: count again
            try:
                await self.check()
            except Exception as error:  # never let one bad check stop the schedule
                log.warning("agent updates: background check failed (%s)", type(error).__name__)

    async def aclose(self) -> None:
        tasks = [task for task in (self._loop, self._checking) if task is not None]
        tasks += [run.job for run in self._runs.values() if run.job is not None]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    # -- updating -------------------------------------------------------------------------------

    async def update(self, engine: EngineId) -> UpdatesView:
        state = await disk_call(self._read)
        agent = self._agent(engine, state)
        if engine in self._runs:
            return self._view(state)
        if not agent.available or agent.latest is None:
            raise UpdateRefused(f"There is no newer {agent.name} to install.")
        self._begin(engine, _Run("upgrade", agent.installed, {}))
        return self._view(state)

    async def rollback(self, engine: EngineId) -> UpdatesView:
        state = await disk_call(self._read)
        agent = self._agent(engine, state)
        failure = agent.failure
        if engine in self._runs:
            return self._view(state)
        if failure is None or failure.rollback != "skaz" or parse_version(failure.previous or "") is None:
            raise UpdateRefused(f"SKAZ can't roll {agent.name} back. Roll it back by hand.")
        self._begin(engine, _Run("rollback", failure.previous, {"version": str(failure.previous)}))
        return self._view(state)

    async def cancel(self, engine: EngineId) -> UpdatesView:
        """A queued update is dropped; a running one is cancelled like an installation."""
        run = self._runs.get(engine)
        if run is not None and run.task_id is not None:
            await self.installs.cancel(run.task_id)
        elif run is not None and run.job is not None:
            run.job.cancel()
            await asyncio.gather(run.job, return_exceptions=True)
        return await self.view()

    def _begin(self, engine: EngineId, run: _Run) -> None:
        run.phase = "queued" if self.gate.busy(engine) else "updating"
        self._runs[engine] = run
        run.job = asyncio.create_task(self._drive(engine, run), name=f"agent-update-{engine}")

    async def _drive(self, engine: EngineId, run: _Run) -> None:
        try:
            async with self.gate.exclusive(engine):
                run.phase = "updating"
                try:
                    task = self.installs.start(engine, run.action, run.values)
                except KnowledgeError as error:
                    await self._fail(engine, run, error.message, [])
                    return
                run.task_id = task.id
                self.registry.forget(engine)
                task = await self.installs.finished(task.id)
            await self._settle(engine, run, task)
        except asyncio.CancelledError:
            pass  # cancelled while it waited for work to finish (nothing ran) or while SKAZ closed
        except Exception as error:
            log.error("agent updates: %s %s failed (%s)", engine, run.action, type(error).__name__)
        finally:
            self._runs.pop(engine, None)

    async def _info(self, engine: EngineId) -> ChannelInfo:
        state = await disk_call(self._read)
        record = state.agents.get(engine, {})
        channel = record.get("channel")
        if isinstance(channel, str):
            return ChannelInfo(engine, cast(Channel, channel), _text(record.get("detail")))
        located = await disk_call(self._locate, engine)
        return (await disk_call(detect_channel, engine, located.binary, home=self._home) if located
                else ChannelInfo(engine, "unknown"))

    async def _settle(self, engine: EngineId, run: _Run, task: InstallTask) -> None:
        name = ENGINE_NAMES[engine]
        lines = [line.text for line in task.lines]
        self.registry.forget(engine)
        if task.state == "cancelled":
            return
        if task.state == "succeeded":
            if run.action == "upgrade" and not newer(task.version, run.previous):
                # The command finished without updating (e.g. "Claude is managed by Homebrew").
                still = task.version or run.previous
                await self._fail(engine, run, f"{name} wasn't updated: it is still {still}." if still
                                 else f"{name} wasn't updated.", lines, rollback="none")
                return
            version = task.version

            def done(state: _State) -> None:
                record = state.agents.setdefault(engine, {})
                record.pop("failure", None)
                if version:
                    record["installed"] = version
            await self._change(done)
            return
        status = (await self.registry.view(engine, refresh=True)).status
        reason = task.reason or f"The {name} update failed."
        unchanged = status.installed and status.version is not None and status.version == run.previous
        if unchanged:
            reason = f"{reason} {name} {status.version} is still installed."
        await self._fail(engine, run, reason, lines, rollback="none" if unchanged else None)

    async def _fail(self, engine: EngineId, run: _Run, reason: str, lines: list[str],
                    rollback: Rollback | None = None) -> None:
        info = await self._info(engine)
        if rollback is None:
            rollback = "skaz" if can_roll_back(info) and parse_version(run.previous or "") else "manual"
        output = tuple(line for line in lines if not line.startswith("$ "))[-MAX_OUTPUT_LINES:]
        previous = run.previous
        if run.action == "rollback":
            previous = run.values.get("version", run.previous)
        failure = {"reason": reason, "command": terminal_hint(lines) or manual_update_command(info),
                   "output": list(output), "previous": previous, "rollback": rollback,
                   "docs_url": ROLLBACK_DOCS[engine]}

        def change(state: _State) -> None:
            state.agents.setdefault(engine, {})["failure"] = failure
        await self._change(change)


def _failure(raw: Any) -> UpdateFailure | None:
    if not isinstance(raw, dict) or not isinstance(raw.get("reason"), str):
        return None
    rollback = raw.get("rollback")
    output = raw.get("output")
    return UpdateFailure(
        reason=raw["reason"], command=str(raw.get("command") or ""),
        output=tuple(str(line) for line in output) if isinstance(output, list) else (),
        previous=_text(raw.get("previous")),
        rollback=rollback if rollback in ("skaz", "manual", "none") else "none",
        docs_url=str(raw.get("docs_url") or ""),
    )
