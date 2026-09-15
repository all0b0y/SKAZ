"""Bounded, installation-local technical attempts; never provider payloads."""

from __future__ import annotations

import time
from collections import deque
from contextvars import ContextVar
from threading import Lock
from typing import Any

_TOKEN_FIELDS = frozenset({"input_tokens", "output_tokens", "total_tokens"})


class ActivityLog:
    def __init__(self, capacity: int) -> None:
        if capacity < 1:
            raise ValueError("Activity log capacity must be positive.")
        self.capacity = capacity
        self._entries: deque[dict[str, Any]] = deque(maxlen=capacity)
        self._sequence = 0
        self._at_ms = 0
        self._lock = Lock()

    def append(self, record: dict[str, Any]) -> None:
        # Construct the shape explicitly: adding a gateway field cannot leak it.
        usage = record.get("usage", {})
        with self._lock:
            self._sequence += 1
            self._at_ms = max(self._at_ms, time.time_ns() // 1_000_000)
            self._entries.append({
                "sequence": self._sequence,
                "at_ms": self._at_ms,
                "operation": record["operation"],
                "provider": record["provider"],
                "model": record["model"],
                "attempt": record["attempt"],
                "elapsed_ms": record["elapsed_ms"],
                "outcome": record["outcome"],
                "status": record.get("status"),
                "retrying": record.get("retrying", False),
                "usage": {
                    key: value for key, value in usage.items()
                    if key in _TOKEN_FIELDS and type(value) is int and value >= 0
                } if isinstance(usage, dict) else {},
            })

    def snapshot(self, limit: int) -> dict[str, Any]:
        with self._lock:
            # Copy nested counters as well: callers cannot mutate stored records.
            entries = [dict(entry, usage=dict(entry["usage"])) for entry in reversed(self._entries)]
            return {
                "entries": entries[:limit],
                "capacity": self.capacity,
                "dropped": max(0, self._sequence - self.capacity),
            }


current_activity: ContextVar[ActivityLog | None] = ContextVar("current_activity", default=None)


def record_attempt(record: dict[str, Any]) -> None:
    log = current_activity.get()
    if log is not None:
        log.append(record)
