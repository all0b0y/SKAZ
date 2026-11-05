"""W-2: agents' web searches held for the user, and "Allow in this chat" for web search.

Service data, not rebuilt from the library files. A message part names a request by id; the row
is what the card shows now (query, decision, links). The grant is one row per chat; it goes with
the chat (``ON DELETE CASCADE``) or when the user revokes it.
"""
from __future__ import annotations

import sqlite3
from collections.abc import Callable

NAME = "web_search"
VERSION = 5

SQL = """
CREATE TABLE IF NOT EXISTS web_search_requests (
    id          TEXT PRIMARY KEY,
    chat_id     TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
    message_id  TEXT NOT NULL,
    run_id      TEXT NOT NULL,
    engine      TEXT NOT NULL,
    -- The exact query as it was (or would have been) sent; domains as JSON lists.
    query       TEXT NOT NULL,
    domains     TEXT NOT NULL DEFAULT '{}',
    status      TEXT NOT NULL CHECK (status IN ('pending', 'allowed', 'denied', 'cancelled')),
    auto        INTEGER NOT NULL DEFAULT 0 CHECK (auto IN (0, 1)),
    reason      TEXT,
    -- JSON list of {"title", "url"} the search returned.
    links       TEXT NOT NULL DEFAULT '[]',
    created_at  TEXT NOT NULL,
    decided_at  TEXT,
    -- W-3b: the agent whose own search runs the query of ``skaz_web_search`` (NULL: the asking agent's own).
    searcher    TEXT,
    -- N7: the search rules in force for this query (JSON; NULL before v3) and the links they hid
    -- (JSON {site: count}).
    rules       TEXT,
    hidden      TEXT NOT NULL DEFAULT '{}',
    -- N9: permission is not execution. Legacy calls have no observed result or duration.
    execution   TEXT DEFAULT 'unknown' CHECK (execution IS NULL OR execution IN
                    ('running', 'done', 'error', 'stopped', 'unknown')),
    started_at  TEXT,
    duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
    execution_error TEXT,
    -- Native provider call id; NULL for tool-based searches and legacy rows.
    call_id     TEXT
);
CREATE INDEX IF NOT EXISTS web_search_requests_by_chat ON web_search_requests(chat_id, status);
CREATE INDEX IF NOT EXISTS web_search_requests_by_run ON web_search_requests(run_id, status);

CREATE TABLE IF NOT EXISTS web_search_grants (
    chat_id    TEXT PRIMARY KEY REFERENCES chat_threads(id) ON DELETE CASCADE,
    granted_at TEXT NOT NULL
);
"""

def _add_missing(*columns: tuple[str, str]) -> Callable[[sqlite3.Connection], None]:
    """Add each column unless it is there: ``executescript`` commits statement by statement, so a start
    that stopped half-way leaves some columns in (Q1 n78 L-3); the next start must finish, not fail."""
    def step(connection: sqlite3.Connection) -> None:
        present = {row[1] for row in connection.execute("PRAGMA table_info(web_search_requests)")}
        for name, kind in columns:
            if name not in present:
                connection.execute(f"ALTER TABLE web_search_requests ADD COLUMN {name} {kind}")

    return step


#: v2 (W-3b): which agent's own search ran a ``skaz_web_search`` query.
#: v3 (N7): the search rules in force for the query and the links they hid.
#: v4 (N9): observed execution, separate from permission; old calls stay unknown.
#: v5 (N9): native provider call identity, not the SKAZ web-tool name constant.
UPGRADES = {2: _add_missing(("searcher", "TEXT")),
            3: _add_missing(("rules", "TEXT"), ("hidden", "TEXT NOT NULL DEFAULT '{}'")),
            4: _add_missing(
                ("execution", "TEXT DEFAULT 'unknown' CHECK (execution IS NULL OR execution IN "
                 "('running', 'done', 'error', 'stopped', 'unknown'))"),
                ("started_at", "TEXT"),
                ("duration_ms", "INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0)"),
                ("execution_error", "TEXT")),
            5: _add_missing(("call_id", "TEXT"))}
