"""``/kb/notifications``: the feed (long poll by ``seq``), read marks, decisions (API-B2 §1.1)."""

from __future__ import annotations

from typing import Annotated, cast

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response

from ..errors import KnowledgeError
from ..notifications.actions import NotificationActions
from ..notifications.feed import MAX_WAIT_S, NotificationFeed
from ..store.records import NotificationRecord
from .deps import KbDep, kb_call
from .schemas import KbNotification, KbNotificationAction, KbSubjectRef
from .schemas_wiki2 import KbNotificationFeed, KbNotificationsRead, KbResolve

router = APIRouter(prefix="/kb/notifications", tags=["kb"])


def get_feed(request: Request) -> NotificationFeed:
    return cast(NotificationFeed, request.app.state.runtime.kb_wiki.feed)


FeedDep = Annotated[NotificationFeed, Depends(get_feed)]


def notification_view(record: NotificationRecord, actions: NotificationActions) -> KbNotification:
    subject = None
    raw = record.subject or {}
    if raw.get("type") in ("material", "page", "chat") and raw.get("id"):
        seg = raw.get("seg")
        block_id = raw.get("block_id")
        subject = KbSubjectRef(
            type=raw["type"],
            id=str(raw["id"]),
            block_id=block_id if isinstance(block_id, str) else None,
            seg=seg if isinstance(seg, int) else None,
        )
    return KbNotification(
        id=record.id,
        kind=record.kind,
        title=record.title,
        body=record.body,
        payload=record.payload,
        requires_action=record.requires_action,
        created_at=record.created_at,
        dismissed_at=record.dismissed_at,
        seq=record.seq,
        actions=[
            KbNotificationAction(
                id=spec.id, label=spec.label, primary=spec.primary, needs_text=spec.needs_text
            )
            for spec in actions.actions(record)
        ],
        subject=subject,
        resolved_at=record.resolved_at,
        resolution=record.resolution,
    )


@router.get("")
async def list_notifications(
    feed: FeedDep,
    include_dismissed: bool = False,
    after: Annotated[int | None, Query(ge=0)] = None,
    wait: Annotated[float, Query(ge=0, le=MAX_WAIT_S)] = 0,
) -> KbNotificationFeed:
    """Newest first. With ``after``: only what was created or changed since that cursor (dismissed ones
    included, so the UI can drop them), waiting up to ``wait`` seconds for a change."""
    result = await feed.read(include_dismissed=include_dismissed, after=after, wait=wait)
    actions = feed.actions
    return KbNotificationFeed(
        items=[notification_view(record, actions) for record in result.items],
        cursor=result.cursor,
        unread=result.unread,
        requires_action=result.requires_action,
    )


@router.post("/read", status_code=204)
async def mark_read(body: KbNotificationsRead, feed: FeedDep) -> Response:
    """Everything up to ``up_to_seq`` is read (the bell counter)."""
    await kb_call(feed.mark_read, body.up_to_seq)
    return Response(status_code=204)


@router.post("/{notification_id}/resolve")
async def resolve_notification(notification_id: str, body: KbResolve, feed: FeedDep) -> KbNotification:
    """Carry out one action; 409 when already resolved, 422 for an action this notification doesn't offer."""
    try:
        record = await feed.resolve(notification_id, body.action, body.text)
    except KnowledgeError as error:
        raise HTTPException(status_code=error.status_code, detail=error.message) from error
    return notification_view(record, feed.actions)


@router.post("/{notification_id}/dismiss")
async def dismiss_notification(notification_id: str, kb: KbDep) -> KbNotification:
    return notification_view(await kb_call(kb.dismiss_notification, notification_id), kb.notification_actions)
