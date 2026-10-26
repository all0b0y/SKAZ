"""N6: the live agent session of each chat and the agent sessions waiting to be deleted.

``agent_sessions``: one row per chat — the engine, the agent's session id, the model it started with,
the turn the session holds that SKAZ did not record (a failed/stopped answer: reverted or replaced
next time) and the SKAZ-side context the session last saw (JSON: language, skills, web, deleted
materials — for ``[context]`` notes). Chat content: deleted with the chat.

``agent_session_items``: the chat messages the session already holds, in order — the message id, a
hash of the message as SKAZ's history renders it (an edit changes it) and the agent turn that carried
it (a seed turn carries the whole seeded history). ChatService compares them with the chat before
each answer (prefix sync).

``agent_session_deletions``: durable "delete this agent session" list. A deleted ``agent_sessions``
row (chat deleted — through the cascade —, engine switched, session replaced, signed out) queues its
session here in the same transaction (trigger). Retried; given up after a bounded number of attempts.
Holds ids only, never text; not tied to a chat (the chat is usually gone). v2: ``next_attempt_at`` — a
failed deletion waits before the next try (backoff); an app start tries every entry once.
"""
from __future__ import annotations

NAME = "agent_sessions"
VERSION = 2

SQL = """
CREATE TABLE IF NOT EXISTS agent_sessions (
    chat_id     TEXT PRIMARY KEY REFERENCES chat_threads(id) ON DELETE CASCADE,
    engine      TEXT NOT NULL,
    session_id  TEXT NOT NULL,
    model       TEXT,
    created_at  TEXT NOT NULL,
    -- The first agent turn after the recorded items that SKAZ did not record (failed/stopped answer).
    tail_turn_id TEXT,
    -- JSON: the SKAZ-side context the session last saw (``chats.live.SessionContext``).
    context     TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS agent_session_items (
    chat_id     TEXT NOT NULL REFERENCES agent_sessions(chat_id) ON DELETE CASCADE,
    ord         INTEGER NOT NULL,
    message_id  TEXT NOT NULL,
    digest      TEXT NOT NULL,
    turn_id     TEXT NOT NULL,
    PRIMARY KEY (chat_id, ord)
);

CREATE TABLE IF NOT EXISTS agent_session_deletions (
    engine      TEXT NOT NULL,
    session_id  TEXT NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 0,
    queued_at   TEXT NOT NULL,
    -- Not tried before this time (after a failed attempt); NULL = due now.
    next_attempt_at TEXT,
    PRIMARY KEY (engine, session_id)
);

CREATE TRIGGER IF NOT EXISTS agent_sessions_queue_deletion AFTER DELETE ON agent_sessions
BEGIN
    INSERT OR IGNORE INTO agent_session_deletions (engine, session_id, attempts, queued_at)
    VALUES (old.engine, old.session_id, 0, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'));
END;
"""

UPGRADES = {2: "ALTER TABLE agent_session_deletions ADD COLUMN next_attempt_at TEXT;\n"}
