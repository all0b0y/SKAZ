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
#: v2 (0.3.1 P): agents' permission requests, "Allow in this chat" grants and agents' questions.
VERSION = 2

_TOKENIZE = "tokenize='unicode61 remove_diacritics 2'"

#: Service data of the agent controls (not rebuilt from files). A message part names a row by id;
#: the row is what the card shows now. ``undo`` holds the files as they were before an applied change
#: (base64) and their hashes right after it, so Undo can refuse once a file changed again.
PERMISSIONS_SQL = """
CREATE TABLE IF NOT EXISTS permission_requests (
    id          TEXT PRIMARY KEY,
    chat_id     TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
    message_id  TEXT NOT NULL,
    run_id      TEXT NOT NULL,
    engine      TEXT NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('create', 'edit', 'rename', 'delete')),
    page_id     TEXT,
    title       TEXT NOT NULL DEFAULT '',
    -- JSON: {"summary": {...}, "changes": [...], "extra": {...}} as shown on the card.
    preview     TEXT NOT NULL DEFAULT '{}',
    status      TEXT NOT NULL CHECK (status IN ('pending', 'allowed', 'denied', 'cancelled', 'undone')),
    reason      TEXT,
    auto        INTEGER NOT NULL DEFAULT 0 CHECK (auto IN (0, 1)),
    applied     INTEGER NOT NULL DEFAULT 0 CHECK (applied IN (0, 1)),
    undo        TEXT,
    created_at  TEXT NOT NULL,
    decided_at  TEXT
);
CREATE INDEX IF NOT EXISTS permission_requests_by_chat ON permission_requests(chat_id, status);
CREATE INDEX IF NOT EXISTS permission_requests_by_run ON permission_requests(run_id, status);

-- "Allow in this chat": one row per chat and kind (never 'delete': deleting always asks).
CREATE TABLE IF NOT EXISTS permission_grants (
    chat_id    TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL CHECK (kind IN ('create', 'edit', 'rename')),
    granted_at TEXT NOT NULL,
    PRIMARY KEY (chat_id, kind)
);

CREATE TABLE IF NOT EXISTS agent_questions (
    id          TEXT PRIMARY KEY,
    chat_id     TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
    message_id  TEXT NOT NULL,
    run_id      TEXT NOT NULL,
    engine      TEXT NOT NULL,
    question    TEXT NOT NULL,
    -- JSON list of {"label", "description", "recommended"}.
    options     TEXT NOT NULL DEFAULT '[]',
    status      TEXT NOT NULL CHECK (status IN ('pending', 'answered', 'superseded', 'cancelled')),
    answer      TEXT,
    created_at  TEXT NOT NULL,
    answered_at TEXT
);
CREATE INDEX IF NOT EXISTS agent_questions_by_chat ON agent_questions(chat_id, status);
CREATE INDEX IF NOT EXISTS agent_questions_by_run ON agent_questions(run_id, status);
"""

UPGRADES = {2: PERMISSIONS_SQL}

_CHATS_V1 = f"""
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

#: v1 tables first: the agent-control tables reference ``chat_threads``.
SQL = _CHATS_V1 + PERMISSIONS_SQL
