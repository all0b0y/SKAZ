"""L7: an invalid session mode is refused on fresh and on migrated databases alike."""
from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from skaz.db import Database


def _insert(db: Database, mode: str) -> None:
    with db.write() as connection:
        connection.execute(
            "INSERT INTO sessions(id, title, created_at, status, mode) VALUES (?, 't', 'now', 'stopped', ?)",
            (f"s-{mode}", mode),
        )


def test_a_fresh_database_refuses_an_unknown_mode(tmp_path: Path) -> None:
    db = Database(tmp_path / "fresh.sqlite3")
    _insert(db, "legacy")
    with pytest.raises(sqlite3.IntegrityError):
        _insert(db, "x")


def test_a_database_migrated_without_the_check_refuses_it_too(tmp_path: Path) -> None:
    path = tmp_path / "old.sqlite3"
    db = Database(path)
    db.close()
    raw = sqlite3.connect(path)
    # What an older SKAZ left: the mode column without its CHECK (and without the new triggers).
    raw.executescript(
        "DROP TRIGGER IF EXISTS sessions_mode_insert; DROP TRIGGER IF EXISTS sessions_mode_update;"
    )
    raw.commit()
    raw.close()
    reopened = Database(path)
    with pytest.raises(sqlite3.IntegrityError):
        _insert(reopened, "x")
