"""Find the user's Codex CLI and its Node runtime from a GUI-launched process.

An app started from Finder/Dock inherits launchd's PATH (``/usr/bin:/bin:...``),
not the login shell's, so ``shutil.which`` alone misses installs in
``~/.local/bin``, Homebrew or nvm. The desktop process passes the login-shell
PATH as ``AUDIOHELPER_USER_PATH``; standard install folders are the fallback.
Nothing here runs a binary.
"""
from __future__ import annotations

import os
import shutil
from dataclasses import dataclass
from pathlib import Path

USER_PATH_ENV = "AUDIOHELPER_USER_PATH"


def standard_dirs(home: Path) -> list[str]:
    nvm = sorted((home / ".nvm" / "versions" / "node").glob("*/bin"), reverse=True)
    return [
        str(home / ".local" / "bin"), "/opt/homebrew/bin", "/usr/local/bin",
        str(home / ".npm-global" / "bin"), str(home / ".volta" / "bin"),
        *(str(p) for p in nvm),
    ]


def search_path(env: dict[str, str] | None = None, home: Path | None = None) -> str:
    """User PATH, then this process's PATH, then standard folders; deduplicated."""
    env = dict(os.environ) if env is None else env
    home = Path.home() if home is None else home
    seen: list[str] = []
    for source in (env.get(USER_PATH_ENV, ""), env.get("PATH", "")):
        for entry in source.split(os.pathsep):
            if entry and entry not in seen:
                seen.append(entry)
    for entry in standard_dirs(home):
        if entry not in seen:
            seen.append(entry)
    return os.pathsep.join(seen)


@dataclass(frozen=True)
class CodexLocation:
    binary: str
    #: Folder holding ``node`` when the CLI is a Node script; None if not found.
    node_dir: str | None

    def child_path(self) -> str:
        """PATH for the Codex child: its own folder, Node, then the system."""
        parts = [str(Path(self.binary).parent)]
        if self.node_dir and self.node_dir not in parts:
            parts.append(self.node_dir)
        parts += ["/usr/bin", "/bin"]
        return os.pathsep.join(parts)


def locate_codex(env: dict[str, str] | None = None, home: Path | None = None) -> CodexLocation | None:
    path = search_path(env, home)
    binary = shutil.which("codex", path=path)
    if binary is None:
        return None
    # Prefer the Node beside the resolved script (nvm/npm prefix installs), then the search path.
    beside = Path(os.path.realpath(binary)).parent
    node = shutil.which("node", path=os.pathsep.join([str(beside), str(Path(binary).parent), path]))
    return CodexLocation(binary=binary, node_dir=str(Path(node).parent) if node else None)
