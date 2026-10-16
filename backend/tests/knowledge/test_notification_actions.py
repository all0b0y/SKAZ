"""The notification action registry shared by the areas (API-B2 §1.1)."""
from __future__ import annotations

from typing import Any

import pytest

from skaz.knowledge.notifications.actions import ActionSpec, NotificationActions
from skaz.knowledge.store.records import NotificationRecord


def record(kind: str, payload: dict[str, Any] | None = None) -> NotificationRecord:
    return NotificationRecord("n-1", kind, "Title", "", payload or {}, True, "2026-10-15T00:00:00Z", None)


async def test_a_kind_gets_its_buttons_and_handler_and_unknown_kinds_get_none() -> None:
    calls: list[tuple[str, str | None]] = []

    async def handle(kb: Any, notification: NotificationRecord, action: str, text: str | None) -> None:
        calls.append((action, text))

    registry = NotificationActions()
    registry.register(
        "link_failed",
        lambda n: (ActionSpec("retry", "Retry", primary=True),
                   ActionSpec("fix_url", "Fix address", needs_text=True)),
        handle,
    )
    assert [a.id for a in registry.actions(record("link_failed"))] == ["retry", "fix_url"]
    assert registry.actions(record("material_ready")) == ()
    assert registry.handler("material_ready") is None
    handler = registry.handler("link_failed")
    assert handler is not None
    await handler(None, record("link_failed"), "fix_url", "https://example.org")  # type: ignore[arg-type]
    assert calls == [("fix_url", "https://example.org")]


def test_a_kind_is_registered_once() -> None:
    registry = NotificationActions()

    async def handle(*args: Any) -> None:
        return None

    registry.register("discrepancy", lambda n: (), handle)
    with pytest.raises(ValueError):
        registry.register("discrepancy", lambda n: (), handle)
