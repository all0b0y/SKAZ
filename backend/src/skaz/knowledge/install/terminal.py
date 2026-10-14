"""Open an agent's own sign-in/setup flow in the user's Terminal.

SKAZ never sees credentials: it writes a small ``.command`` script that runs
the agent's official command (``claude auth login``, ``hermes model``) and asks
macOS to open it in Terminal. The user talks to the agent directly; SKAZ does
not read the script's output, the browser page or the stored tokens.
"""
from __future__ import annotations

import asyncio
import os
import shlex
from collections.abc import Awaitable, Callable, Mapping, Sequence
from pathlib import Path

from .system import refuse_sudo

#: Runs the opener command (``open -a Terminal <script>``); replaced in tests.
Opener = Callable[[Sequence[str]], Awaitable[None]]


async def macos_open(argv: Sequence[str]) -> None:
    process = await asyncio.create_subprocess_exec(
        *argv, stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    async with asyncio.timeout(15):
        code = await process.wait()
    if code != 0:
        raise OSError("macOS could not open Terminal.")


def write_script(directory: Path, name: str, title: str, argv: Sequence[str], env: Mapping[str, str]) -> Path:
    """A self-contained script: exported variables, a heading, then the agent command."""
    refuse_sudo(argv)
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    lines = ["#!/bin/bash", "# Written by SKAZ. Runs the agent's own command; SKAZ does not read its output."]
    lines += [f"export {key}={shlex.quote(value)}" for key, value in sorted(env.items())]
    lines += ["clear", f"echo {shlex.quote(title)}", "echo", shlex.join(argv), "echo",
              "echo " + shlex.quote("You can close this window when the agent says it is done.")]
    path = directory / f"{name}.command"
    temporary = path.with_suffix(".tmp")
    temporary.write_text("\n".join(lines) + "\n", encoding="utf-8")
    os.chmod(temporary, 0o700)
    os.replace(temporary, path)
    return path


class TerminalLauncher:
    def __init__(self, directory: Path, *, opener: Opener = macos_open) -> None:
        self.directory = directory
        self._opener = opener

    async def open(self, name: str, title: str, argv: Sequence[str], env: Mapping[str, str]) -> Path:
        script = write_script(self.directory, name, title, argv, env)
        await self._opener(["/usr/bin/open", "-a", "Terminal", str(script)])
        return script
