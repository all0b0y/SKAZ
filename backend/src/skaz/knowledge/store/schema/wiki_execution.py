"""Immutable wiki-processing selections and aggregate usage. Never prompts or source text.

The fresh ``SQL`` is re-runnable (``CREATE … IF NOT EXISTS`` only): a first start killed after the
tables but before the version row runs it again. ``ALTER``s live only in ``UPGRADES``.
"""
from __future__ import annotations

NAME = "wiki_execution"
VERSION = 4

_EXECUTION_SQL = """
CREATE TABLE IF NOT EXISTS wiki_execution (
    job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
    data TEXT NOT NULL,
    root_job_id TEXT
);
"""
#: v4: the root of each job in its own column, so the budget check before every wiki call reads the
#: jobs of one root by index instead of parsing every job ever run. Older rows are filled from ``data``.
_ROOT_INDEX_SQL = """
CREATE INDEX IF NOT EXISTS wiki_execution_by_root ON wiki_execution(root_job_id);
"""
_ROOT_SQL = """
ALTER TABLE wiki_execution ADD COLUMN root_job_id TEXT;
UPDATE wiki_execution SET root_job_id = json_extract(data, '$.root_job_id');
""" + _ROOT_INDEX_SQL

#: v2 tables; ``{finished}``/``{profile}`` take the v3 columns in the fresh ``SQL``.
_CHECKPOINT_SQL = """
CREATE TABLE IF NOT EXISTS wiki_checkpoints (
    material_id TEXT PRIMARY KEY REFERENCES materials(id) ON DELETE CASCADE,
    fingerprint TEXT NOT NULL{finished}
);
CREATE TABLE IF NOT EXISTS wiki_checkpoint_answers (
    material_id TEXT NOT NULL REFERENCES wiki_checkpoints(material_id) ON DELETE CASCADE,
    step_key TEXT NOT NULL,
    response TEXT NOT NULL,
    created_at TEXT NOT NULL,{profile}
    PRIMARY KEY(material_id, step_key)
);
"""
#: v3 (C1-f item 4): who wrote each kept answer, and which choice finished the material, so another
#: model continues a stopped material from its finished work but a finished one starts over.
_WRITER_SQL = """
ALTER TABLE wiki_checkpoint_answers ADD COLUMN profile TEXT;
ALTER TABLE wiki_checkpoints ADD COLUMN finished_profile TEXT;
"""
SQL = _EXECUTION_SQL + _ROOT_INDEX_SQL + _CHECKPOINT_SQL.format(finished=",\n    finished_profile TEXT",
                                                              profile="\n    profile TEXT,")
UPGRADES = {2: _CHECKPOINT_SQL.format(finished="", profile=""), 3: _WRITER_SQL, 4: _ROOT_SQL}
