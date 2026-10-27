"""P3: what SKAZ keeps about one test question or card across attempts (service data, not the file).

* ``ideas`` — an open question's key ideas (P3-a decision 7): 2–6 points of the source, each with
  checked citations, made with the test or built at the first check. Every attempt is judged against
  the same list, so attempts compare.
* ``unclear`` — the user's «Unclear» mark (P3-b decisions 8–9): lives on the item, survives retakes,
  never cleared by a right answer, never touches FSRS; only the user clears it.

Keyed by the item's block id (``c-…``): the same id in the chat block and on the saved page.
"""

from __future__ import annotations

NAME = "study_items"
VERSION = 1

SQL = """
CREATE TABLE IF NOT EXISTS study_items (
    item_id      TEXT PRIMARY KEY,
    -- 'question' (a test question) or 'card'.
    kind         TEXT NOT NULL CHECK (kind IN ('question', 'card')),
    -- JSON list of {"id", "text", "cites": [{"material_id", "seg", "quote"}]}; NULL = not built yet.
    ideas        TEXT,
    unclear      INTEGER NOT NULL DEFAULT 0 CHECK (unclear IN (0, 1)),
    unclear_at   TEXT,
    -- Where the user marked it last: the block (a chat's deck/test) and its page once saved.
    block_id     TEXT,
    page_id      TEXT,
    updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS study_items_unclear ON study_items(unclear) WHERE unclear = 1;
"""
