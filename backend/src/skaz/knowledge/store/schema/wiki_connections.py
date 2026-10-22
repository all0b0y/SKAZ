"""C1-a: which connection candidates were already checked, and which pages still wait for a check.

* ``wiki_connection_checks`` — one row per unordered page pair (``page_a < page_b``):
  ``none``/``declined`` — the fingerprint of the exact input that was checked (both sides'
  statements, the rules, the wiki profile, the decision layer) ended without a connection, valid
  only while the current input has the same fingerprint (a positive result is the connection block
  itself); ``unanswered`` — ``attempts`` answers for that input were not in the expected format
  (given up at three, until the input changes); ``removed`` — the user deleted the pair's
  connection: never suggested again, whatever the statements (gone only with a page).
* ``wiki_connection_pending`` — concept pages whose connection run has not finished (a model
  failure, a quit) or that the user edited: the next run checks them.

Service data, never prompts or source text. v2 (``unanswered``/``removed``, ``attempts``): SQLite
can't change a CHECK in place, so the table is rebuilt and its rows copied.
"""
from __future__ import annotations

NAME = "wiki_connections"
VERSION = 2

_CHECKS = """
CREATE TABLE IF NOT EXISTS {name} (
    page_a     TEXT NOT NULL,
    page_b     TEXT NOT NULL,
    input_key  TEXT NOT NULL,
    outcome    TEXT NOT NULL CHECK (outcome IN ('none', 'declined', 'unanswered', 'removed')),
    attempts   INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    checked_at TEXT NOT NULL,
    PRIMARY KEY (page_a, page_b),
    CHECK (page_a < page_b)
);
"""

SQL = _CHECKS.format(name="wiki_connection_checks") + """
CREATE TABLE IF NOT EXISTS wiki_connection_pending (
    page_id  TEXT PRIMARY KEY,
    added_at TEXT NOT NULL
);
"""

UPGRADES = {
    2: _CHECKS.format(name="wiki_connection_checks_v2") + """
INSERT INTO wiki_connection_checks_v2(page_a, page_b, input_key, outcome, attempts, checked_at)
    SELECT page_a, page_b, input_key, outcome, 0, checked_at FROM wiki_connection_checks;
DROP TABLE wiki_connection_checks;
ALTER TABLE wiki_connection_checks_v2 RENAME TO wiki_connection_checks;
""",
}
