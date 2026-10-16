"""Running installer steps as child processes, line by line (replaced by a fake executor in tests)."""
from __future__ import annotations

import asyncio
import contextlib
import re
import signal
from collections.abc import AsyncIterator, Mapping, Sequence
from pathlib import Path
from typing import Protocol

from ..processes import CHILDREN
from .system import kill_group, refuse_sudo

_ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07")
MAX_LINE = 2000


def clean_line(raw: str) -> str:
    """Terminal noise out: colour codes, carriage-return progress bars (last frame kept), long lines cut."""
    text = _ANSI.sub("", raw.rstrip("\n"))
    if "\r" in text:
        text = [part for part in text.split("\r") if part.strip()][-1] if text.strip() else ""
    return text[:MAX_LINE]


class RunningStep(Protocol):
    def lines(self) -> AsyncIterator[str]: ...

    async def wait(self) -> int: ...

    async def terminate(self) -> None: ...


class Executor(Protocol):
    async def start(self, argv: Sequence[str], *, cwd: Path | None,
                    env: Mapping[str, str]) -> RunningStep: ...


class _ProcessStep:
    def __init__(self, process: asyncio.subprocess.Process) -> None:
        self.process = process

    async def lines(self) -> AsyncIterator[str]:
        assert self.process.stdout is not None
        while True:
            raw = await self.process.stdout.readline()
            if not raw:
                return
            yield raw.decode(errors="replace")

    async def wait(self) -> int:
        return await self.process.wait()

    async def terminate(self) -> None:
        if self.process.returncode is not None:
            return
        kill_group(self.process.pid, signal.SIGTERM)
        try:
            await asyncio.wait_for(self.process.wait(), 5)
        except TimeoutError:
            kill_group(self.process.pid)
            with contextlib.suppress(Exception):
                await self.process.wait()


class SubprocessExecutor:
    """stdout+stderr merged, no stdin (nothing can prompt), own process group (cancel kills children)."""

    async def start(self, argv: Sequence[str], *, cwd: Path | None, env: Mapping[str, str]) -> RunningStep:
        refuse_sudo(argv)
        process = await asyncio.create_subprocess_exec(
            *argv, cwd=str(cwd) if cwd else None, env=dict(env), start_new_session=True,
            stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            limit=1024 * 1024,
        )
        CHILDREN.add(process, group=True)  # an installer must not keep running after SKAZ quits
        return _ProcessStep(process)
