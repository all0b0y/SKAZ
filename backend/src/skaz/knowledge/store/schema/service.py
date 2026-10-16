"""Service data that does not come from the library files and is never rebuilt from them."""
from __future__ import annotations

NAME = "service"
VERSION = 1

SQL = """
-- The library this profile is connected to. One row; absent until the user confirms a root.
CREATE TABLE IF NOT EXISTS library_state (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    root         TEXT NOT NULL,
    library_id   TEXT NOT NULL,
    connected_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
    id              TEXT PRIMARY KEY,
    kind            TEXT NOT NULL,
    title           TEXT NOT NULL,
    body            TEXT NOT NULL DEFAULT '',
    payload         TEXT NOT NULL DEFAULT '{}',
    requires_action INTEGER NOT NULL DEFAULT 0 CHECK (requires_action IN (0, 1)),
    created_at      TEXT NOT NULL,
    dismissed_at    TEXT
);
CREATE INDEX IF NOT EXISTS notifications_by_time ON notifications(created_at);

-- Processing state of materials and wiki work (no queue: rows run independently).
CREATE TABLE IF NOT EXISTS jobs (
    id         TEXT PRIMARY KEY,
    kind       TEXT NOT NULL,
    target_id  TEXT,
    state      TEXT NOT NULL,
    step       TEXT,
    error      TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_by_target ON jobs(target_id);

CREATE TABLE IF NOT EXISTS chats (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    engine     TEXT,
    pinned     INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
    id         TEXT PRIMARY KEY,
    chat_id    TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    ordinal    INTEGER NOT NULL,
    role       TEXT NOT NULL,
    content    TEXT NOT NULL,
    engine     TEXT,
    meta       TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    UNIQUE (chat_id, ordinal)
);

-- Settings of the new model (JSON values), e.g. the wiki language.
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""
