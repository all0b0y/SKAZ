"""Session-only pin choices and exact linked frame citations for completed chat answers."""
from __future__ import annotations

import asyncio
from collections import OrderedDict
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from time import monotonic
from typing import TYPE_CHECKING

from ..knowledge.sources.visual import PreparedVisual, VisualSourceUnsupported, video_timestamp_url
from .authorization import AuthorizedVisualPayload
from .payloads import frame_timestamp, public_frame_source

if TYPE_CHECKING:
    from ..knowledge.sources.service import SourceService

FRAME_PIN_TTL_SECONDS = 120.0
MAX_PIN_CACHE_BYTES = 8 * 1024 * 1024
MAX_PIN_CACHE_FRAMES = 32


def frame_citation(visual: AuthorizedVisualPayload) -> str:
    timestamp = visual.locator.timestamp_ms
    url = visual.locator.source_url
    assert timestamp is not None and url is not None
    target = video_timestamp_url(public_frame_source(url), timestamp)
    return f"[Video frame at {frame_timestamp(timestamp)}]({target})"


def require_retainable_frame(sources: SourceService, visual: AuthorizedVisualPayload) -> PreparedVisual:
    frame = visual.linked_frame
    if frame is None or not frame.retention_permitted:
        raise VisualSourceUnsupported(
            "retention_not_permitted", "This source does not permit storing video frames.",
        )
    _, source, _ = sources.visual._require_retainable_video_link(visual.locator.material_id)
    if frame.locator.source_url != source.url:
        raise VisualSourceUnsupported("retention_not_permitted", "The linked video source has changed.")
    return frame


@dataclass(frozen=True)
class AnswerFrame:
    message_id: str
    frame_id: str
    material_id: str
    label: str
    timestamp_ms: int
    pinned: bool


@dataclass
class FrameChoice:
    library_root: Path
    message_id: str
    visual: AuthorizedVisualPayload
    expires_at: float
    pinned: bool = False

    def view(self) -> AnswerFrame:
        timestamp = self.visual.locator.timestamp_ms
        assert timestamp is not None
        return AnswerFrame(
            message_id=self.message_id, frame_id=self.visual.visual_id,
            material_id=self.visual.locator.material_id, label=self.visual.locator.label,
            timestamp_ms=timestamp, pinned=self.pinned,
        )


class FramePinCache:
    """Bounded FIFO cache confined to the chat service's event loop."""

    def __init__(self) -> None:
        self._entries: OrderedDict[tuple[str, str, str], FrameChoice] = OrderedDict()
        self._timer: asyncio.TimerHandle | None = None

    def add(
        self, library_root: Path, chat_id: str, message_id: str, visuals: Sequence[AuthorizedVisualPayload],
    ) -> None:
        expires_at = monotonic() + FRAME_PIN_TTL_SECONDS
        for visual in visuals:
            frame = visual.linked_frame
            if frame is None or not frame.retention_permitted or visual.byte_size > MAX_PIN_CACHE_BYTES:
                continue
            key = (chat_id, message_id, visual.visual_id)
            self._entries[key] = FrameChoice(library_root, message_id, visual, expires_at)
            self._entries.move_to_end(key)
        while len(self._entries) > MAX_PIN_CACHE_FRAMES or (
            sum(choice.visual.byte_size for choice in self._entries.values()) > MAX_PIN_CACHE_BYTES
        ):
            self._entries.popitem(last=False)
        self._expire()

    def for_chat(self, chat_id: str, library_root: Path) -> tuple[FrameChoice, ...]:
        self._expire()
        return tuple(
            choice for key, choice in self._entries.items()
            if key[0] == chat_id and choice.library_root == library_root
        )

    def drop_chat(self, chat_id: str) -> None:
        for key in tuple(self._entries):
            if key[0] == chat_id:
                del self._entries[key]
        self._expire()

    def close(self) -> None:
        self._entries.clear()
        if self._timer is not None:
            self._timer.cancel()
            self._timer = None

    def _expire(self) -> None:
        if self._timer is not None:
            self._timer.cancel()
            self._timer = None
        now = monotonic()
        while self._entries:
            first = next(iter(self._entries.values()))
            if first.expires_at > now:
                self._timer = asyncio.get_running_loop().call_later(first.expires_at - now, self._expire)
                return
            self._entries.popitem(last=False)
