"""Which agent runs are waiting for the user right now, and for how long they waited.

While a run waits for a permission or an answer, its overall answer deadline stands
still (Codex ``RUN_TIMEOUT_S``): an engine adds :meth:`RunWaits.paused_s` to its
deadline and never times out while :meth:`RunWaits.waiting` is true.
"""
from __future__ import annotations

import threading
import time
from collections.abc import Callable
from dataclasses import dataclass


@dataclass
class _Wait:
    open: int = 0
    since: float = 0.0
    total: float = 0.0


class RunWaits:
    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._runs: dict[str, _Wait] = {}
        self._lock = threading.Lock()

    def begin(self, run_id: str) -> None:
        with self._lock:
            wait = self._runs.setdefault(run_id, _Wait())
            if wait.open == 0:
                wait.since = self._clock()
            wait.open += 1

    def end(self, run_id: str) -> None:
        with self._lock:
            wait = self._runs.get(run_id)
            if wait is None or wait.open == 0:
                return
            wait.open -= 1
            if wait.open == 0:
                wait.total += self._clock() - wait.since

    def waiting(self, run_id: str) -> bool:
        with self._lock:
            wait = self._runs.get(run_id)
            return wait is not None and wait.open > 0

    def paused_s(self, run_id: str) -> float:
        """Seconds this run spent waiting for the user so far (the current wait included)."""
        with self._lock:
            wait = self._runs.get(run_id)
            if wait is None:
                return 0.0
            return wait.total + (self._clock() - wait.since if wait.open else 0.0)

    def forget(self, run_id: str) -> None:
        with self._lock:
            self._runs.pop(run_id, None)
