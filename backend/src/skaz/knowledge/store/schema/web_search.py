"""W-2: agents' web searches held for the user, and "Allow in this chat" for web search.

Service data, not rebuilt from the library files. A message part names a request by id; the row
is what the card shows now (query, decision, links). The grant is one row per chat; it goes with
the chat (``ON DELETE CASCADE``) or when the user revokes it.
"""
from __future__ import annotations

NAME = "web_search"
VERSION = 2

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
    searcher    TEXT
);
CREATE INDEX IF NOT EXISTS web_search_requests_by_chat ON web_search_requests(chat_id, status);
CREATE INDEX IF NOT EXISTS web_search_requests_by_run ON web_search_requests(run_id, status);

CREATE TABLE IF NOT EXISTS web_search_grants (
    chat_id    TEXT PRIMARY KEY REFERENCES chat_threads(id) ON DELETE CASCADE,
    granted_at TEXT NOT NULL
);
"""

#: v2 (W-3b): which agent's own search ran a ``skaz_web_search`` query.
UPGRADES = {2: "ALTER TABLE web_search_requests ADD COLUMN searcher TEXT;"}
