"""Filesystem refusal, external changes and explicit unsupported-state guards."""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from audiohelper import note_store
from audiohelper import repository as repo
from audiohelper.db import Database
from audiohelper.library_archive import ArchiveRefused, SessionArchive
from audiohelper.library_discovery import LibraryUnavailable


@pytest.mark.parametrize("kind", ["symlink", "hardlink", "directory", "fifo", "invalid-json",
                                 "duplicate-json-key", "utf8", "utf16", "future-version", "unknown-field"])
def test_marker_refusal_preserves_index_and_files(tmp_path: Path, kind: str) -> None:
    source, target = Database(":memory:"), Database(":memory:")
    try:
        session = repo.create_session(source, "Source")
        archive = SessionArchive.capture(source, session.id, note_paths={})
        directory = tmp_path / "Session"
        directory.mkdir()
        marker = directory / "session.json"
        external = tmp_path / "external.json"
        external.write_bytes(archive.marker)
        if kind == "symlink":
            marker.symlink_to(external)
        elif kind == "hardlink":
            os.link(external, marker)
        elif kind == "directory":
            marker.mkdir()
        elif kind == "fifo":
            os.mkfifo(marker)
        elif kind == "invalid-json":
            marker.write_text("{incomplete", encoding="utf-8")
        elif kind == "duplicate-json-key":
            marker.write_bytes(archive.marker.replace(b'"version":1', b'"version":1,"version":1'))
        elif kind == "utf8":
            marker.write_bytes(b"\xff")
        elif kind == "utf16":
            marker.write_bytes(archive.marker.decode("utf-8").encode("utf-16"))
        else:
            doc = json.loads(archive.marker)
            if kind == "future-version":
                doc["version"] = 2
            else:
                doc["commands"] = ["not executable"]
            marker.write_text(json.dumps(doc), encoding="utf-8")
        existing = repo.create_session(target, "Retained")
        with pytest.raises((ArchiveRefused, LibraryUnavailable)):
            SessionArchive.restore_new(target, directory)
        assert repo.list_sessions(target) == [existing]
        assert external.read_bytes() == archive.marker
        assert os.path.lexists(marker)
    finally:
        source.close()
        target.close()


@pytest.mark.parametrize("operation", ["unchanged", "deleted", "duplicate", "ambiguous", "foreign"])
def test_note_registration_rules_reach_recovered_index(tmp_path: Path, operation: str) -> None:
    source, target = Database(":memory:"), Database(":memory:")
    try:
        session = repo.create_session(source, "Source")
        note = repo.add_note(source, session.id, "Registered", "manual", [], source_revision=0)
        archive = SessionArchive.capture(source, session.id, note_paths={note.id: "Note.md"})
        directory = tmp_path / "Session"
        directory.mkdir()
        (directory / "session.json").write_bytes(archive.marker)
        path = directory / "Note.md"
        path.write_bytes(archive.notes["Note.md"])
        if operation in ("duplicate", "ambiguous"):
            (directory / "Copy.md").write_bytes(archive.notes["Note.md"] + b" changed")
        if operation == "ambiguous":
            path.rename(directory / "Another.md")
        if operation == "deleted":
            path.unlink()
        if operation == "foreign":
            (directory / "Foreign.md").write_text("Ordinary external note", encoding="utf-8")
            (directory / "Transcript.md").write_bytes(archive.notes["Note.md"] + b" not a note")
        before = {p.name: p.read_bytes() for p in directory.iterdir()}
        SessionArchive.restore_new(target, directory)
        notes = note_store.list_notes(target, session.id)
        if operation in ("deleted", "ambiguous"):
            assert notes == []
        else:
            assert len(notes) == 1
            assert notes[0].content == "Registered"
            assert notes[0].revision == 1
            assert notes[0].stale is False
        assert {p.name: p.read_bytes() for p in directory.iterdir()} == before
        with pytest.raises(ArchiveRefused):
            SessionArchive.restore_new(target, directory)
    finally:
        source.close()
        target.close()


@pytest.mark.parametrize("kind", ["retained-audio", "history", "trash", "uncommitted"])
def test_capture_refuses_unimplemented_state_instead_of_losing_it(tmp_path: Path, kind: str) -> None:
    source = Database(":memory:")
    try:
        session = repo.create_session(source, "Source")
        note = repo.add_note(source, session.id, "Original", "manual", [])
        if kind == "retained-audio":
            repo.insert_chunk(
                source, repo.ChunkRecord(session.id, 0, 0, 100, "legacy", "/legacy.wav", "done", None)
            )
        elif kind == "history":
            with source.write() as c:
                c.execute("CREATE TABLE note_history(id TEXT, note_id TEXT, snapshot TEXT, expires_at REAL)")
                c.execute("INSERT INTO note_history VALUES ('old', ?, '{}', 0)", (note.id,))
        elif kind == "trash":
            with source.write() as c:
                c.execute("ALTER TABLE notes ADD COLUMN deleted_at TEXT")
                c.execute("UPDATE notes SET deleted_at='legacy' WHERE id=?", (note.id,))
        else:
            with source.read() as connection:
                connection.execute("BEGIN")
                connection.execute("UPDATE sessions SET title='Uncommitted' WHERE id=?", (session.id,))
        with pytest.raises(ArchiveRefused):
            SessionArchive.capture(source, session.id, note_paths={note.id: "Note.md"})
        if kind == "uncommitted":
            with source.read() as connection:
                assert connection.in_transaction
                connection.rollback()
        assert repo.get_session(source, session.id) is not None
    finally:
        source.close()
