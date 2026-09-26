"""SQLite transaction boundaries and real HTTP readback of recovered sessions."""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from audiohelper import note_store
from audiohelper import repository as repo
from audiohelper.app import create_app
from audiohelper.config import AppConfig
from audiohelper.db import Database
from audiohelper.library_archive import ArchiveRefused, SessionArchive
from audiohelper.secrets import MemorySecretStore
from tests.test_library_archive_validation import native_document


def test_capture_uses_one_sqlite_snapshot_across_external_commit(tmp_path: Path) -> None:
    path = tmp_path / "source.sqlite"
    source = Database(path)
    other = sqlite3.connect(path)
    try:
        session = repo.create_session(source, "Before")
        note = repo.add_note(source, session.id, "Before", "manual", [])
        fired = False

        def external_commit(statement: str) -> None:
            nonlocal fired
            if "SELECT * FROM notes" not in statement or fired:
                return
            fired = True
            other.execute("UPDATE sessions SET title='After' WHERE id=?", (session.id,))
            other.execute("UPDATE notes SET content='After' WHERE id=?", (note.id,))
            other.commit()

        with source.read() as connection:
            connection.set_trace_callback(external_commit)
        archive = SessionArchive.capture(source, session.id, note_paths={note.id: "Note.md"})
        assert fired
        assert json.loads(archive.marker)["session"]["title"] == "Before"
        assert archive.notes["Note.md"].endswith(b"Before")
        with source.read() as connection:
            connection.set_trace_callback(None)
        assert note_store.list_notes(source, session.id)[0].content == "After"
    finally:
        other.close()
        source.close()


def test_late_note_collision_rolls_back_session_messages_and_search(tmp_path: Path) -> None:
    source, target = Database(":memory:"), Database(":memory:")
    try:
        doc = native_document(source, tmp_path)
        sid = doc["session"]["id"]
        note = repo.add_note(source, sid, "Retained", "manual", [])
        repo.add_message(source, sid, "user", "Question", [])
        archive = SessionArchive.capture(source, sid, note_paths={note.id: "Note.md"})
        directory = tmp_path / "Recovery"
        directory.mkdir()
        (directory / "session.json").write_bytes(archive.marker)
        (directory / "Note.md").write_bytes(archive.notes["Note.md"])
        existing = repo.create_session(target, "Untouched")
        # Corrupt input points at an existing identity. No INSERT OR REPLACE allowed.
        with target.write() as connection:
            connection.execute(
                "INSERT INTO notes(id,session_id,content,created_at,model) VALUES (?,?,?,?,?)",
                (note.id, existing.id, "Do not overwrite", note.created_at, "manual"),
            )
        with pytest.raises(ArchiveRefused):
            SessionArchive.restore_new(target, directory)
        assert repo.list_sessions(target) == [existing]
        assert repo.list_messages(target, sid) == []
        assert repo.list_segments(target, sid) == []
        assert note_store.list_notes(target, existing.id)[0].content == "Do not overwrite"
        with target.read() as connection:
            assert connection.execute("SELECT count(*) FROM segments_fts").fetchone()[0] == 0
    finally:
        source.close()
        target.close()


def test_recovered_session_readable_through_http_after_database_reopen(tmp_path: Path) -> None:
    source = Database(":memory:")
    config = AppConfig(token="archive-test", data_dir=tmp_path / "new-install")
    target = Database(config.db_path)
    try:
        doc = native_document(source, tmp_path)
        directory = tmp_path / "External name"
        directory.mkdir()
        (directory / "session.json").write_text(json.dumps(doc), encoding="utf-8")
        sid = SessionArchive.restore_new(target, directory)
    finally:
        source.close()
        target.close()
    app = create_app(config, secret_store=MemorySecretStore())
    with TestClient(app, base_url="http://127.0.0.1",
                    headers={"Authorization": "Bearer archive-test"}) as client:
        detail = client.get(f"/sessions/{sid}")
        assert detail.status_code == 200
        assert detail.json()["session"]["title"] == "External name"
        assert detail.json()["segments"][0]["text"] == "Recognized speech."
        live = client.get(f"/sessions/{sid}/live")
        assert live.status_code == 200
        assert live.json()["saved_samples"] == 1600
