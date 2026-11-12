"""0.4.0 explore storage contract. JSON shapes are the matching Kb models.

v2 (EX3, Explore v2): ``explore_work_states`` keeps what the user did with a work across searches — opened
(Seen) or «Not for me» (Dismissed) — by its science work id, so a second search shows it as already seen.
"""

from __future__ import annotations

import sqlite3
from collections.abc import Callable

NAME = "explore"
VERSION = 2

SQL = """
CREATE TABLE IF NOT EXISTS explore_jobs (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL CHECK(owner IN ('explore','research','links','weekly','repeats')),
    state TEXT NOT NULL CHECK(state IN ('queued','running','paused','done','cancelled','error')),
    stage TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    stop_reason TEXT,
    decision_provider TEXT,
    retry_at TEXT,
    budget_json TEXT NOT NULL CHECK(json_valid(budget_json)),
    counters_json TEXT NOT NULL CHECK(json_valid(counters_json)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS explore_checkpoints (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES explore_jobs(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK(revision >= 1),
    stage TEXT NOT NULL,
    cursor TEXT,
    completed_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(completed_ids_json)),
    pending_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(pending_ids_json)),
    saved_at TEXT NOT NULL,
    UNIQUE(job_id, revision)
);
CREATE TABLE IF NOT EXISTS explore_completed_work (
    job_id TEXT NOT NULL REFERENCES explore_jobs(id) ON DELETE CASCADE,
    candidate_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    result_json TEXT NOT NULL CHECK(json_valid(result_json)),
    completed_at TEXT NOT NULL,
    PRIMARY KEY(job_id, candidate_id, stage)
);
CREATE TABLE IF NOT EXISTS explore_runs (
    id TEXT PRIMARY KEY REFERENCES explore_jobs(id) ON DELETE CASCADE,
    area_id TEXT,
    task_id TEXT,
    request_json TEXT NOT NULL CHECK(json_valid(request_json))
);
CREATE TABLE IF NOT EXISTS explore_findings (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES explore_runs(id) ON DELETE CASCADE,
    task_id TEXT,
    area_id TEXT,
    -- The work as found is kept in details_json; B1's science_works cache is not a dependency (B2).
    work_id TEXT NOT NULL,
    channel TEXT NOT NULL CHECK(channel IN ('continues','branches','search')),
    label TEXT NOT NULL CHECK(label IN ('new','extends','contradicts','branch','covered')),
    reason TEXT NOT NULL,
    theses_json TEXT NOT NULL CHECK(json_valid(theses_json)),
    details_json TEXT NOT NULL CHECK(json_valid(details_json)),
    material_id TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(run_id, work_id)
);
CREATE INDEX IF NOT EXISTS explore_findings_scope ON explore_findings(task_id, area_id, created_at);
CREATE TABLE IF NOT EXISTS explore_readings (
    id TEXT PRIMARY KEY,
    finding_id TEXT NOT NULL REFERENCES explore_findings(id) ON DELETE CASCADE,
    chat_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
    mode TEXT NOT NULL CHECK(mode IN ('brief_tour','deep_dive','notes')),
    text_kind TEXT NOT NULL CHECK(text_kind IN ('tei','arxiv_html','open_page','abstract_only')),
    material_id TEXT,
    started_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS explore_work_states (
    work_id TEXT PRIMARY KEY,
    seen_at TEXT,
    dismissed_at TEXT
);
"""


def _v2(connection: sqlite3.Connection) -> None:
    """Idempotent: the table may already exist when a start was cut before the version row (R2-02)."""
    connection.execute(
        "CREATE TABLE IF NOT EXISTS explore_work_states (work_id TEXT PRIMARY KEY, seen_at TEXT,"
        " dismissed_at TEXT)"
    )


UPGRADES: dict[int, Callable[[sqlite3.Connection], None]] = {2: _v2}
