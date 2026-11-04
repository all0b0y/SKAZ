"""Per-run token accounting of agent runs outside the wiki pipeline (chat answers for now).

Service data, counters only: never the question, answer, prompt or tool output. Rows outlive a
deleted chat on purpose (ids and numbers, no content), so spending stays measurable; the wiki
pipeline keeps its own aggregate in ``wiki_execution``. Token columns are ``NULL`` when the agent
did not report that count — never 0 for unknown.
"""
from __future__ import annotations

NAME = "agent_usage"
VERSION = 1

SQL = """
CREATE TABLE IF NOT EXISTS agent_usage (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    kind                TEXT NOT NULL,
    chat_id             TEXT,
    message_id          TEXT,
    engine              TEXT NOT NULL,
    -- Requested model/effort (NULL: the agent's default), not a claim about what the provider ran.
    model               TEXT,
    effort              TEXT,
    outcome             TEXT NOT NULL,
    input_tokens        INTEGER,
    cached_input_tokens INTEGER,
    cache_write_tokens  INTEGER,
    output_tokens       INTEGER,
    reasoning_tokens    INTEGER,
    tool_calls          INTEGER NOT NULL DEFAULT 0,
    prompt_characters   INTEGER NOT NULL DEFAULT 0,
    duration_ms         INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_usage_by_chat ON agent_usage(chat_id);
"""
