"""Metadata for a completed user command in Study."""
from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Literal

StudyAction = Literal["attempt", "skip", "repeat"]


@dataclass(frozen=True)
class StudyActivity:
    block_id: str
    source_ref: str
    session_id: str
    item_id: str
    occurred_at: str
    kind: StudyAction


StudyObserver = Callable[[StudyActivity], Awaitable[None]]
CaptureStudyActivity = Callable[[], Awaitable[StudyObserver | None]]
