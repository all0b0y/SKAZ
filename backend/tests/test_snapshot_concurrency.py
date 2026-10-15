"""SQLite concurrency boundary: a pinned reader must not stop recording writes."""
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from skaz import repository as repo
from skaz.db import Database


def write_segment(db: Database, session_id: str, text: str) -> None:
    """A recording's commit: replace the session's one segment."""
    with db.write() as connection:
        connection.execute("DELETE FROM segments WHERE session_id = ?", (session_id,))
        connection.execute(
            "INSERT INTO segments(id, session_id, sequence, start_ms, end_ms, text, created_at)"
            " VALUES (?, ?, 0, 0, 1000, ?, 'now')",
            (f"{session_id}-{text}", session_id, text),
        )


def test_pinned_read_allows_recording_commits_and_keeps_one_revision(tmp_path: Path) -> None:
    db = Database(tmp_path / "live.sqlite")
    try:
        sid = repo.create_session(db, "Live").id
        write_segment(db, sid, "Before.")
        with ThreadPoolExecutor(max_workers=1) as worker:
            with db.write() as connection:
                connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            with db.snapshot_read() as source:
                result = worker.submit(write_segment, db, sid, "After.")
                result.result(timeout=2)
                # First access to segments is AFTER the write: pinning must happen at entry.
                assert source.execute("SELECT text FROM segments").fetchone()[0] == "Before."
                with pytest.raises(sqlite3.OperationalError, match="readonly"):
                    source.execute("DELETE FROM segments")
                with db.write() as connection:
                    _, frames, reclaimed = connection.execute("PRAGMA wal_checkpoint(PASSIVE)").fetchone()
                    assert frames > reclaimed  # Pinned reader prevents reclaim, not writer commits.
            with db.write() as connection:
                assert tuple(connection.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()) == (0, 0, 0)
            with db.snapshot_read() as fresh:
                assert fresh.execute("SELECT text FROM segments").fetchone()[0] == "After."
    finally:
        db.close()


def test_pinned_read_refuses_uncommitted_caller_transaction(tmp_path: Path) -> None:
    db = Database(tmp_path / "transaction.sqlite")
    try:
        with db.write() as source:
            source.execute("UPDATE sessions SET title='uncommitted'")
            with pytest.raises(ValueError, match="transaction"), db.snapshot_read():
                pytest.fail("Must not silently snapshot an older committed revision")
    finally:
        db.close()
