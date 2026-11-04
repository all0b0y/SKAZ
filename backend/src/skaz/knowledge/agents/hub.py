"""``runtime.kb_agents``: engines, their statuses, installs and sign-in in one place."""
from __future__ import annotations

import asyncio
import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from ...gateways.codex_connection import CodexConnection
from ..install.errors import StepWatch
from ..install.recipes import RECIPES, Action
from ..install.runner import Executor
from ..install.system import LocateFn, locate
from ..install.tasks import InstallManager
from ..install.terminal import TerminalLauncher
from .claude_code import ClaudeCodeEngine
from .engine import AgentEngine, EngineId, EngineStatus
from .hermes import HermesEngine
from .hermes_accounts import HermesAccounts
from .mcp_access import McpAccessProvider
from .opencode import OpenCodeEngine, locate_opencode
from .registry import AgentAction, AgentState, AgentView, CodexStatusEngine, EngineRegistry, SettingsStore
from .update_gate import UpdateGate, guard
from .updates import AgentUpdates, background_checks_enabled


@dataclass
class AgentsHub:
    registry: EngineRegistry
    installs: InstallManager
    #: Hermes' providers in SKAZ's folder (K1/K3); ``None`` when Hermes is a test double.
    hermes_accounts: HermesAccounts | None = None
    #: U1: checks for newer agent versions, offers and runs their updates.
    updates: AgentUpdates | None = None
    #: U1: every run of every engine passes it (an update makes the agent's new work wait).
    gate: UpdateGate | None = None

    def blocked(self, engine: EngineId) -> bool:
        """An update holds ``engine`` now (queued or running): housekeeping that starts the agent outside
        a run (deleting sessions) skips it and tries later. With an engine object, use
        ``update_gate.blocked(engine)``."""
        return self.gate is not None and self.gate.blocked(engine)

    def state(self, view: AgentView) -> tuple[AgentState, AgentAction | None]:
        """The view's state, or ``preparing`` while the agent's first check runs (B10)."""
        running = self.installs.running_for(view.engine)
        if running is not None and running.action == "first_check":
            return "preparing", None
        return view.state, view.action

    def start(self) -> None:
        """App start, once the library is open: background housekeeping of the agents.

        Hermes deletes what earlier runs left in its session store (a quit mid-answer, a delete
        that failed) — only after the user's first check (B10); returns at once.
        """
        hermes = self.registry.engines.get("hermes")
        if isinstance(hermes, HermesEngine):
            hermes.sweep_at_start()
        opencode = self.registry.engines.get("opencode")
        if isinstance(opencode, OpenCodeEngine):
            opencode.sweep_at_start()  # sessions earlier runs left in SKAZ's OpenCode folder
        if self.updates is not None and background_checks_enabled(os.environ):
            self.updates.start()  # U1: the first check ~1 min from now, then every 24 h

    async def aclose(self) -> None:
        hermes = self.registry.engines.get("hermes")
        closing = [self.installs.aclose()]
        if self.updates is not None:
            closing.append(self.updates.aclose())
        if isinstance(hermes, HermesEngine):
            closing.append(hermes.aclose())  # Hermes 0.22's gateway of SKAZ's folder (B18)
        await asyncio.gather(*closing)


def build_agents_hub(data_dir: Path, *, settings: SettingsStore, codex: CodexConnection,
                     mcp: McpAccessProvider | None = None,
                     codex_engine: AgentEngine | None = None,
                     engines: Mapping[EngineId, AgentEngine] | None = None,
                     executor: Executor | None = None, locate_cli: LocateFn | None = None,
                     user_home: Path | None = None) -> AgentsHub:
    agents_dir = data_dir / "agents"
    finder: LocateFn = locate_cli or locate
    #: OpenCode's installer puts it in ``~/.opencode/bin``, outside the usual search path.
    opencode_finder: LocateFn = locate_cli or (lambda name: locate_opencode(name, home=user_home))
    if engines is None:
        launcher = TerminalLauncher(agents_dir / "launch")
        engines = {
            # The real Codex engine (A1) when given; the status-only placeholder otherwise.
            "codex": codex_engine or CodexStatusEngine(codex),
            "claude_code": ClaudeCodeEngine(agents_dir / "claude-code", mcp=mcp, locate_cli=finder,
                                            launcher=launcher),
            "hermes": HermesEngine(data_dir, mcp=mcp, locate_cli=finder, launcher=launcher,
                                   user_home=user_home, first_run_gate=True),
            "opencode": OpenCodeEngine(data_dir, mcp=mcp, locate_cli=opencode_finder, launcher=launcher,
                                       user_home=user_home),
        }
    registry = EngineRegistry(engines, settings)

    async def verify(engine: EngineId) -> EngineStatus:
        return (await registry.view(engine, refresh=True)).status

    async def resolve(engine: EngineId) -> dict[str, str]:
        values: dict[str, str] = {}
        located = (opencode_finder if engine == "opencode" else finder)(RECIPES[engine].binary)
        if located is not None:
            values["binary"] = str(located.binary)
        if engine == "hermes":
            target = registry.engine("hermes")
            folder = await target.install_dir() if isinstance(target, HermesEngine) and located else None
            values["install_dir"] = str(folder or (user_home or Path.home()) / ".hermes" / "hermes-agent")
            if isinstance(target, HermesEngine):
                # Every SKAZ start of Hermes uses SKAZ's own Hermes folder, never ~/.hermes (B10).
                target.prepare()
                values["hermes_home"] = str(target.home)
                values["hermes_policy"] = str(target.policy_dir)
                if located is not None:
                    values["hermes_runtime"] = str(target.runtime_dir(located))
        return values

    def after_steps(engine: EngineId, action: Action) -> None:
        target = registry.engine(engine)
        if action == "first_check" and isinstance(target, HermesEngine):
            target.mark_checked()
        registry.forget(engine)

    def watch_step(engine: EngineId, env: Mapping[str, str]) -> StepWatch | None:
        """Hermes steps run under a launcher watch: strict in SKAZ's folder, else only SKAZ paths count."""
        target = registry.engine(engine)
        located = finder(RECIPES[engine].binary)
        if not isinstance(target, HermesEngine) or located is None:
            return None
        return target.watch(located, strict=env.get("HERMES_HOME") == str(target.home))

    installs = InstallManager(agents_dir / "install", verify=verify, resolve=resolve, executor=executor,
                              after_steps=after_steps, watch_step=watch_step)
    hermes = registry.engine("hermes")
    accounts = HermesAccounts(hermes) if isinstance(hermes, HermesEngine) else None
    # U1 decision 5: an agent's work waits while it is updated (every run passes the gate).
    gate = UpdateGate()
    for target in registry.engines.values():
        guard(target, gate)

    async def after_update(engine: EngineId) -> None:
        # U1 decision 8 / FIX-1 F3.8: ``hermes update --no-gateway-restart`` leaves running gateways on the
        # old code — SKAZ's own one too. Stop it (the existing planned stop) so the next answer starts the
        # new version; Hermes' gateways of the user's own folders are never touched.
        target = registry.engine(engine)
        if isinstance(target, HermesEngine):
            await target.aclose()

    updates = AgentUpdates(registry, installs, gate, home=user_home, after_update=after_update,
                           locate=lambda engine: (opencode_finder if engine == "opencode" else finder)(
                               RECIPES[engine].binary))
    return AgentsHub(registry, installs, accounts, updates, gate)
