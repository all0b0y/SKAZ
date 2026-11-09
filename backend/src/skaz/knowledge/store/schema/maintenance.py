"""0.4.0 maintenance storage contract. JSON shapes are the matching Kb models."""

NAME = "maintenance"
VERSION = 1

SQL = """
CREATE TABLE IF NOT EXISTS freshness_marks (
    id TEXT PRIMARY KEY,
    material_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('new_version','retracted','newer_contradicts','link_gone')),
    evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
    kept_marked INTEGER NOT NULL DEFAULT 0 CHECK(kept_marked IN (0,1)),
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS freshness_marks_material ON freshness_marks(material_id, kind);
CREATE TABLE IF NOT EXISTS weekly_checks (
    id TEXT PRIMARY KEY REFERENCES explore_jobs(id) ON DELETE CASCADE,
    trigger TEXT NOT NULL CHECK(trigger IN ('manual','scheduled','missed_week')),
    due_at TEXT NOT NULL,
    completed_at TEXT,
    candidates_waiting INTEGER NOT NULL DEFAULT 0 CHECK(candidates_waiting >= 0),
    candidate_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(candidate_ids_json)),
    counts_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(counts_json))
);
CREATE UNIQUE INDEX IF NOT EXISTS weekly_checks_due ON weekly_checks(due_at);
"""
