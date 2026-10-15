"""``runtime.kb_agents``: engines, their statuses, installs and sign-in in one place."""
from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from ...gateways.codex_connection import CodexConnection
from ..install.recipes import RECIPES, Action
from ..install.runner import Executor
from ..install.system import LocateFn, locate
from ..install.tasks import InstallManager
from ..install.terminal import TerminalLauncher
from .claude_code import ClaudeCodeEngine
from .engine import AgentEngine, EngineId, EngineStatus
from .hermes import HermesEngine
from .mcp_access import McpAccessProvider
from .registry import AgentAction, AgentState, AgentView, CodexStatusEngine, EngineRegistry, SettingsStore


@dataclass
class AgentsHub:
    registry: EngineRegistry
    installs: InstallManager

    def state(self, view: AgentView) -> tuple[AgentState, AgentAction | None]:
        """The view's state, or ``preparing`` while the agent's first-run preparation runs (B10)."""
        running = self.installs.running_for(view.engine)
        if running is not None and running.action == "prepare":
            return "preparing", None
        return view.state, view.action

    def start(self) -> None:
        """App start, once the library is open: background housekeeping of the agents.

        Hermes deletes what earlier runs left in its session store (a quit mid-answer, a delete
        that failed) — only when the user prepared it (B10); returns at once.
        """
        hermes = self.registry.engines.get("hermes")
        if isinstance(hermes, HermesEngine):
            hermes.sweep_at_start()

    async def aclose(self) -> None:
        await self.installs.aclose()


def build_agents_hub(data_dir: Path, *, settings: SettingsStore, codex: CodexConnection,
                     mcp: McpAccessProvider | None = None,
                     codex_engine: AgentEngine | None = None,
                     engines: Mapping[EngineId, AgentEngine] | None = None,
                     executor: Executor | None = None, locate_cli: LocateFn | None = None,
                     user_home: Path | None = None) -> AgentsHub:
    agents_dir = data_dir / "agents"
    finder: LocateFn = locate_cli or locate
    if engines is None:
        launcher = TerminalLauncher(agents_dir / "launch")
        engines = {
            # The real Codex engine (A1) when given; the status-only placeholder otherwise.
            "codex": codex_engine or CodexStatusEngine(codex),
            "claude_code": ClaudeCodeEngine(agents_dir / "claude-code", mcp=mcp, locate_cli=finder,
                                            launcher=launcher),
            "hermes": HermesEngine(data_dir, mcp=mcp, locate_cli=finder, launcher=launcher,
                                   user_home=user_home, first_run_gate=True),
        }
    registry = EngineRegistry(engines, settings)

    async def verify(engine: EngineId) -> EngineStatus:
        return (await registry.view(engine, refresh=True)).status

    async def resolve(engine: EngineId) -> dict[str, str]:
        values: dict[str, str] = {}
        located = finder(RECIPES[engine].binary)
        if located is not None:
            values["binary"] = str(located.binary)
        if engine == "hermes":
            target = registry.engine("hermes")
            folder = await target.install_dir() if isinstance(target, HermesEngine) and located else None
            values["install_dir"] = str(folder or (user_home or Path.home()) / ".hermes" / "hermes-agent")
            if isinstance(target, HermesEngine):
                # The first start prepares SKAZ's own Hermes folder, never ~/.hermes (B10).
                target.prepare()
                values["hermes_home"] = str(target.home)
                values["hermes_policy"] = str(target.policy_dir)
        return values

    def after_steps(engine: EngineId, action: Action) -> None:
        target = registry.engine(engine)
        if action == "prepare" and isinstance(target, HermesEngine):
            target.mark_prepared()
        registry.forget(engine)

    installs = InstallManager(agents_dir / "install", verify=verify, resolve=resolve, executor=executor,
                              after_steps=after_steps)
    return AgentsHub(registry, installs)
