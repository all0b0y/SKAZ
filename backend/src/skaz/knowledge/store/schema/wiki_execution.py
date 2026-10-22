"""Immutable wiki-processing selections and aggregate usage. Never prompts or source text."""
from __future__ import annotations

NAME = "wiki_execution"
VERSION = 3

SQL = """
CREATE TABLE IF NOT EXISTS wiki_execution (
    job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
    data TEXT NOT NULL
);
"""

_CHECKPOINT_SQL = """
CREATE TABLE IF NOT EXISTS wiki_checkpoints (
    material_id TEXT PRIMARY KEY REFERENCES materials(id) ON DELETE CASCADE,
    fingerprint TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS wiki_checkpoint_answers (
    material_id TEXT NOT NULL REFERENCES wiki_checkpoints(material_id) ON DELETE CASCADE,
    step_key TEXT NOT NULL,
    response TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(material_id, step_key)
);
"""
#: v3 (C1-f item 4): who wrote each kept answer, and which choice finished the material, so another
#: model continues a stopped material from its finished work but a finished one starts over.
_WRITER_SQL = """
ALTER TABLE wiki_checkpoint_answers ADD COLUMN profile TEXT;
ALTER TABLE wiki_checkpoints ADD COLUMN finished_profile TEXT;
"""
SQL += _CHECKPOINT_SQL + _WRITER_SQL
UPGRADES = {2: _CHECKPOINT_SQL, 3: _WRITER_SQL}
