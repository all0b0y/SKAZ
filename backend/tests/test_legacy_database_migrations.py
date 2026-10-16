"""The technical-session database keeps opening old files without rewriting their rows.

Recordings and imports still run in sessions of ``skaz.sqlite3``; earlier versions
left tables and modes this one no longer writes (contextual local windows, live
drafts and finality). Opening such a file must stay additive and idempotent (B4:
old data is not changed). Moved here from the tests of the removed live-ASR draft,
finality and contextual-mode modules.
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

from skaz import repository as repo
from skaz.db import Database


def test_contextual_mode_survives_database_restart(tmp_path: Path) -> None:
    path = tmp_path / "restart.sqlite3"
    first = Database(path)
    created = repo.create_session(first, "context", mode="contextual_local")
    first.close()
    reopened = Database(path)
    try:
        restored = repo.get_session(reopened, created.id)
        assert restored is not None and restored.mode == "contextual_local"
    finally:
        reopened.close()


def test_existing_session_rows_migrate_to_legacy_without_rewrite(tmp_path: Path) -> None:
    path = tmp_path / "old.sqlite3"
    connection = sqlite3.connect(path)
    connection.execute(
        "CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, "
        "created_at TEXT NOT NULL, status TEXT NOT NULL, duration_ms INTEGER NOT NULL DEFAULT 0)"
    )
    connection.execute(
        "INSERT INTO sessions VALUES ('old', 'Old', 'now', 'stopped', 12)"
    )
    connection.commit()
    connection.close()
    migrated = Database(path)
    try:
        restored = repo.get_session(migrated, "old")
        assert restored is not None and restored.mode == "legacy"
    finally:
        migrated.close()


def test_finality_schema_migration_adds_bounded_rollover_metadata(tmp_path: Path) -> None:
    path = tmp_path / "legacy-finality.sqlite3"
    connection = sqlite3.connect(path)
    connection.execute(
        """
        CREATE TABLE sessions (
            id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL,
            status TEXT NOT NULL, duration_ms INTEGER NOT NULL DEFAULT 0
        )
        """
    )
    connection.execute(
        """
        CREATE TABLE live_asr_finality (
            session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
            stable_text TEXT NOT NULL DEFAULT '',
            stable_tokens_json TEXT NOT NULL DEFAULT '[]',
            stable_frontier_ms INTEGER NOT NULL DEFAULT 0,
            agreement_epoch INTEGER NOT NULL,
            previous_window_start_ms INTEGER,
            previous_window_end_ms INTEGER,
            previous_words_json TEXT NOT NULL DEFAULT '[]',
            last_revision INTEGER NOT NULL DEFAULT 0,
            last_segment_ids_json TEXT NOT NULL DEFAULT '[]',
            updated_at TEXT NOT NULL
        )
        """
    )
    connection.execute(
        "INSERT INTO sessions VALUES ('kept', 'Legacy', 'now', 'recording', 0)"
    )
    connection.execute(
        """
        INSERT INTO live_asr_finality VALUES (
            'kept', 'old words', '["old","words"]', 900, 1,
            0, 1000, '[]', 2, '[]', 'now'
        )
        """
    )
    connection.commit()
    connection.close()

    for _ in range(2):
        database = Database(path)
        with database.read() as migrated:
            row = migrated.execute(
                "SELECT active_anchor_ms, stable_token_offset FROM live_asr_finality "
                "WHERE session_id='kept'"
            ).fetchone()
            assert tuple(row) == (0, 0)
        database.close()


def test_schema_migration_is_additive_idempotent_and_preserves_old_sessions(tmp_path: Path) -> None:
    path = tmp_path / "legacy.sqlite3"
    connection = sqlite3.connect(path)
    connection.execute(
        """
        CREATE TABLE sessions (
            id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL,
            status TEXT NOT NULL, duration_ms INTEGER NOT NULL DEFAULT 0
        )
        """
    )
    connection.execute(
        "INSERT INTO sessions VALUES ('kept', 'Legacy', '2026-01-01T00:00:00Z', 'stopped', 7)"
    )
    connection.commit()
    connection.close()

    for _ in range(2):
        database = Database(path)
        with database.read() as migrated:
            assert migrated.execute("SELECT title FROM sessions WHERE id='kept'").fetchone()[0] == "Legacy"
            tables = {
                row[0]
                for row in migrated.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                ).fetchall()
            }
            assert {"live_asr_drafts", "settings_revisions"} <= tables
        database.close()
