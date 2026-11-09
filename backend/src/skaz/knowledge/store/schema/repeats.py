"""0.4.0 repeats storage contract. JSON shapes are the matching Kb models."""

NAME = "repeats"
VERSION = 1

SQL = """
CREATE TABLE IF NOT EXISTS material_repeat_checks (
    material_id TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK(status IN ('checked','not_checked')),
    evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
    checked_at TEXT
);
CREATE TABLE IF NOT EXISTS repeat_check_runs (
    id TEXT PRIMARY KEY REFERENCES explore_jobs(id) ON DELETE CASCADE,
    area_id TEXT NOT NULL,
    materials_checked INTEGER NOT NULL DEFAULT 0 CHECK(materials_checked >= 0),
    materials_remaining INTEGER NOT NULL DEFAULT 0 CHECK(materials_remaining >= 0)
);
"""
