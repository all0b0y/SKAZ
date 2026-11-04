"""The stored summary of a long chat's earliest messages (``chats.summary``).

One row per chat: the AI-written retelling of the first ``covers`` history messages and the
fingerprint of exactly those messages, so an edited or regenerated earlier message is noticed and
the summary rebuilt instead of trusted. It is chat content (deleted with the chat), never evidence.
"""
from __future__ import annotations

NAME = "chat_summaries"
VERSION = 1

SQL = """
CREATE TABLE IF NOT EXISTS chat_summaries (
    chat_id    TEXT PRIMARY KEY REFERENCES chat_threads(id) ON DELETE CASCADE,
    covers     INTEGER NOT NULL,
    input_key  TEXT NOT NULL,
    text       TEXT NOT NULL,
    engine     TEXT NOT NULL,
    model      TEXT,
    updated_at TEXT NOT NULL
);
"""
