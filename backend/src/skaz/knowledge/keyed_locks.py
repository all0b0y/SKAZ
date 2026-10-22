"""One lock per id that is forgotten once nobody holds or waits for it (L8).

``dict.setdefault(id, Lock())`` kept a lock for every message, notification and
material ever touched, for the life of the process. These keep a count of the
users of each id's lock (holding it or waiting for it) and drop the entry when
the last one leaves, so the map holds only ids that are in use right now.
"""
from __future__ import annotations

import asyncio
import contextlib
import threading
from collections.abc import AsyncIterator, Iterator


class KeyedLocks:
    """asyncio locks by id (event-loop code)."""

    def __init__(self) -> None:
        self._locks: dict[str, tuple[asyncio.Lock, int]] = {}

    def __len__(self) -> int:
        return len(self._locks)

    @contextlib.asynccontextmanager
    async def hold(self, key: str) -> AsyncIterator[None]:
        lock, users = self._locks.get(key, (asyncio.Lock(), 0))
        self._locks[key] = (lock, users + 1)
        try:
            async with lock:
                yield
        finally:
            _lock, users = self._locks[key]
            if users <= 1:
                del self._locks[key]
            else:
                self._locks[key] = (lock, users - 1)


class KeyedThreadLocks:
    """threading locks by id (worker-thread code); ``timeout`` as ``Lock.acquire``."""

    def __init__(self) -> None:
        self._locks: dict[str, tuple[threading.Lock, int]] = {}
        self._guard = threading.Lock()

    def __len__(self) -> int:
        return len(self._locks)

    @contextlib.contextmanager
    def hold(self, key: str, *, timeout: float = -1) -> Iterator[bool]:
        """Yields whether the lock was taken (False only when ``timeout`` ran out)."""
        with self._guard:
            lock, users = self._locks.get(key, (threading.Lock(), 0))
            self._locks[key] = (lock, users + 1)
        taken = lock.acquire(timeout=timeout)
        try:
            yield taken
        finally:
            if taken:
                lock.release()
            with self._guard:
                _lock, users = self._locks[key]
                if users <= 1:
                    del self._locks[key]
                else:
                    self._locks[key] = (lock, users - 1)
