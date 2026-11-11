"""Immutable wiki-processing selections and aggregate usage. Never prompts or source text.

The fresh ``SQL`` is re-runnable (``CREATE … IF NOT EXISTS`` only): a first start killed after the
tables but before the version row runs it again. ``ALTER``s live only in ``UPGRADES``.
"""
from __future__ import annotations

NAME = "wiki_execution"
VERSION = 5

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

#: v2 tables; ``{finished}``/``{profile}`` take the v3 columns in the fresh ``SQL``, ``{name}``/``{head}``
#: the table names (v5 builds the new tables beside the old ones). Since v5 (WR1) the head does not
#: reference ``materials``: the startup scan rebuilds that table (``DELETE FROM materials``), and a cascade
#: from it wiped every kept answer on each app start. A head goes only when the user deletes the
#: material (``wiki/pages_io.forget_material``, the speech removal) or a complete scan finds the
#: material gone (``index/indexer.replace_index``).
_CHECKPOINT_SQL = """
CREATE TABLE IF NOT EXISTS {head} (
    material_id TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL{finished}
);
CREATE TABLE IF NOT EXISTS {name} (
    material_id TEXT NOT NULL REFERENCES {head}(material_id) ON DELETE CASCADE,
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
_V3_COLUMNS = {"finished": ",\n    finished_profile TEXT", "profile": "\n    profile TEXT,"}
_TABLES = {"head": "wiki_checkpoints", "name": "wiki_checkpoint_answers"}
#: v5 (WR1): the head without the reference to ``materials``. SQLite can't drop a constraint, so both
#: tables are built anew beside the old ones and the rows copied, in one transaction; the answers'
#: reference follows the head's rename. Re-runnable: a start killed before the version row repeats it.
#: ``DROP`` of the old answers before the old head, so the head's drop cascades into nothing.
_UNCASCADED_SQL = "BEGIN;\n" + _CHECKPOINT_SQL.format(
    **_V3_COLUMNS, head="wiki_checkpoints_v5", name="wiki_checkpoint_answers_v5") + """
INSERT OR IGNORE INTO wiki_checkpoints_v5(material_id, fingerprint, finished_profile)
    SELECT material_id, fingerprint, finished_profile FROM wiki_checkpoints;
INSERT OR IGNORE INTO wiki_checkpoint_answers_v5(material_id, step_key, response, created_at, profile)
    SELECT material_id, step_key, response, created_at, profile FROM wiki_checkpoint_answers;
DROP TABLE wiki_checkpoint_answers;
DROP TABLE wiki_checkpoints;
ALTER TABLE wiki_checkpoints_v5 RENAME TO wiki_checkpoints;
ALTER TABLE wiki_checkpoint_answers_v5 RENAME TO wiki_checkpoint_answers;
COMMIT;
"""
SQL = _EXECUTION_SQL + _ROOT_INDEX_SQL + _CHECKPOINT_SQL.format(**_V3_COLUMNS, **_TABLES)
UPGRADES = {2: _CHECKPOINT_SQL.format(finished="", profile="", **_TABLES), 3: _WRITER_SQL, 4: _ROOT_SQL,
            5: _UNCASCADED_SQL}
