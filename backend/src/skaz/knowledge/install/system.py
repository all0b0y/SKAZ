"""Find agent CLIs and run short, bounded commands on them.

A GUI-launched SKAZ inherits launchd's PATH, so lookup uses the same search
path as ``gateways/codex_locate.py`` (login-shell PATH from ``SKAZ_USER_PATH``,
this process's PATH, then standard install folders). Nothing here elevates
privileges: every command is checked by :func:`refuse_sudo` before it runs.
"""
from __future__ import annotations

import asyncio
import contextlib
import os
import re
import shutil
import signal
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

from ...gateways.codex_locate import search_path
from ..processes import CHILDREN

Version = tuple[int, int, int]
_SUDO = re.compile(r"(^|[\s;&|()`/])(sudo|doas|su)(\s|$)")


class ElevationRefused(ValueError):
    """A command would ask for administrator rights; SKAZ never runs those."""


def refuse_sudo(argv: Sequence[str]) -> None:
    """Raise if any word of the command (including a ``bash -c`` script) elevates privileges."""
    for part in argv:
        if _SUDO.search(part):
            raise ElevationRefused("SKAZ never runs commands with administrator rights.")


@dataclass(frozen=True)
class Located:
    binary: Path
    #: PATH for the child: the CLI's folder, Node beside it (npm installs), the system.
    path: str


#: ``locate`` or a test double: binary name -> where it is, or None.
LocateFn = Callable[[str], Located | None]


def locate(name: str, env: Mapping[str, str] | None = None, home: Path | None = None) -> Located | None:
    path = search_path(dict(env) if env is not None else None, home)
    found = shutil.which(name, path=path)
    if found is None:
        return None
    binary = Path(found)
    parts = [str(binary.parent)]
    real_parent = str(Path(os.path.realpath(found)).parent)
    node = shutil.which("node", path=os.pathsep.join([real_parent, str(binary.parent), path]))
    if node is not None and str(Path(node).parent) not in parts:
        parts.append(str(Path(node).parent))
    parts += ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]
    return Located(binary, os.pathsep.join(dict.fromkeys(parts)))


def parse_version(text: str, pattern: re.Pattern[str]) -> Version | None:
    match = pattern.search(text)
    if match is None:
        return None
    return int(match[1]), int(match[2]), int(match[3])


def dotted(version: Version) -> str:
    return ".".join(str(part) for part in version)


@dataclass(frozen=True)
class Captured:
    returncode: int
    stdout: str
    stderr: str


async def run_capture(argv: Sequence[str], *, env: Mapping[str, str], cwd: Path | None = None,
                      timeout: float = 15.0, stdin: bytes | None = None) -> Captured:
    """Run a short command (``--version``, ``auth status``) and capture its output; kills on timeout."""
    refuse_sudo(argv)
    process = await asyncio.create_subprocess_exec(
        *argv, env=dict(env), cwd=str(cwd) if cwd else None, start_new_session=True,
        stdin=asyncio.subprocess.PIPE if stdin is not None else asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    CHILDREN.add(process, group=True)
    try:
        async with asyncio.timeout(timeout):
            out, err = await process.communicate(stdin)
    finally:
        if process.returncode is None:
            kill_group(process.pid)
            await process.wait()
        CHILDREN.discard(process)
    return Captured(process.returncode or 0, out.decode(errors="replace"), err.decode(errors="replace"))


def kill_group(pid: int, sig: int = signal.SIGKILL) -> None:
    """Signal the child's whole process group (installers spawn curl/bash/npm children)."""
    try:
        os.killpg(pid, sig)
    except (ProcessLookupError, PermissionError):
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.kill(pid, sig)


def base_env(path: str, home: Path | None = None) -> dict[str, str]:
    """The minimal environment for an agent CLI: never SKAZ's own secrets or tokens."""
    env = {"PATH": path, "HOME": str(home or Path.home()), "LANG": "en_US.UTF-8"}
    for name in ("USER", "LOGNAME", "SHELL", "TMPDIR", "__CF_USER_TEXT_ENCODING"):
        value = os.environ.get(name)
        if value:
            env[name] = value
    return env
