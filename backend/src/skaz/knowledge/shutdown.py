"""Closing the knowledge wiki within Electron's grace period, leaving no child process behind.

Electron sends SIGTERM to the backend and SIGKILL 4 s later
(``electron/backend.ts`` ``SHUTDOWN_GRACE_MS``). Closing used to be sequential
(wiki → chats, up to 10 s for one Claude answer → ingest → Codex → only then
``llama-server``), so a slow step meant SIGKILL with agent processes and
``llama-server`` still running — orphaned, since they run in their own session.

Now, in order:

1. at once, every registered child (``processes.CHILDREN``: Claude Code,
   Hermes, installers, ``llama-server``) gets SIGTERM, in parallel;
2. the services close together (answers marked interrupted, jobs stopped,
   downloads cancelled), bounded by ``DEADLINE_S`` in total;
3. whatever child is still running gets SIGKILL.

Nothing is cancelled in the middle of a library write: a wiki job saving its
pages is shielded (it finishes on its own), chat answers are saved as
interrupted before they are cancelled, and ``KnowledgeService.close`` takes the
library write lock before it closes the database. Whatever is still running at
the deadline is named in the log (job and answer ids, never text).

``DEADLINE_S`` stays well under Electron's grace, so the rest of the app's
shutdown (recordings, imports) keeps its time.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import signal
from collections.abc import Awaitable, Callable
from typing import Protocol

from .logsafe import error_note
from .processes import CHILDREN, ChildProcesses

logger = logging.getLogger(__name__)

#: Total time for closing the knowledge services; Electron's grace is 4 s (``electron/backend.ts``).
DEADLINE_S = 2.5


class _Closes(Protocol):
    def close(self) -> Awaitable[None]: ...


class _AsyncCloses(Protocol):
    def aclose(self) -> Awaitable[None]: ...


class KnowledgeRuntime(Protocol):
    @property
    def kb_wiki(self) -> _Closes: ...
    @property
    def kb_chats(self) -> _Closes: ...
    @property
    def kb_ingest(self) -> _Closes: ...
    @property
    def kb_codex(self) -> _Closes: ...
    @property
    def kb_decisions(self) -> _AsyncCloses: ...
    @property
    def kb_agents(self) -> _AsyncCloses: ...


def _still_running(runtime: KnowledgeRuntime) -> list[str]:
    """Ids of wiki jobs and chat answers that outlived the deadline (for the log; no text)."""
    found = []
    for label, service, method in (("ingest jobs", runtime.kb_ingest, "active_jobs"),
                                   ("chat answers", runtime.kb_chats, "active_runs")):
        ids = getattr(service, method, None)
        if callable(ids):
            with contextlib.suppress(Exception):
                running = sorted(ids())
                if running:
                    found.append(f"{label} {', '.join(running)}")
    return found


async def close_knowledge(runtime: KnowledgeRuntime, *, deadline_s: float = DEADLINE_S,
                          children: ChildProcesses = CHILDREN) -> None:
    """App shutdown of the knowledge wiki (``app.py`` lifespan); returns within ``deadline_s``."""
    signalled = children.signal_all(signal.SIGTERM)
    closers: list[tuple[str, Callable[[], Awaitable[None]]]] = [
        ("wiki", runtime.kb_wiki.close), ("chats", runtime.kb_chats.close),
        ("ingest", runtime.kb_ingest.close), ("codex", runtime.kb_codex.close),
        ("decisions", runtime.kb_decisions.aclose), ("agents", runtime.kb_agents.aclose),
    ]

    async def close(name: str, closer: Callable[[], Awaitable[None]]) -> None:
        try:
            await closer()
        except asyncio.CancelledError:
            raise
        except Exception as error:  # one service failing to close never keeps the others open
            logger.error("closing %s failed: %s", name, error_note(error))

    tasks = [asyncio.create_task(close(name, closer), name=f"kb-close-{name}") for name, closer in closers]
    try:
        _done, pending = await asyncio.wait(tasks, timeout=deadline_s)
        if pending:
            logger.warning("knowledge shutdown: %s did not finish within %.1f s; stopped",
                           ", ".join(sorted(task.get_name() for task in pending)), deadline_s)
            hanging = _still_running(runtime)
            if hanging:
                logger.warning("knowledge shutdown: still running: %s", "; ".join(hanging))
            for task in pending:
                task.cancel()
            await asyncio.wait(pending, timeout=0.2)
    finally:
        killed = children.signal_all(signal.SIGKILL)
        if signalled or killed:
            logger.info("knowledge shutdown: %d child process(es) signalled, %d needed SIGKILL",
                        signalled, killed)
