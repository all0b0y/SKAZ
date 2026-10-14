"""Decision events: how many questions the decision layer answered and how many went to the writing model.

No question, state or answer text is stored — only the decider, the
primitive, the outcome and SKAZ's own plain-English reason.
"""
from __future__ import annotations

NAME = "decisions"
VERSION = 1

SQL = """
CREATE TABLE IF NOT EXISTS decision_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    at         TEXT NOT NULL,
    decider    TEXT NOT NULL CHECK (decider IN ('openrouter_jev', 'local')),
    primitive  TEXT NOT NULL CHECK (primitive IN ('choice', 'noul', 'score')),
    outcome    TEXT NOT NULL CHECK (outcome IN ('decided', 'undecided')),
    reason     TEXT,
    elapsed_ms INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS decision_events_by_time ON decision_events(at);
"""
