"""General chats (area C1): threads, messages and their full-text index.

Service data, not rebuilt from the library files: a chat is not a library
file (decision 8 — answers reach the wiki only through "Save to wiki").
The live event feed of an answer (deltas, parts) is held in memory
(``chats/events.py``); the durable state of every message (parts, state,
failure) is written here at checkpoints and when the answer ends, so a crash
never loses a question.

The tables of the ``service`` module named ``chats``/``messages`` are earlier
placeholders and are not used by this area.
"""
from __future__ import annotations

NAME = "chats"
VERSION = 1

_TOKENIZE = "tokenize='unicode61 remove_diacritics 2'"

SQL = f"""
CREATE TABLE IF NOT EXISTS chat_threads (
    id                    TEXT PRIMARY KEY,
    title                 TEXT NOT NULL,
    -- 1 while the title was made by SKAZ from the first question (the user never renamed it).
    title_auto            INTEGER NOT NULL DEFAULT 1 CHECK (title_auto IN (0, 1)),
    pinned                INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
    engine                TEXT NOT NULL,
    model                 TEXT,
    effort                TEXT,
    recording_material_id TEXT,
    folder_ids            TEXT NOT NULL DEFAULT '[]',
    unread                INTEGER NOT NULL DEFAULT 0 CHECK (unread IN (0, 1)),
    last_preview          TEXT NOT NULL DEFAULT '',
    created_at            TEXT NOT NULL,
    updated_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_threads_by_update ON chat_threads(updated_at);

CREATE TABLE IF NOT EXISTS chat_messages (
    id            TEXT PRIMARY KEY,
    chat_id       TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
    seq           INTEGER NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    state         TEXT NOT NULL CHECK (state IN ('streaming', 'done', 'interrupted', 'failed', 'cancelled')),
    engine        TEXT,
    model         TEXT,
    effort        TEXT,
    -- JSON list of parts (text, cite, page, connection, tool) with ids checked against the library.
    parts         TEXT NOT NULL DEFAULT '[]',
    failure       TEXT,
    -- User messages: what was in the composer (text, mentions, quotes, attachments, open context).
    input         TEXT,
    -- Assistant messages: the user message they answer.
    reply_to      TEXT,
    saved_page_id TEXT,
    created_at    TEXT NOT NULL,
    UNIQUE (chat_id, seq)
);
CREATE INDEX IF NOT EXISTS chat_messages_by_chat ON chat_messages(chat_id, seq);

-- One row per message (its plain text) and one per chat title (message_id = '').
CREATE VIRTUAL TABLE IF NOT EXISTS chat_fts USING fts5(
    text, chat_id UNINDEXED, message_id UNINDEXED, {_TOKENIZE}
);
"""
