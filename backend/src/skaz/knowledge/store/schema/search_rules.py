"""N7: one chat's changes to the search rules (``permissions.search_rules``).

Service data, not rebuilt from the library files. One row per chat (JSON: web lists, library
sources «only these» / excluded, a pending «Search everywhere once»); it goes with the chat. No row:
the chat follows Settings → Search (the ``settings`` key ``search_rules``).
"""
from __future__ import annotations

NAME = "search_rules"
VERSION = 1

SQL = """
CREATE TABLE IF NOT EXISTS chat_search_rules (
    chat_id    TEXT PRIMARY KEY REFERENCES chat_threads(id) ON DELETE CASCADE,
    rules      TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
"""
