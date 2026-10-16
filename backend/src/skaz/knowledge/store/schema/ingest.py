"""Ingest job details (area W1): progress counters and the plain-words job journal.

The job itself is a row of the foundation ``jobs`` table (``kind='ingest'``);
this table adds what the status line and the activity view need. Service data:
never rebuilt from files. The journal holds code-written messages only — never
the text of a source or of a rejected block.
"""
from __future__ import annotations

NAME = "ingest"
VERSION = 2

SQL = """
CREATE TABLE IF NOT EXISTS ingest_jobs (
    job_id     TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
    counters   TEXT NOT NULL DEFAULT '{}',
    journal    TEXT NOT NULL DEFAULT '[]',
    -- Machine-readable kind of a failure the user can fix elsewhere (``AGENT_UNAVAILABLE``), or NULL.
    error_code TEXT
);
"""

UPGRADES = {
    2: "ALTER TABLE ingest_jobs ADD COLUMN error_code TEXT;\n",
}
