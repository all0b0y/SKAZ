"""The provider-neutral live ASR session contract.

Every live provider speaks the event shape the native store already persists
(:class:`~.soniox.SonioxEvent`): a final delta, the complete replaceable partial
tail, and two audio clocks. Keeping that one shape is what lets transcript
storage, speaker numbering, translation projection, recovery and session files
stay identical whichever provider produced the words.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Protocol

from . import LiveAsrError
from .soniox import SonioxEvent

__all__ = ["LiveAsrError", "LiveAsrSession", "LiveSessionOpener"]


class LiveAsrSession(Protocol):
    """One provider session: concurrently writable (PCM) and readable (events)."""

    failure_retryable: bool

    async def send_audio(self, frame: bytes) -> None: ...

    def events(self) -> AsyncIterator[SonioxEvent]: ...

    async def finish(self) -> Any: ...

    async def aclose(self) -> None: ...


@dataclass(frozen=True)
class LiveSessionOpener:
    """How :class:`~skaz.native_stream.NativeStream` opens (and reopens) a provider.

    ``open`` is called once per connection attempt; there is never a fallback to a
    different provider. ``open_timeout_s`` differs per provider: a local model has
    to be loaded from disk, a cloud socket only has to connect.
    """

    provider: str
    label: str
    model: str
    open: Callable[[], Awaitable[LiveAsrSession]]
    #: None keeps the shared native open timeout (the Soniox socket budget).
    open_timeout_s: float | None = None
