"""The notification feed (API-B2 §1.1): long poll by ``seq``, read marks, resolving with actions.

Notifications are added from any thread (source scans, ingest jobs); the long
poll therefore watches the database cursor instead of an in-process event. A
resolve runs the kind's handler first and records the resolution only after it
succeeded; a navigation action (``open_material``) never resolves anything —
it only tells the UI where to go, so it is valid on resolved notifications too.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING

from ...native_io import disk_call
from ..errors import KnowledgeError, NotFound
from .actions import ActionSpec, NotificationActions

if TYPE_CHECKING:
    from ..service import KnowledgeService
    from ..store.records import NotificationRecord

#: Longest wait of one long-poll request, as ``/kb/agents/install/{id}``.
MAX_WAIT_S = 25.0
POLL_INTERVAL_S = 0.2
OPEN_MATERIAL = ActionSpec("open_material", "Open material")
#: Actions that only navigate; they never mark a notification resolved.
NAVIGATION_ACTIONS = frozenset({OPEN_MATERIAL.id})
ALREADY_RESOLVED = "This notification is already resolved."


class AlreadyResolved(KnowledgeError):
    status_code = 409

    def __init__(self) -> None:
        super().__init__(ALREADY_RESOLVED)


class UnknownAction(KnowledgeError):
    status_code = 422


@dataclass(frozen=True)
class Feed:
    items: list[NotificationRecord]
    cursor: int
    unread: int
    requires_action: int


async def _noop(
    _kb: KnowledgeService, _notification: NotificationRecord, _action: str, _text: str | None
) -> None:
    return None


def register_material_kinds(actions: NotificationActions, kinds: Sequence[str]) -> None:
    """Kinds raised by other areas that only need "Open material" (S1 ``excluded_instruction``,
    W1 ``blocked_output``): their texts and payloads stay as their areas wrote them."""
    for kind in kinds:
        actions.register(kind, lambda _record: (OPEN_MATERIAL,), _noop)


class NotificationFeed:
    def __init__(self, kb: KnowledgeService) -> None:
        self.kb = kb
        self._locks: dict[str, asyncio.Lock] = {}

    @property
    def actions(self) -> NotificationActions:
        return self.kb.notification_actions

    def snapshot(self, *, include_dismissed: bool, after: int | None) -> Feed:
        repo = self.kb.notification_repo
        cursor = repo.cursor()
        items = (
            repo.list_all(include_dismissed=include_dismissed) if after is None else repo.changed_after(after)
        )
        unread, open_decisions = repo.counters()
        return Feed(items, cursor, unread, open_decisions)

    async def read(
        self, *, include_dismissed: bool = False, after: int | None = None, wait: float = 0.0
    ) -> Feed:
        """The whole feed; with ``after`` only what changed since, waiting up to ``wait`` s for a change."""
        deadline = time.monotonic() + min(max(wait, 0.0), MAX_WAIT_S)
        while after is not None and time.monotonic() < deadline:
            if await disk_call(self.kb.notification_repo.cursor) > after:
                break
            await asyncio.sleep(min(POLL_INTERVAL_S, max(deadline - time.monotonic(), 0.0)))
        return await disk_call(self.snapshot, include_dismissed=include_dismissed, after=after)

    def _record(self, notification_id: str) -> NotificationRecord:
        record = self.kb.notification_repo.get(notification_id)
        if record is None:
            raise NotFound("Notification not found.")
        return record

    async def resolve(self, notification_id: str, action: str, text: str | None) -> NotificationRecord:
        lock = self._locks.setdefault(notification_id, asyncio.Lock())
        async with lock:
            record = await disk_call(self._record, notification_id)
            specs = {spec.id: spec for spec in self.actions.actions(record)}
            spec = specs.get(action)
            if spec is None:
                raise UnknownAction("This action isn't available for this notification.")
            if spec.id in NAVIGATION_ACTIONS:
                return record
            if record.resolved_at is not None:
                raise AlreadyResolved()
            clean = (text or "").strip() or None
            if spec.needs_text and clean is None:
                raise UnknownAction("This action needs a text.")
            handler = self.actions.handler(record.kind)
            if handler is None:  # registered kinds always have one; guard against a half registration
                raise UnknownAction("This action isn't available for this notification.")
            await handler(self.kb, record, spec.id, clean if spec.needs_text else None)
            resolved = await disk_call(self.kb.notification_repo.resolve, notification_id, spec.id)
            assert resolved is not None
            if resolved.resolution != spec.id:
                raise AlreadyResolved()
            return resolved

    def mark_read(self, up_to_seq: int) -> int:
        return self.kb.notification_repo.mark_read(up_to_seq)
