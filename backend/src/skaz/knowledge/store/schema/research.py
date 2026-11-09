"""0.4.0 research storage contract. JSON shapes are the matching Kb models."""

NAME = "research"
VERSION = 1

SQL = """
CREATE TABLE IF NOT EXISTS research_tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    chat_id TEXT NOT NULL UNIQUE REFERENCES chat_threads(id) ON DELETE CASCADE,
    origin_chat_id TEXT REFERENCES chat_threads(id) ON DELETE SET NULL,
    area_id TEXT,
    job_id TEXT NOT NULL REFERENCES explore_jobs(id),
    request_json TEXT NOT NULL CHECK(json_valid(request_json)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS research_permissions (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    engine TEXT NOT NULL,
    arguments_json TEXT NOT NULL CHECK(json_valid(arguments_json)),
    status TEXT NOT NULL CHECK(status IN ('pending','allowed','denied','cancelled')),
    auto INTEGER NOT NULL DEFAULT 0 CHECK(auto IN (0,1)),
    reason TEXT,
    task_id TEXT REFERENCES research_tasks(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    decided_at TEXT
);
CREATE TABLE IF NOT EXISTS research_grants (
    chat_id TEXT PRIMARY KEY REFERENCES chat_threads(id) ON DELETE CASCADE,
    granted_at TEXT NOT NULL
);
"""
