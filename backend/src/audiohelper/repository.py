"""SQLite persistence for sessions, chunks, segments, messages and notes."""

from __future__ import annotations

import json
import sqlite3
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

from .db import Database
from .schemas import Citation, Message, Note, Segment, Session, SessionStatus

CHUNK_PENDING = "pending"
CHUNK_DONE = "done"
CHUNK_FAILED = "failed"


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds")


def _new_id() -> str:
    return uuid.uuid4().hex


@dataclass(frozen=True)
class ChunkRecord:
    session_id: str
    sequence: int
    start_ms: int
    end_ms: int
    sha256: str
    path: str
    status: str
    error: str | None


# --- sessions ---------------------------------------------------------------


def create_session(db: Database, title: str) -> Session:
    session = Session(id=_new_id(), title=title, created_at=_now(), status="recording", duration_ms=0)
    with db.write() as connection:
        connection.execute(
            "INSERT INTO sessions(id, title, created_at, status, duration_ms) VALUES (?, ?, ?, ?, ?)",
            (session.id, session.title, session.created_at, session.status, session.duration_ms),
        )
    return session


def list_sessions(db: Database) -> list[Session]:
    with db.read() as connection:
        rows = connection.execute("SELECT * FROM sessions ORDER BY created_at DESC, rowid DESC").fetchall()
    return [_session(row) for row in rows]


def get_session(db: Database, session_id: str) -> Session | None:
    with db.read() as connection:
        row = connection.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
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


def extend_duration(db: Database, session_id: str, end_ms: int) -> None:
    with db.write() as connection:
        connection.execute(
            "UPDATE sessions SET duration_ms = MAX(duration_ms, ?) WHERE id = ?", (end_ms, session_id)
        )


def _session(row: sqlite3.Row) -> Session:
    return Session(
        id=row["id"],
        title=row["title"],
        created_at=row["created_at"],
        status=row["status"],
        duration_ms=row["duration_ms"],
    )


# --- chunks -----------------------------------------------------------------


def get_chunk(db: Database, session_id: str, sequence: int) -> ChunkRecord | None:
    with db.read() as connection:
        row = connection.execute(
            "SELECT * FROM chunks WHERE session_id = ? AND sequence = ?", (session_id, sequence)
        ).fetchone()
    if row is None:
        return None
    return ChunkRecord(
        session_id=row["session_id"],
        sequence=row["sequence"],
        start_ms=row["start_ms"],
        end_ms=row["end_ms"],
        sha256=row["sha256"],
        path=row["path"],
        status=row["status"],
        error=row["error"],
    )


def insert_chunk(db: Database, chunk: ChunkRecord) -> bool:
    """Claim ``(session_id, sequence)``. False when another request claimed it first.

    Atomic so two concurrent uploads of the same sequence cannot both believe they
    own the slot and overwrite each other's stored audio.
    """
    with db.write() as connection:
        cursor = connection.execute(
            """
            INSERT INTO chunks(
                session_id, sequence, start_ms, end_ms, sha256, path, status, error, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_id, sequence) DO NOTHING
            """,
            (
                chunk.session_id,
                chunk.sequence,
                chunk.start_ms,
                chunk.end_ms,
                chunk.sha256,
                chunk.path,
                chunk.status,
                chunk.error,
                _now(),
            ),
        )
        return cursor.rowcount > 0


def set_chunk_status(db: Database, session_id: str, sequence: int, status: str, error: str | None) -> None:
    with db.write() as connection:
        connection.execute(
            "UPDATE chunks SET status = ?, error = ? WHERE session_id = ? AND sequence = ?",
            (status, error, session_id, sequence),
        )


def unfinished_chunks(db: Database, session_id: str) -> list[ChunkRecord]:
    """Chunks whose audio is stored but whose transcript is missing, oldest first."""
    with db.read() as connection:
        rows = connection.execute(
            "SELECT sequence FROM chunks WHERE session_id = ? AND status != ? ORDER BY sequence",
            (session_id, CHUNK_DONE),
        ).fetchall()
    records = [get_chunk(db, session_id, row["sequence"]) for row in rows]
    return [record for record in records if record is not None]


# --- segments ---------------------------------------------------------------


def replace_chunk_segments(
    db: Database, session_id: str, sequence: int, segments: list[Segment]
) -> list[Segment]:
    with db.write() as connection:
        stale = connection.execute(
            "SELECT id FROM segments WHERE session_id = ? AND sequence = ?", (session_id, sequence)
        ).fetchall()
        for row in stale:
            connection.execute("DELETE FROM segments_fts WHERE segment_id = ?", (row["id"],))
        connection.execute(
            "DELETE FROM segments WHERE session_id = ? AND sequence = ?", (session_id, sequence)
        )
        created_at = _now()
        for segment in segments:
            connection.execute(
                """
                INSERT INTO segments(id, session_id, sequence, start_ms, end_ms, text, language, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    segment.id,
                    session_id,
                    sequence,
                    segment.start_ms,
                    segment.end_ms,
                    segment.text,
                    segment.language,
                    created_at,
                ),
            )
            connection.execute(
                "INSERT INTO segments_fts(segment_id, session_id, text) VALUES (?, ?, ?)",
                (segment.id, session_id, segment.text),
            )
    return segments


def list_segments(db: Database, session_id: str) -> list[Segment]:
    with db.read() as connection:
        rows = connection.execute(
            "SELECT * FROM segments WHERE session_id = ? ORDER BY start_ms, sequence", (session_id,)
        ).fetchall()
    return [_segment(row) for row in rows]


def segments_in_range(db: Database, session_id: str, start_ms: int, end_ms: int) -> list[Segment]:
    """Segments overlapping [start_ms, end_ms]."""
    with db.read() as connection:
        rows = connection.execute(
            """
            SELECT * FROM segments
            WHERE session_id = ? AND end_ms > ? AND start_ms < ?
            ORDER BY start_ms, sequence
            """,
            (session_id, start_ms, end_ms),
        ).fetchall()
    return [_segment(row) for row in rows]


def segments_for_chunk(db: Database, session_id: str, sequence: int) -> list[Segment]:
    with db.read() as connection:
        rows = connection.execute(
            "SELECT * FROM segments WHERE session_id = ? AND sequence = ? ORDER BY start_ms",
            (session_id, sequence),
        ).fetchall()
    return [_segment(row) for row in rows]


def search_segments(db: Database, session_id: str, query: str, limit: int = 40) -> list[Segment]:
    """Full-text search inside one session; returns matches in timeline order."""
    if not query.strip():
        return []
    with db.read() as connection:
        try:
            rows = connection.execute(
                """
                SELECT s.* FROM segments_fts f
                JOIN segments s ON s.id = f.segment_id
                WHERE f.session_id = ? AND segments_fts MATCH ?
                ORDER BY s.start_ms LIMIT ?
                """,
                (session_id, query, limit),
            ).fetchall()
        except sqlite3.OperationalError:
            return []  # malformed FTS expression: caller falls back to another scope
    return [_segment(row) for row in rows]


def latest_segment_end(db: Database, session_id: str) -> int:
    with db.read() as connection:
        row = connection.execute(
            "SELECT MAX(end_ms) AS watermark FROM segments WHERE session_id = ?", (session_id,)
        ).fetchone()
    return int(row["watermark"] or 0)


def _segment(row: sqlite3.Row) -> Segment:
    return Segment(
        id=row["id"],
        start_ms=row["start_ms"],
        end_ms=row["end_ms"],
        text=row["text"],
        language=row["language"],
    )


def new_segment(start_ms: int, end_ms: int, text: str, language: str | None) -> Segment:
    return Segment(id=_new_id(), start_ms=start_ms, end_ms=end_ms, text=text, language=language)


# --- messages and notes -----------------------------------------------------


def add_message(db: Database, session_id: str, role: str, content: str, citations: list[Citation]) -> Message:
    message = Message(
        id=_new_id(),
        role=role,  # type: ignore[arg-type]
        content=content,
        created_at=_now(),
        citations=citations,
    )
    with db.write() as connection:
        connection.execute(
            "INSERT INTO messages(id, session_id, role, content, created_at, citations)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (
                message.id,
                session_id,
                message.role,
                message.content,
                message.created_at,
                json.dumps([c.model_dump() for c in citations], ensure_ascii=False),
            ),
        )
    return message


def list_messages(db: Database, session_id: str) -> list[Message]:
    with db.read() as connection:
        rows = connection.execute(
            "SELECT * FROM messages WHERE session_id = ? ORDER BY created_at, rowid", (session_id,)
        ).fetchall()
    return [
        Message(
            id=row["id"],
            role=row["role"],
            content=row["content"],
            created_at=row["created_at"],
            citations=[Citation.model_validate(item) for item in json.loads(row["citations"])],
        )
        for row in rows
    ]


def add_note(db: Database, session_id: str, content: str, model: str, citations: list[Citation]) -> Note:
    note = Note(content=content, created_at=_now(), model=model, citations=citations)
    with db.write() as connection:
        connection.execute(
            "INSERT INTO notes(id, session_id, content, created_at, model, citations)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (
                _new_id(),
                session_id,
                note.content,
                note.created_at,
                note.model,
                json.dumps([c.model_dump() for c in citations], ensure_ascii=False),
            ),
        )
    return note


def latest_note(db: Database, session_id: str) -> Note | None:
    with db.read() as connection:
        row = connection.execute(
            "SELECT * FROM notes WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
            (session_id,),
        ).fetchone()
    if row is None:
        return None
    return Note(
        content=row["content"],
        created_at=row["created_at"],
        model=row["model"],
        citations=[Citation.model_validate(item) for item in json.loads(row["citations"])],
    )
