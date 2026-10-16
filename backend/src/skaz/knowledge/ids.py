"""Identifiers and timestamps for knowledge objects."""
from __future__ import annotations

from datetime import UTC, datetime
from uuid import uuid4


def new_id(prefix: str) -> str:
    """``<prefix>-<12 hex>``: short enough for markers, collision-safe for one library."""
    return f"{prefix}-{uuid4().hex[:12]}"


def utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def utc_now_ms() -> str:
    """``utc_now`` with milliseconds: orders objects created within the same second (QA E7)."""
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
