"""Profile settings, plus local result bytes owned by a chat message."""

NAME = "tools_files"
VERSION = 1
SQL = """
CREATE TABLE IF NOT EXISTS external_tools (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('mcp','skill')),
    url TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    details TEXT NOT NULL,
    instructions TEXT NOT NULL DEFAULT '',
    UNIQUE(kind,url)
);
CREATE TABLE IF NOT EXISTS chat_result_files (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    content BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS result_file_message ON chat_result_files(message_id);
"""
