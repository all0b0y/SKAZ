"""0.4.0 freshness storage contract. JSON shapes are the matching Kb models."""

NAME = "freshness"
VERSION = 1

SQL = """
CREATE TABLE IF NOT EXISTS material_publications (
    material_id TEXT PRIMARY KEY,
    year INTEGER CHECK(year IS NULL OR year BETWEEN 1 AND 9999),
    publication_date TEXT,
    month INTEGER CHECK(month IS NULL OR month BETWEEN 1 AND 12),
    precision TEXT NOT NULL CHECK(precision IN ('day','month','year','unknown')),
    origin TEXT NOT NULL CHECK(origin IN ('openalex','arxiv','crossref','page','unknown')),
    evidence_url TEXT,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS material_publications_date ON material_publications(year, publication_date);
CREATE TABLE IF NOT EXISTS freshness_link_checks (
    id TEXT PRIMARY KEY REFERENCES explore_jobs(id) ON DELETE CASCADE,
    scope_json TEXT NOT NULL CHECK(json_valid(scope_json))
);
CREATE TABLE IF NOT EXISTS freshness_link_observations (
    id TEXT PRIMARY KEY,
    check_id TEXT NOT NULL REFERENCES freshness_link_checks(id) ON DELETE CASCADE,
    material_id TEXT NOT NULL,
    url TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK(outcome IN ('ok','suspected_gone','confirmed_gone','could_not_check')),
    reason TEXT,
    status_code INTEGER,
    checked_at TEXT NOT NULL,
    first_gone_at TEXT,
    confirm_after TEXT
);
CREATE INDEX IF NOT EXISTS freshness_links_material ON freshness_link_observations(material_id, checked_at);
"""
