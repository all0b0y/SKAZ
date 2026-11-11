"""Ingest job details (area W1): progress counters and the plain-words job journal.

The job itself is a row of the foundation ``jobs`` table (``kind='ingest'``);
this table adds what the status line and the activity view need. Service data:
never rebuilt from files. The journal holds code-written messages only — never
the text of a source or of a rejected block.
"""
from __future__ import annotations

import sqlite3
from collections.abc import Callable

NAME = "ingest"
VERSION = 3

SQL = """
CREATE TABLE IF NOT EXISTS ingest_jobs (
    job_id     TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
    counters   TEXT NOT NULL DEFAULT '{}',
    journal    TEXT NOT NULL DEFAULT '[]',
    -- Machine-readable kind of a failure the user can fix elsewhere (``AGENT_UNAVAILABLE``), or NULL.
    error_code TEXT,
    scope      TEXT NOT NULL DEFAULT 'full'
);
"""


def _add_missing(name: str, kind: str) -> Callable[[sqlite3.Connection], None]:
    """Add the column unless it is there: an ALTER commits on its own, so a start that stopped before the
    version row was written re-runs the step (0.4.0 review R2-02); it must finish, not fail."""

    def step(connection: sqlite3.Connection) -> None:
        present = {row[1] for row in connection.execute("PRAGMA table_info(ingest_jobs)")}
        if name not in present:
            connection.execute(f"ALTER TABLE ingest_jobs ADD COLUMN {name} {kind}")

    return step


#: v2 (G4): the machine-readable failure kind. v3 (0.4.0 WR6): ``full`` | ``notes`` (Write notes only).
UPGRADES = {
    2: _add_missing("error_code", "TEXT"),
    3: _add_missing("scope", "TEXT NOT NULL DEFAULT 'full'"),
}
