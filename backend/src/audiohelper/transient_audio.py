"""Bounded process-local ASR input. Never a replay source after restart or pause."""
from __future__ import annotations

import threading
import time
from collections import OrderedDict


class TransientAudio:
    def __init__(self, *, max_bytes: int = 32 * 1024 * 1024, ttl: float = 60) -> None:
        self.max_bytes = max_bytes
        self.ttl = ttl
        self._items: OrderedDict[tuple[str, int], tuple[float, bytes]] = OrderedDict()
        self._bytes = 0
        self._lock = threading.RLock()

    def _expire(self) -> None:
        cutoff = time.monotonic() - self.ttl
        for key, (created, _) in list(self._items.items()):
            if created <= cutoff:
                self._remove(key)

    def _remove(self, key: tuple[str, int]) -> None:
        item = self._items.pop(key, None)
        if item is not None:
            self._bytes -= len(item[1])

    def put(self, session_id: str, sequence: int, data: bytes) -> None:
        if len(data) > self.max_bytes:
            raise ValueError("Audio exceeds the temporary ASR buffer limit.")
        with self._lock:
            self._expire()
            self._remove((session_id, sequence))
            while self._items and self._bytes + len(data) > self.max_bytes:
                self._remove(next(iter(self._items)))
            self._items[(session_id, sequence)] = (time.monotonic(), data)
            self._bytes += len(data)

    def get(self, session_id: str, sequence: int) -> bytes:
        with self._lock:
            self._expire()
            item = self._items.get((session_id, sequence))
            if item is None:
                raise FileNotFoundError("ASR input is no longer buffered; provide the input again.")
            return item[1]

    def discard(self, session_id: str | None = None) -> None:
        with self._lock:
            for key in list(self._items):
                if session_id is None or key[0] == session_id:
                    self._remove(key)
