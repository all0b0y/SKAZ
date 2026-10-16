"""SQLite persistence for sessions, their segments and notes."""

from __future__ import annotations

import sqlite3
import uuid
from datetime import UTC, datetime

from .db import Database
from .schemas import (
    Segment,
    SegmentSource,
    Session,
    SessionMode,
    SessionStatus,
)


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds")


def _new_id() -> str:
    return uuid.uuid4().hex


# --- sessions ---------------------------------------------------------------


def create_session(db: Database, title: str, mode: SessionMode = "legacy") -> Session:
    session = Session(
        id=_new_id(), title=title, created_at=_now(), status="recording", duration_ms=0, mode=mode
    )
    with db.write() as connection:
        connection.execute(
            "INSERT INTO sessions(id, title, created_at, status, duration_ms, mode) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (
                session.id,
                session.title,
                session.created_at,
                session.status,
                session.duration_ms,
                session.mode,
            ),
        )
    return session


def get_session(db: Database, session_id: str) -> Session | None:
    with db.read() as connection:
        row = connection.execute(
            "SELECT sessions.*, COALESCE(n.origin, 'live') AS origin FROM sessions "
            "LEFT JOIN native_recordings n ON n.session_id=sessions.id WHERE sessions.id=?",
            (session_id,),
        ).fetchone()
    return _session(row) if row else None


def update_session(
    db: Database, session_id: str, *, status: SessionStatus | None = None, title: str | None = None
) -> Session | None:
    assignments: list[str] = []
    values: list[object] = []
    if status is not None:
        assignments.append("status = ?")
        values.append(status)
    if title is not None:
        assignments.append("title = ?")
        values.append(title)
    if assignments:
        with db.write() as connection:
            cursor = connection.execute(
                f"UPDATE sessions SET {', '.join(assignments)} WHERE id = ?", (*values, session_id)
            )
            if cursor.rowcount == 0:
                return None
    return get_session(db, session_id)


def delete_session(db: Database, session_id: str) -> bool:
    with db.write() as connection:
        connection.execute("DELETE FROM segments_fts WHERE session_id = ?", (session_id,))
        cursor = connection.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
        return cursor.rowcount > 0


def _session(row: sqlite3.Row) -> Session:
    return Session(
        id=row["id"],
        title=row["title"],
        created_at=row["created_at"],
        status=row["status"],
        duration_ms=row["duration_ms"],
        mode=row["mode"],
        origin=row["origin"],
    )


# --- live ASR draft ---------------------------------------------------------


# --- chunks -----------------------------------------------------------------


# --- segments ---------------------------------------------------------------


def list_segments(db: Database, session_id: str) -> list[Segment]:
    with db.read() as connection:
        rows = connection.execute(
            "SELECT * FROM segments WHERE session_id = ? ORDER BY start_ms, sequence", (session_id,)
        ).fetchall()
    return _segments_with_sources(db, rows)


def _segments_with_sources(db: Database, rows: list[sqlite3.Row]) -> list[Segment]:
    if not rows:
        return []
    ids = [str(row["id"]) for row in rows]
    placeholders = ",".join("?" for _ in ids)
    with db.read() as connection:
        source_rows = connection.execute(
            f"""
            SELECT segment_id, sequence, sample_start, sample_end, sha256
            FROM segment_sources WHERE segment_id IN ({placeholders})
            ORDER BY segment_id, sequence
            """,
            ids,
        ).fetchall()
    sources: dict[str, list[SegmentSource]] = {segment_id: [] for segment_id in ids}
    for source in source_rows:
        sources[str(source["segment_id"])].append(
            SegmentSource(
                sequence=source["sequence"],
                sample_start=source["sample_start"],
                sample_end=source["sample_end"],
                sha256=source["sha256"],
            )
        )
    return [_segment(row, sources[str(row["id"])]) for row in rows]


def _segment(row: sqlite3.Row, sources: list[SegmentSource] | None = None) -> Segment:
    return Segment(
        id=row["id"],
        start_ms=row["start_ms"],
        end_ms=row["end_ms"],
        text=row["text"],
        language=row["language"],
        sources=sources or [],
    )
