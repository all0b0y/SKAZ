"""Every long-lived child process SKAZ starts for the knowledge wiki, so quitting can stop them all.

Agent CLIs (Claude Code, Hermes ACP), their installers and quick checks run in
their own session (``start_new_session=True``) so a cancel reaches their
children; ``llama-server`` holds a ~3 GB model. None of them dies with the
backend: Electron SIGKILLs the backend after its grace period, and a child in
its own session is then simply re-parented. ``knowledge.shutdown`` signals
everything registered here first thing on shutdown.

One registry per backend process (the processes are this process's children).
A child is signalled only while it is running (``returncode is None``): an
exited leader's id may already belong to someone else.
"""
from __future__ import annotations

import contextlib
import os
import threading
from dataclasses import dataclass
from typing import Protocol


class Child(Protocol):
    """``asyncio.subprocess.Process`` or ``subprocess.Popen``."""

    @property
    def pid(self) -> int: ...
    @property
    def returncode(self) -> int | None: ...


@dataclass(frozen=True)
class _Child:
    process: Child
    #: Started with ``start_new_session=True``: signal its whole process group.
    group: bool


class ChildProcesses:
    def __init__(self) -> None:
        self._children: dict[int, _Child] = {}
        self._lock = threading.Lock()

    def add(self, process: Child, *, group: bool) -> None:
        with self._lock:
            self._prune()
            self._children[id(process)] = _Child(process, group)

    def discard(self, process: Child | None) -> None:
        if process is None:
            return
        with self._lock:
            self._children.pop(id(process), None)

    def running(self) -> list[int]:
        """Pids of the registered children that are still running."""
        with self._lock:
            self._prune()
            return [child.process.pid for child in self._children.values()]

    def signal_all(self, sig: int) -> int:
        """Send ``sig`` to every running child (its group when it has one); returns how many."""
        with self._lock:
            self._prune()
            children = list(self._children.values())
        for child in children:
            _send(child, sig)
        return len(children)

    def _prune(self) -> None:
        for key in [key for key, child in self._children.items() if child.process.returncode is not None]:
            del self._children[key]


def _send(child: _Child, sig: int) -> None:
    pid = child.process.pid
    if child.group:
        try:
            os.killpg(pid, sig)
            return
        except (ProcessLookupError, PermissionError):
            pass  # not a group leader after all: the process itself below
    with contextlib.suppress(ProcessLookupError, PermissionError):
        os.kill(pid, sig)


#: The backend's children (agents, installers, ``llama-server``).
CHILDREN = ChildProcesses()
