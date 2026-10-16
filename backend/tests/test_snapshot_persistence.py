"""Durable snapshot boundary: real SQLite, no provider calls."""
import os
import sqlite3
from pathlib import Path
from threading import Event

import pytest

from skaz import repository as repo
from skaz.agent.transcript_snapshot import TranscriptSnapshot
from skaz.db import Database
from skaz.schemas import Segment


def test_saved_snapshot_reopens_without_source_and_preserves_citations(tmp_path: Path) -> None:
    db = Database(tmp_path / "source.sqlite")
    sid = repo.create_session(db, "Authored fixture").id
    empty = repo.create_session(db, "Empty").id
    repo.replace_chunk_segments(db, sid, 0, [
        Segment(id="first", start_ms=100, end_ms=900, text="Original evidence."),
    ])
    path = tmp_path / "snapshot.sqlite"
    try:
        with TranscriptSnapshot.capture(db, (sid, empty)) as snapshot:
            expected = snapshot.read(sid)
            snapshot.save(path)
    finally:
        db.close()
    with TranscriptSnapshot.open(path) as restored:
        assert restored.read(sid) == expected
        assert restored.read(empty)["blocks"] == []
        with pytest.raises(ValueError, match="outside scope"):
            restored.read("other-session")
    assert path.exists(), "Closing a borrowed durable snapshot must not delete it"


def test_revision_is_pinned_with_text_and_legacy_snapshot_has_unknown_revision(tmp_path: Path) -> None:
    db = Database(tmp_path / "source.sqlite")
    sid = repo.create_session(db, "Authored revision").id
    repo.replace_chunk_segments(db, sid, 0, [
        Segment(id="before", start_ms=0, end_ms=1000, text="Pinned source."),
    ])
    path = tmp_path / "snapshot.sqlite"

    def write_after_pin() -> None:
        repo.replace_chunk_segments(db, sid, 0, [
            Segment(id="after", start_ms=0, end_ms=1000, text="Changed after pin."),
        ])

    try:
        with TranscriptSnapshot.capture(db, (sid,), on_pinned=write_after_pin) as snapshot:
            assert snapshot.read(sid)["source_revision"] == 1
            assert snapshot.read(sid)["blocks"][0]["text"].strip() == "Pinned source."
            snapshot.save(path)
        with TranscriptSnapshot.open(path) as snapshot:
            assert snapshot.read(sid)["source_revision"] == 1
        # Previously published v1 snapshots contain no revision: never guess from current state.
        with sqlite3.connect(path) as c:
            c.execute("ALTER TABLE metadata DROP COLUMN source_revisions")
            c.execute("UPDATE metadata SET version=1")
        with TranscriptSnapshot.open(path) as snapshot:
            assert snapshot.read(sid)["source_revision"] is None
            assert snapshot.read(sid)["blocks"][0]["text"].strip() == "Pinned source."
    finally:
        db.close()


@pytest.mark.parametrize("revisions", ['{}', '[]', '{"wrong":1}', '{"SID":true}', '{"SID":-1}'])
def test_snapshot_rejects_invalid_revision_metadata(tmp_path: Path, revisions: str) -> None:
    db = Database(tmp_path / "source.sqlite")
    sid = repo.create_session(db, "Fixture").id
    path = tmp_path / "snapshot.sqlite"
    try:
        with TranscriptSnapshot.capture(db, (sid,)) as snapshot:
            snapshot.save(path)
        with sqlite3.connect(path) as c:
            c.execute("UPDATE metadata SET source_revisions=?", (revisions.replace("SID", sid),))
        with pytest.raises(ValueError, match="source revisions"):
            TranscriptSnapshot.open(path)
    finally:
        db.close()


def test_snapshot_save_never_overwrites_and_cancel_leaves_no_file(tmp_path: Path) -> None:
    db = Database(tmp_path / "source.sqlite")
    try:
        sid = repo.create_session(db, "Fixture").id
        with TranscriptSnapshot.capture(db, (sid,)) as snapshot:
            existing = tmp_path / "existing"
            existing.write_bytes(b"unrelated")
            with pytest.raises(FileExistsError):
                snapshot.save(existing)
            assert existing.read_bytes() == b"unrelated"
            cancel = Event()
            cancel.set()
            with pytest.raises(InterruptedError):
                snapshot.save(tmp_path / "cancelled.sqlite", cancel=cancel)
            assert not (tmp_path / "cancelled.sqlite").exists()
    finally:
        db.close()
    assert not list(tmp_path.glob(".snapshot-*"))


@pytest.mark.parametrize("fault", ["cancel", "disk_full", "directory_sync"])
def test_failed_publication_cleans_staging_and_never_returns_partial_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, fault: str,
) -> None:
    db = Database(tmp_path / "source.sqlite")
    cancel = Event()
    fsync = os.fsync
    calls = 0

    def failing_sync(fd: int) -> None:
        nonlocal calls
        calls += 1
        if fault == "disk_full" or (fault == "directory_sync" and calls == 2):
            raise OSError("Authored disk failure")
        fsync(fd)
        if fault == "cancel":
            cancel.set()

    try:
        sid = repo.create_session(db, "Fixture").id
        with TranscriptSnapshot.capture(db, (sid,)) as snapshot:
            with monkeypatch.context() as patcher:
                patcher.setattr(os, "fsync", failing_sync)
                expected = InterruptedError if fault == "cancel" else OSError
                with pytest.raises(expected):
                    snapshot.save(tmp_path / "result.sqlite", cancel=cancel)
            assert not (tmp_path / "result.sqlite").exists()
            assert not list(tmp_path.glob(".snapshot-*"))
            snapshot.save(tmp_path / "retry.sqlite")
            with TranscriptSnapshot.open(tmp_path / "retry.sqlite") as restored:
                assert restored.id == snapshot.id
    finally:
        db.close()
