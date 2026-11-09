"""Research boundary; B3 implements it. Importing this module never loads the API package."""

from __future__ import annotations

from collections.abc import Sequence
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from ..api.schemas_explore_common import KbContinue
    from ..api.schemas_research import (
        KbExploreRead,
        KbExploreSnapshot,
        KbResearchCreate,
        KbResearchDecide,
        KbResearchGrant,
        KbResearchPermission,
        KbResearchTask,
        KbResearchTasks,
        KbResearchToolResult,
    )
    from ..permissions.store import RunRef


class ResearchService(Protocol):
    async def create(self, body: KbResearchCreate) -> KbResearchTask: ...
    async def tasks(self, cursor: str | None = None, limit: int = 30) -> KbResearchTasks: ...
    async def task(self, task_id: str) -> KbResearchTask: ...
    async def pause(self, task_id: str) -> KbResearchTask: ...
    async def resume(self, task_id: str, body: KbContinue) -> KbResearchTask: ...
    async def cancel(self, task_id: str) -> KbResearchTask: ...
    async def decide(self, request_id: str, body: KbResearchDecide) -> KbResearchPermission: ...
    async def grant(self, chat_id: str) -> KbResearchGrant: ...
    async def revoke_grant(self, chat_id: str) -> KbResearchGrant: ...
    async def read(self, body: KbExploreRead) -> KbExploreSnapshot: ...
    async def start_tool(self, run: RunRef, body: KbResearchCreate) -> KbResearchToolResult:
        """``skaz_research_start``: records the card and waits without a timeout (``WebSearchBroker``)."""
        ...
    def recover(self) -> Sequence[str]:
        """After a restart nothing waits any more: cancels pending cards; returns their ids."""
        ...
