"""Capability provenance: written only after a real successful provider call."""

from __future__ import annotations

from datetime import UTC, datetime

from .db import Database
from .schemas import Task


def record(db: Database, provider: str, model: str, task: Task, detail: str) -> None:
    """Remember that provider+model actually served ``task`` in this installation."""
    with db.write() as connection:
        connection.execute(
            """
            INSERT INTO verifications(provider, model, task, verified_at, detail)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(provider, model, task)
            DO UPDATE SET verified_at = excluded.verified_at, detail = excluded.detail
            """,
            (provider, model, task, datetime.now(UTC).isoformat(timespec="seconds"), detail),
        )


def note(db: Database, provider: str, model: str, task: Task) -> str | None:
    if not model:
        return None
    with db.read() as connection:
        row = connection.execute(
            "SELECT verified_at, detail FROM verifications WHERE provider = ? AND model = ? AND task = ?",
            (provider, model, task),
        ).fetchone()
    if row is None:
        return None
    return f"{row['detail']} (verified {row['verified_at']})"


def notes_for_task(db: Database, provider: str, task: Task) -> dict[str, str]:
    with db.read() as connection:
        rows = connection.execute(
            "SELECT model, verified_at, detail FROM verifications WHERE provider = ? AND task = ?",
            (provider, task),
        ).fetchall()
    return {row["model"]: f"{row['detail']} (verified {row['verified_at']})" for row in rows}
