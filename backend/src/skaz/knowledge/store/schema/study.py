"""Flashcards and tests (0.3.1 S): service data, never rebuilt from the library files.

* ``study_blocks`` — a deck or test block in a chat (the message part names it by id): what it
  shows, where it is (chat / beside the chat / its own window), where the user is in it, and the
  "Save to wiki" request of its last row (S6; Q5: decided whenever the user wants, survives a
  restart). Before saving, the cards and questions live only here (``payload``).
* ``study_cards`` — FSRS state of a saved card, keyed by its block id ``c-…`` (S2: the .md file never
  changes when you review).
* ``study_reviews`` — every grade (for the per-folder new-card limit of the day and the agent).
* ``study_attempts`` — a test's attempts: answers and the result (A-2).
"""
from __future__ import annotations

NAME = "study"
VERSION = 1

SQL = """
CREATE TABLE IF NOT EXISTS study_blocks (
    id           TEXT PRIMARY KEY,
    chat_id      TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
    message_id   TEXT NOT NULL,
    kind         TEXT NOT NULL CHECK (kind IN ('deck', 'test')),
    title        TEXT NOT NULL,
    engine       TEXT,
    -- 'agent': made in this answer; 'show': saved decks/tests shown again (S12).
    origin       TEXT NOT NULL CHECK (origin IN ('agent', 'show')),
    -- JSON: the cards/questions while the block is not saved (and the order of a shown one).
    payload      TEXT NOT NULL DEFAULT '{}',
    page_id      TEXT,
    mode         TEXT NOT NULL DEFAULT 'due',
    folder_id    TEXT,
    save_status  TEXT NOT NULL DEFAULT 'none' CHECK (save_status IN ('none', 'pending', 'saved', 'denied')),
    save_reason  TEXT,
    place        TEXT NOT NULL DEFAULT 'chat' CHECK (place IN ('chat', 'panel', 'window')),
    position     INTEGER NOT NULL DEFAULT 0,
    side         TEXT NOT NULL DEFAULT 'question' CHECK (side IN ('question', 'answer')),
    -- JSON: grades given before saving, the answers of the current test attempt.
    state        TEXT NOT NULL DEFAULT '{}',
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS study_blocks_by_chat ON study_blocks(chat_id, updated_at);

CREATE TABLE IF NOT EXISTS study_cards (
    card_id      TEXT PRIMARY KEY,
    page_id      TEXT NOT NULL,
    fsrs         TEXT,
    lapses       INTEGER NOT NULL DEFAULT 0,
    reps         INTEGER NOT NULL DEFAULT 0,
    suspended    INTEGER NOT NULL DEFAULT 0 CHECK (suspended IN (0, 1)),
    marked_hard  INTEGER NOT NULL DEFAULT 0 CHECK (marked_hard IN (0, 1)),
    due          TEXT,
    updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS study_cards_by_page ON study_cards(page_id);

CREATE TABLE IF NOT EXISTS study_reviews (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id      TEXT NOT NULL,
    page_id      TEXT NOT NULL,
    folder_id    TEXT NOT NULL DEFAULT '',
    rating       INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 4),
    mode         TEXT NOT NULL,
    scheduled    INTEGER NOT NULL CHECK (scheduled IN (0, 1)),
    was_new      INTEGER NOT NULL CHECK (was_new IN (0, 1)),
    reviewed_at  TEXT NOT NULL,
    -- Local calendar day of the review (the new-card limit is per day of the user, decision S8).
    local_day    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS study_reviews_by_day ON study_reviews(local_day, folder_id, was_new);
CREATE INDEX IF NOT EXISTS study_reviews_by_card ON study_reviews(card_id);

CREATE TABLE IF NOT EXISTS study_attempts (
    id           TEXT PRIMARY KEY,
    block_id     TEXT NOT NULL REFERENCES study_blocks(id) ON DELETE CASCADE,
    page_id      TEXT,
    answers      TEXT NOT NULL DEFAULT '{}',
    correct      REAL,
    total        INTEGER NOT NULL DEFAULT 0,
    started_at   TEXT NOT NULL,
    finished_at  TEXT
);
CREATE INDEX IF NOT EXISTS study_attempts_by_block ON study_attempts(block_id, started_at);
"""

UPGRADES: dict[int, str] = {}
