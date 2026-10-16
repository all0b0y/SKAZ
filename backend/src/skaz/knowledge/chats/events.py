"""Live change feeds with a cursor, read by long polling (no streams over the bridge).

Events are kept in memory: a delta per streamed piece of text would cost a
disk flush each if it were written to SQLite. What a message *is* lives in the
database; the feed only tells a client what changed since its cursor. A cursor
the feed cannot serve (older than what is kept, or from before a restart) gets
``None`` and the caller sends a fresh snapshot instead.
"""
from __future__ import annotations

import asyncio
import time
from collections import deque
from dataclasses import dataclass
from typing import Literal

from .model import Message, Part

EventType = Literal["message", "delta", "part", "state", "title"]
#: Cursors start at the wall clock in milliseconds: after a restart they continue above
#: anything the previous process handed out (one event per millisecond is far above any rate).
CHAT_CAPACITY = 4_000
LIST_CAPACITY = 2_000


@dataclass(frozen=True)
class ChatEvent:
    seq: int
    type: EventType
    #: ``None`` for chat-level events (``title``).
    message_id: str | None
    text: str | None = None
    part: Part | None = None
    message: Message | None = None


def start_cursor() -> int:
    return int(time.time() * 1000)


class _Feed:
    def __init__(self, start: int | None = None) -> None:
        self._cursor = start if start is not None else start_cursor()
        self._changed = asyncio.Event()

    @property
    def cursor(self) -> int:
        return self._cursor

    def _advance(self) -> int:
        self._cursor += 1
        return self._cursor

    def _notify(self) -> None:
        self._changed.set()
        self._changed = asyncio.Event()

    async def wait(self, after: int, timeout: float) -> None:
        """Return when something newer than ``after`` exists, or after ``timeout`` seconds."""
        if timeout <= 0 or self._cursor != after:
            return
        changed = self._changed
        try:
            await asyncio.wait_for(changed.wait(), timeout)
        except TimeoutError:
            return


class ChatFeed(_Feed):
    def __init__(self, start: int | None = None, capacity: int = CHAT_CAPACITY) -> None:
        super().__init__(start)
        self._events: deque[ChatEvent] = deque(maxlen=capacity)

    def emit(self, type: EventType, message_id: str | None, *, text: str | None = None,
             part: Part | None = None, message: Message | None = None) -> ChatEvent:
        event = ChatEvent(self._advance(), type, message_id, text, part, message)
        self._events.append(event)
        self._notify()
        return event

    def after(self, after: int) -> list[ChatEvent] | None:
        if after == self._cursor:
            return []
        if after > self._cursor:
            return None  # a cursor from before a restart
        oldest = self._events[0].seq if self._events else self._cursor + 1
        if after < oldest - 1:
            return None  # no longer kept (or never seen by this process)
        return [event for event in self._events if event.seq > after]


class ListFeed(_Feed):
    def __init__(self, start: int | None = None, capacity: int = LIST_CAPACITY) -> None:
        super().__init__(start)
        self._changes: deque[tuple[int, str]] = deque(maxlen=capacity)

    def touch(self, chat_id: str) -> int:
        seq = self._advance()
        self._changes.append((seq, chat_id))
        self._notify()
        return seq

    def after(self, after: int) -> list[str] | None:
        """Ids of chats changed after ``after`` (most recent change last), or ``None`` = send all."""
        if after == self._cursor:
            return []
        oldest = self._changes[0][0] if self._changes else self._cursor + 1
        if after > self._cursor or after < oldest - 1:
            return None
        return list(dict.fromkeys(chat_id for seq, chat_id in self._changes if seq > after))
