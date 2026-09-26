"""Bounded RAM-only PCM replay and the live retry budget. No provider or disk I/O."""
from __future__ import annotations

from collections import deque

OPEN_TIMEOUT_S = 5.0
STABLE_RESET_S = 30.0
RETRY_DELAYS = (0.0, 2.0, 5.0)
BUFFER_SECONDS = 30


class RecoveryBudget:
    def __init__(self) -> None:
        self.attempt = 0
        self.stable_since: float | None = None

    def next_delay(self) -> float:
        if self.attempt >= len(RETRY_DELAYS):
            raise TimeoutError("Soniox connection failed after three attempts.")
        delay = RETRY_DELAYS[self.attempt]
        self.attempt += 1
        return delay

    def connected(self, now: float) -> None:
        self.stable_since = now

    def disconnected(self, now: float) -> None:
        if self.stable_since is not None and now - self.stable_since >= STABLE_RESET_S:
            self.attempt = 0
        self.stable_since = None


class ReplayBuffer:
    """Sample-indexed mono PCM16; compact slabs bound object count as well as bytes."""
    def __init__(self, sample_rate: int, start_sample: int = 0) -> None:
        self.start = self.end = start_sample
        self._limit = sample_rate * 2 * BUFFER_SECONDS
        self._parts: deque[bytearray] = deque()
        self._size = 0

    @property
    def size_bytes(self) -> int:
        return self._size

    def append(self, pcm: bytes) -> None:
        if len(pcm) % 2:
            raise ValueError("PCM16 requires whole samples")
        if self._size + len(pcm) > self._limit:
            raise BufferError("Unconfirmed audio reached the 30-second memory limit.")
        remaining = memoryview(pcm)
        while remaining:
            if not self._parts or len(self._parts[-1]) == 8192:
                self._parts.append(bytearray())
            count = min(8192 - len(self._parts[-1]), len(remaining))
            self._parts[-1].extend(remaining[:count])
            remaining = remaining[count:]
        self._size += len(pcm)
        self.end += len(pcm) // 2

    def confirm(self, through: int) -> None:
        if not self.start <= through <= self.end:
            raise ValueError("Confirmation outside retained audio")
        remove = (through - self.start) * 2
        self._size -= remove
        self.start = through
        while remove:
            part = self._parts[0]
            count = min(remove, len(part))
            del part[:count]
            remove -= count
            if not part:
                self._parts.popleft()

    def read(self, start: int, max_bytes: int = 8192) -> bytes:
        if not self.start <= start <= self.end:
            raise ValueError("Replay outside retained audio")
        skip = (start - self.start) * 2
        for part in self._parts:
            if skip >= len(part):
                skip -= len(part)
            else:
                return bytes(part[skip:skip + max_bytes])
        return b""

    def clear(self) -> None:
        self._parts.clear()
        self._size = 0
        self.start = self.end
