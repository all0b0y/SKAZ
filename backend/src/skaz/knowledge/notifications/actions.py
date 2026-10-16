"""Actions on notifications that need a decision (API-B2 §1.1).

Each area registers the actions of its own notification kinds; the
``/kb/notifications/{id}/resolve`` route (W2) looks them up here. A handler
does the work (restore, retry, keep both…) and raises ``KnowledgeError`` with
a plain reason when it cannot; marking the notification resolved is the
route's job, after the handler succeeded.
"""
from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ..service import KnowledgeService
    from ..store.records import NotificationRecord


@dataclass(frozen=True)
class ActionSpec:
    """One button of a notification; ``needs_text`` asks the user for text (own note, fixed URL)."""

    id: str
    label: str
    primary: bool = False
    needs_text: bool = False


#: ``handler(kb, notification, action_id, text)``; ``text`` is set only for ``needs_text`` actions.
ActionHandler = Callable[["KnowledgeService", "NotificationRecord", str, "str | None"], Awaitable[None]]
#: The buttons for one notification (labels may depend on its payload, e.g. material titles).
ActionsFor = Callable[["NotificationRecord"], Sequence[ActionSpec]]


@dataclass(frozen=True)
class _Registered:
    actions: ActionsFor
    handler: ActionHandler


class NotificationActions:
    """Registry: notification kind → its buttons and the code that carries them out."""

    def __init__(self) -> None:
        self._kinds: dict[str, _Registered] = {}

    def register(self, kind: str, actions: ActionsFor, handler: ActionHandler) -> None:
        if kind in self._kinds:
            raise ValueError(f"Actions for {kind!r} are already registered.")
        self._kinds[kind] = _Registered(actions, handler)

    def actions(self, notification: NotificationRecord) -> Sequence[ActionSpec]:
        registered = self._kinds.get(notification.kind)
        return tuple(registered.actions(notification)) if registered else ()

    def handler(self, kind: str) -> ActionHandler | None:
        registered = self._kinds.get(kind)
        return registered.handler if registered else None

    @property
    def kinds(self) -> Mapping[str, object]:
        return dict(self._kinds)
