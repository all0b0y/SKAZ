"""Area W2 (package 2): notification decisions, correction details, discrepancy bookkeeping.

* ``notifications`` gains a monotonic ``seq`` (the long-poll cursor; bumped on
  every change), the ``subject`` to open, the resolution and a read mark.
* ``corrections`` (an index of ``.skaz/corrections.json``) gains ``auto``,
  ``decided_at`` and ``start`` (offset of ``before`` in the original fragment).
* ``wiki_discrepancies``/``wiki_checked`` remember which statements were already
  compared, so a contradiction is reported once (service data).

The columns are added here, by this module's own ``SQL`` (which runs exactly
once per database, fresh or old), so no other area's module is edited.
"""
from __future__ import annotations

NAME = "wiki2"
VERSION = 1

SQL = """
ALTER TABLE notifications ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notifications ADD COLUMN subject TEXT;
ALTER TABLE notifications ADD COLUMN resolved_at TEXT;
ALTER TABLE notifications ADD COLUMN resolution TEXT;
ALTER TABLE notifications ADD COLUMN read_at TEXT;
UPDATE notifications SET seq = rowid;
CREATE INDEX IF NOT EXISTS notifications_by_seq ON notifications(seq);

ALTER TABLE corrections ADD COLUMN auto INTEGER NOT NULL DEFAULT 0;
ALTER TABLE corrections ADD COLUMN decided_at TEXT;
ALTER TABLE corrections ADD COLUMN start INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS corrections_by_material ON corrections(material_id, state);

-- A contradiction found between two statements of one page (decision 4).
CREATE TABLE IF NOT EXISTS wiki_discrepancies (
    id              TEXT PRIMARY KEY,
    page_id         TEXT NOT NULL,
    block_a         TEXT NOT NULL,
    block_b         TEXT NOT NULL,
    explanation_id  TEXT,
    notification_id TEXT,
    created_at      TEXT NOT NULL,
    UNIQUE (page_id, block_a, block_b)
);

-- Statements already compared for contradictions (each is compared once, when new).
CREATE TABLE IF NOT EXISTS wiki_checked (
    page_id  TEXT NOT NULL,
    block_id TEXT NOT NULL,
    PRIMARY KEY (page_id, block_id)
);
"""
