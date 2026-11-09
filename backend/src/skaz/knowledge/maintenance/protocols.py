"""Weekly-check boundaries; B6 implements both. Importing this module never loads the API package."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import TYPE_CHECKING, Final, Protocol

if TYPE_CHECKING:
    from ..api.schemas_explore_common import KbContinue
    from ..api.schemas_maintenance import (
        KbFreshnessAction,
        KbFreshnessActionResult,
        KbFreshnessMarks,
        KbWeeklyCheck,
        KbWeeklySettings,
        KbWeeklySettingsUpdate,
    )

#: Decision 3f′, word for word.
WEEKLY_CHECK_STARTED_BODY: Final = "SKAZ works in the tray; Quit pauses the check, it resumes next launch"
#: ``notifications.kind`` values of this release; buttons are registered in ``NotificationActions``.
CHECK_NOTIFICATION_KINDS: Final = (
    "explore_finished", "research_finished", "weekly_check_started", "weekly_check_finished",
)


class MaintenanceService(Protocol):
    async def settings(self) -> KbWeeklySettings: ...
    async def update_settings(self, body: KbWeeklySettingsUpdate) -> KbWeeklySettings: ...
    async def start(self) -> KbWeeklyCheck: ...
    async def check(self, check_id: str) -> KbWeeklyCheck: ...
    async def pause(self, check_id: str) -> KbWeeklyCheck: ...
    async def resume(self, check_id: str, body: KbContinue) -> KbWeeklyCheck: ...
    async def marks(self, material_id: str) -> KbFreshnessMarks: ...
    async def page_marks(self, page_id: str) -> KbFreshnessMarks: ...
    async def act(self, mark_id: str, body: KbFreshnessAction) -> KbFreshnessActionResult: ...


class FreshnessMarkReader(Protocol):
    """B4 fills ``KbAreaMaterial.freshness_mark_ids`` from this. Blocking; callers use ``disk_call``."""

    def mark_ids(self, material_ids: Sequence[str]) -> Mapping[str, Sequence[str]]: ...


class FreshnessMarkWriter(Protocol):
    """B5's Check links records its verdict here; ``freshness_marks`` stays B6's table. Blocking."""

    def link_gone(self, material_id: str, evidence_url: str) -> str:
        """Only after a gone answer was confirmed a day later. Idempotent; returns the mark id."""
        ...
    def link_back(self, material_id: str) -> None:
        """The link answers again: the ``link_gone`` mark goes, unless the user chose Keep."""
        ...


class WeeklyScheduler(Protocol):
    """Runs on the backend. Science bases and the wiki only, never a source's own site."""

    async def on_start(self) -> None:
        """A missed week runs now with free steps only; a check paused by Quit resumes."""
        ...
