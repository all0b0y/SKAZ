"""Q1 n78 L-3: the ``web_search`` upgrade is idempotent — a start that crashed between its column adds
(``executescript`` commits each statement) is upgraded on the next start, not refused with «duplicate
column»."""
from __future__ import annotations

import sqlite3

from skaz.knowledge.store.schema import applied_versions, apply_schemas
from skaz.knowledge.store.schema import web_search as module

V1 = """
CREATE TABLE web_search_requests (
    id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, message_id TEXT NOT NULL, run_id TEXT NOT NULL,
    engine TEXT NOT NULL, query TEXT NOT NULL, domains TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL,
    auto INTEGER NOT NULL DEFAULT 0, reason TEXT, links TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL,
    decided_at TEXT
);
CREATE TABLE web_search_grants (chat_id TEXT PRIMARY KEY, granted_at TEXT NOT NULL);
"""


def _columns(connection: sqlite3.Connection) -> set[str]:
    return {row[1] for row in connection.execute("PRAGMA table_info(web_search_requests)")}


def test_a_half_done_upgrade_finishes_on_the_next_start() -> None:
    connection = sqlite3.connect(":memory:")
    connection.executescript(V1)
    applied_versions(connection)
    connection.execute("INSERT INTO schema_versions(name, version) VALUES ('web_search', 1)")
    # The crashed start: v2 and half of v3 went in, the version stayed at 1.
    connection.executescript("ALTER TABLE web_search_requests ADD COLUMN searcher TEXT;"
                             "ALTER TABLE web_search_requests ADD COLUMN rules TEXT;")
    apply_schemas(connection, [module])
    assert {"searcher", "rules", "hidden"} <= _columns(connection)
    assert applied_versions(connection)["web_search"] == module.VERSION
    apply_schemas(connection, [module])  # and again: nothing to do
