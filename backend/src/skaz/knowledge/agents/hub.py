"""``runtime.kb_agents``: engines, their statuses, installs and sign-in in one place."""
from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from ...gateways.codex_connection import CodexConnection
from ..install.recipes import RECIPES
from ..install.runner import Executor
from ..install.system import LocateFn, locate
from ..install.tasks import InstallManager
from ..install.terminal import TerminalLauncher
from .claude_code import ClaudeCodeEngine
from .engine import AgentEngine, EngineId, EngineStatus
from .hermes import HermesEngine
from .mcp_access import McpAccessProvider
from .registry import CodexStatusEngine, EngineRegistry, SettingsStore


@dataclass
class AgentsHub:
    registry: EngineRegistry
    installs: InstallManager

    async def aclose(self) -> None:
        await self.installs.aclose()


def build_agents_hub(data_dir: Path, *, settings: SettingsStore, codex: CodexConnection,
                     mcp: McpAccessProvider | None = None,
                     engines: Mapping[EngineId, AgentEngine] | None = None,
                     executor: Executor | None = None, locate_cli: LocateFn | None = None,
                     user_home: Path | None = None) -> AgentsHub:
    agents_dir = data_dir / "agents"
    finder: LocateFn = locate_cli or locate
    if engines is None:
        launcher = TerminalLauncher(agents_dir / "launch")
        engines = {
            "codex": CodexStatusEngine(codex),
            "claude_code": ClaudeCodeEngine(agents_dir / "claude-code", mcp=mcp, locate_cli=finder,
                                            launcher=launcher),
            "hermes": HermesEngine(data_dir, mcp=mcp, locate_cli=finder, launcher=launcher,
                                   user_home=user_home),
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
        return values

    installs = InstallManager(agents_dir / "install", verify=verify, resolve=resolve, executor=executor)
    return AgentsHub(registry, installs)
