"""``/kb/notifications``: the feed of events that need attention (service data, not files)."""
from __future__ import annotations

from fastapi import APIRouter

from ..store.records import NotificationRecord
from .deps import KbDep, kb_call
from .schemas import KbNotification

router = APIRouter(prefix="/kb/notifications", tags=["kb"])


def notification_view(record: NotificationRecord) -> KbNotification:
    return KbNotification(id=record.id, kind=record.kind, title=record.title, body=record.body,
                          payload=record.payload, requires_action=record.requires_action,
                          created_at=record.created_at, dismissed_at=record.dismissed_at)


@router.get("")
async def list_notifications(kb: KbDep, include_dismissed: bool = False) -> list[KbNotification]:
    records = await kb_call(kb.notifications, include_dismissed=include_dismissed)
    return [notification_view(record) for record in records]


@router.post("/{notification_id}/dismiss")
async def dismiss_notification(notification_id: str, kb: KbDep) -> KbNotification:
    return notification_view(await kb_call(kb.dismiss_notification, notification_id))
