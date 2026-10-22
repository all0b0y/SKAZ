"""Official installation of the three agents (WIKI-BACKEND-SPEC B2a).

Commands and URLs were checked on 2026-10-15 in each vendor's own documentation:

* Claude Code — https://code.claude.com/docs/en/setup ("Native Install
  (Recommended)", macOS/Linux/WSL): ``curl -fsSL https://claude.ai/install.sh | bash``.
  Installs to ``~/.local/bin/claude`` (launcher) and ``~/.local/share/claude``;
  no administrator rights. Re-running it installs the latest version (update).
* Codex CLI — https://github.com/openai/codex (README) and
  https://developers.openai.com/codex/cli: ``curl -fsSL https://chatgpt.com/codex/install.sh | sh``.
* OpenCode — https://opencode.ai/docs/ ("Install"): ``curl -fsSL https://opencode.ai/install | bash``
  (installs to ``~/.opencode/bin/opencode``, checked on 2026-10-21 against the installed 1.17.18);
  update: ``opencode upgrade`` (``opencode --help``).
* Hermes Agent — https://hermes-agent.nousresearch.com/docs/getting-started/installation:
  ``curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash`` with
  ``--non-interactive`` (skips the stages that need input; setup is done later
  from SKAZ with ``hermes model``). Code goes to ``~/.hermes/hermes-agent``,
  launcher to ``~/.local/bin/hermes``. Update: ``hermes update``
  (/docs/getting-started/updating). The ACP extra
  (/docs/user-guide/features/acp, "Installation"): in the install checkout,
  ``python -c "import pm; pm.sync_venv(['acp'], explicit=True)"`` run through
  ``scripts/run-in-hermes-env`` (/docs/reference/package-management); the
  source installer's ``[all]`` extra already includes ``[acp]`` (pyproject),
  so this step is a no-op on fresh installs and repairs older ones. Then
  ``hermes acp --check`` verifies it — in SKAZ's own Hermes folder, like every
  other SKAZ start of Hermes (review C1).

None of these needs ``sudo``; SKAZ refuses any command that would use it.

Hermes' first check (decision B10, X5): SKAZ never starts Hermes with its own
folder by itself; the ``first_check`` action runs ``hermes acp --check`` once for
SKAZ's Hermes folder (on the user's own tool store, ``HERMES_RUNTIME_DIR`` — nothing
is downloaded), with the same log as an installation, only when the user asks.
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal

from ..agents.engine import EngineId

Action = Literal["install", "update", "first_check", "repair"]
CHECKED_ON = "2026-10-15"


@dataclass(frozen=True)
class Step:
    label: str
    #: ``{install_dir}`` and ``{binary}`` are filled in right before the step runs.
    argv: tuple[str, ...]
    cwd: str | None = None
    #: Extra environment for this step (values filled in like ``argv``).
    env: tuple[tuple[str, str], ...] = ()


@dataclass(frozen=True)
class Recipe:
    engine: EngineId
    name: str
    #: Name of the executable the installer provides (lookup like ``codex_locate``).
    binary: str
    docs_url: str
    #: Shown under "How to install manually" for copying into Terminal.
    manual_command: str
    plan: Callable[[Action], tuple[Step, ...]]
    checked_on: str = CHECKED_ON
    #: SKAZ starts the agent only after a one-time check (``first_check`` action; Hermes only).
    first_check: bool = False
    #: The agent has its own repair command (``repair`` action; Hermes only).
    repair: bool = False


def _shell(command: str) -> tuple[str, ...]:
    """A pipeline in bash with ``pipefail`` so a failed download is a failed step."""
    return ("/bin/bash", "-c", f"set -o pipefail; {command}")


CLAUDE_INSTALL = "curl -fsSL https://claude.ai/install.sh | bash"
CODEX_INSTALL = "curl -fsSL https://chatgpt.com/codex/install.sh | sh"
OPENCODE_INSTALL = "curl -fsSL https://opencode.ai/install | bash"
HERMES_INSTALL = "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash -s -- --non-interactive"
HERMES_ACP_EXTRA = ("{install_dir}/scripts/run-in-hermes-env", "python", "-c",
                    "import pm; pm.sync_venv(['acp'], explicit=True)")


def _claude(action: Action) -> tuple[Step, ...]:
    return (Step("Run the official Claude Code installer", _shell(CLAUDE_INSTALL)),)


def _codex(action: Action) -> tuple[Step, ...]:
    return (Step("Run the official Codex installer", _shell(CODEX_INSTALL)),)


def _opencode(action: Action) -> tuple[Step, ...]:
    if action == "update":  # OpenCode's own upgrade of the install it made (``opencode upgrade``)
        return (Step("Update OpenCode", ("{binary}", "upgrade")),)
    return (Step("Run the official OpenCode installer", _shell(OPENCODE_INSTALL)),)


#: SKAZ's own Hermes folder and policy on the user's own tool store (review C1,
#: ``agents/hermes_launchers.py``): without ``HERMES_RUNTIME_DIR`` Hermes would build a store
#: in SKAZ's folder and re-point the user's launcher.
SKAZ_HERMES_ENV = (("HERMES_HOME", "{hermes_home}"), ("HERMES_MANAGED_DIR", "{hermes_policy}"),
                   ("HERMES_RUNTIME_DIR", "{hermes_runtime}"))
HERMES_FIRST_CHECK = Step("Check that Hermes Agent runs with SKAZ's own Hermes folder",
                          ("{binary}", "acp", "--check"), env=SKAZ_HERMES_ENV)
#: Hermes keeps its dependencies per data folder (``HERMES_HOME``); for SKAZ's own folder it may have
#: none yet, and its launcher then asks for ``hermes pm repair`` — Hermes' own fix, run for that folder.
HERMES_REPAIR = Step("Repair Hermes Agent for SKAZ's own Hermes folder", ("{binary}", "pm", "repair"),
                     env=SKAZ_HERMES_ENV)


def _hermes(action: Action) -> tuple[Step, ...]:
    if action == "first_check":
        return (HERMES_FIRST_CHECK,)
    if action == "repair":
        return (HERMES_REPAIR, Step("Check ACP support", ("{binary}", "acp", "--check"), env=SKAZ_HERMES_ENV))
    first = (Step("Run the official Hermes Agent installer", _shell(HERMES_INSTALL)) if action == "install"
             else Step("Update Hermes Agent", ("{binary}", "update")))
    return (
        first,
        Step("Add ACP support to Hermes Agent", HERMES_ACP_EXTRA, cwd="{install_dir}"),
        Step("Check ACP support", ("{binary}", "acp", "--check"), env=SKAZ_HERMES_ENV),
    )


RECIPES: dict[EngineId, Recipe] = {
    "claude_code": Recipe("claude_code", "Claude Code", "claude", "https://code.claude.com/docs/en/setup",
                          CLAUDE_INSTALL, _claude),
    "codex": Recipe("codex", "Codex", "codex", "https://developers.openai.com/codex/cli", CODEX_INSTALL,
                    _codex),
    "hermes": Recipe("hermes", "Hermes Agent", "hermes",
                     "https://hermes-agent.nousresearch.com/docs/getting-started/installation",
                     "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash", _hermes,
                     first_check=True, repair=True),
    "opencode": Recipe("opencode", "OpenCode", "opencode", "https://opencode.ai/docs/", OPENCODE_INSTALL,
                       _opencode, checked_on="2026-10-21"),
}
