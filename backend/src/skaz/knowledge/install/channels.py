"""How each agent was installed on this Mac (U1 decision 7), read from where its binary lives.

SKAZ always updates an agent with the agent's own command (``codex update``, ``claude update``,
``opencode upgrade``, ``hermes update``); the install channel only decides where the latest
version is read from — the same channel the agent's own update installs from — and what to show
when the command refuses ("use brew upgrade"). Nothing here runs a binary or touches the network.

Checked on 2026-10-26 against the installed CLIs and their installers (read-only):

* Codex 0.160.0 (``codex update --help``; the binary names its update commands
  ``npm install -g @openai/codex``, ``brew upgrade --cask codex`` and the standalone installer
  ``https://chatgpt.com/codex/install.sh``, which keeps releases in
  ``~/.codex/packages/standalone``). npm installs live in ``node_modules/@openai/codex``,
  Homebrew's cask in ``Caskroom/codex``.
* Claude Code 2.1.281 (``claude update|upgrade``, ``claude install [stable|latest|<version>]``):
  the native build lives in ``~/.local/share/claude/versions/<version>`` and follows the
  ``autoUpdatesChannel`` setting (``latest`` by default, or ``stable``); a Homebrew cask
  (``Caskroom/claude-code`` or ``claude-code@latest``) makes ``claude update`` refuse with
  "Claude is managed by Homebrew" and ``brew upgrade claude-code``.
* OpenCode 1.17.18: its own ``Installation.method`` says ``curl`` when the binary is in
  ``.opencode/bin`` or ``.local/bin``; npm installs are the ``opencode-ai`` package; Homebrew is the
  core formula ``opencode`` or the tap ``anomalyco/tap/opencode``. ``opencode upgrade <version>``
  works for curl (the installer with ``VERSION``) and npm; for Homebrew it runs ``brew upgrade``.
* Hermes Agent 0.22.1: a git checkout (``hermes --version``: "Install method: git"); other install
  kinds are refused by ``hermes update --check`` itself.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from ..agents.engine import EngineId

Channel = Literal["npm", "brew", "native", "curl", "git", "unknown"]


@dataclass(frozen=True)
class ChannelInfo:
    engine: EngineId
    channel: Channel
    #: Channel detail: Homebrew's cask/formula name, Claude Code's native channel (``latest``/``stable``).
    detail: str | None = None

    @property
    def known(self) -> bool:
        return self.channel != "unknown"


#: Roll back to an earlier version with the agent's own command (decision 6), per channel.
ROLLBACK_CHANNELS: dict[EngineId, tuple[Channel, ...]] = {
    "opencode": ("curl", "npm"),  # ``opencode upgrade <version>``
    "claude_code": ("native",),   # ``claude install <version>``
}
#: Where to read about rolling back by hand when SKAZ can't (Codex, Hermes, other channels).
ROLLBACK_DOCS: dict[EngineId, str] = {
    "codex": "https://github.com/openai/codex/releases",
    "claude_code": "https://code.claude.com/docs/en/setup",
    "hermes": "https://hermes-agent.nousresearch.com/docs/getting-started/updating#manual-source-maintenance-and-rollback",
    "opencode": "https://opencode.ai/docs/",
}

_OWN_COMMAND: dict[EngineId, str] = {
    "codex": "codex update", "claude_code": "claude update", "opencode": "opencode upgrade",
    "hermes": "hermes update",
}


def _parts(path: str) -> str:
    return path.replace(os.sep, "/")


def _cask(real: str, names: tuple[str, ...]) -> str | None:
    for name in names:
        if f"/Caskroom/{name}/" in real:
            return name
    return None


def claude_native_channel(home: Path) -> str:
    """Claude Code's ``autoUpdatesChannel`` (only that key is read): ``latest`` unless set to ``stable``."""
    try:
        data = json.loads((home / ".claude" / "settings.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return "latest"
    value = data.get("autoUpdatesChannel") if isinstance(data, dict) else None
    return "stable" if value == "stable" else "latest"


def detect_channel(engine: EngineId, binary: Path, *, home: Path | None = None) -> ChannelInfo:
    """The install channel from the located binary (as on PATH) and where its links lead."""
    home = home or Path.home()
    real = _parts(os.path.realpath(binary))
    if engine == "codex":
        if "/node_modules/@openai/codex/" in real:
            return ChannelInfo(engine, "npm")
        if _cask(real, ("codex",)):
            return ChannelInfo(engine, "brew", "codex")
        if "/.codex/packages/standalone/" in real:
            return ChannelInfo(engine, "native")
        return ChannelInfo(engine, "unknown")
    if engine == "claude_code":
        if "/.local/share/claude/versions/" in real:
            return ChannelInfo(engine, "native", claude_native_channel(home))
        if "/node_modules/@anthropic-ai/claude-code/" in real:
            return ChannelInfo(engine, "npm", claude_native_channel(home))
        cask = _cask(real, ("claude-code@latest", "claude-code"))
        if cask:
            return ChannelInfo(engine, "brew", cask)
        return ChannelInfo(engine, "unknown")
    if engine == "opencode":
        # npm first: its link may sit in ``~/.local/bin`` when npm's prefix is ``~/.local``.
        if "/node_modules/opencode-ai/" in real or "/node_modules/opencode-" in real:
            return ChannelInfo(engine, "npm")
        # OpenCode's own rule (``Installation.method`` on the running binary's real path): its
        # installer's folders mean "curl".
        if any(f"/{folder}/" in real for folder in (".opencode/bin", ".local/bin")):
            return ChannelInfo(engine, "curl")
        if "/Cellar/opencode/" in real:
            prefix = real.split("/Cellar/opencode/", 1)[0]
            # The tap's formula is read by ``brew info`` from a local tap: no channel SKAZ can ask.
            if Path(prefix, "Library", "Taps", "anomalyco", "homebrew-tap").exists():
                return ChannelInfo(engine, "unknown", "anomalyco/tap/opencode")
            return ChannelInfo(engine, "brew", "opencode")
        return ChannelInfo(engine, "unknown")
    # Hermes: ``hermes update --check`` decides; it refuses anything that isn't its git checkout.
    return ChannelInfo(engine, "git")


def manual_update_command(info: ChannelInfo) -> str:
    """The command to update by hand in Terminal for this channel (shown when SKAZ's run refused)."""
    engine, channel = info.engine, info.channel
    if channel == "npm":
        package = {"codex": "@openai/codex", "claude_code": "@anthropic-ai/claude-code",
                   "opencode": "opencode-ai"}.get(engine)
        if package:
            return f"npm install -g {package}@latest"
    if channel == "brew":
        if engine == "codex":
            return "brew upgrade --cask codex"
        return f"brew upgrade {info.detail or ('claude-code' if engine == 'claude_code' else 'opencode')}"
    return _OWN_COMMAND[engine]


def can_roll_back(info: ChannelInfo) -> bool:
    return info.channel in ROLLBACK_CHANNELS.get(info.engine, ())
