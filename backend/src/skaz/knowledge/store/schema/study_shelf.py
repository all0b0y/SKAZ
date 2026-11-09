"""N4-8: how long a saved deck or test has gone unopened, and whether it is archived.

Service data, not rebuilt from the library files; one row per saved page, keyed by its id. Written when
the user opens the page; a page without a row yet gets one, with its days starting then, when SKAZ first
sees it (earlier builds recorded no openings).

* ``archived_by`` — ``auto`` (a test unopened for 60 days) or ``user``.
* ``suggestion_kept_at`` — the user answered "not now" to the suggestion to archive a learned deck.
"""
from __future__ import annotations

NAME = "study_shelf"
VERSION = 1

SQL = """
CREATE TABLE IF NOT EXISTS study_shelf (
    page_id             TEXT PRIMARY KEY,
    opened_at           TEXT NOT NULL,
    archived_at         TEXT,
    archived_by         TEXT CHECK (archived_by IN ('auto', 'user')),
    suggestion_kept_at  TEXT
);
"""
