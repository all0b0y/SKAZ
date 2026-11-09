"""0.4.0 science storage contract. JSON shapes are the matching Kb models."""

NAME = "science"
VERSION = 1

SQL = """
CREATE TABLE IF NOT EXISTS science_works (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL CHECK(provider IN ('openalex','arxiv','crossref')),
    provider_id TEXT NOT NULL,
    doi TEXT,
    arxiv_id TEXT,
    metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
    updated_at TEXT NOT NULL,
    UNIQUE(provider, provider_id)
);
CREATE INDEX IF NOT EXISTS science_works_doi ON science_works(doi);
CREATE TABLE IF NOT EXISTS science_egress (
    id TEXT PRIMARY KEY,
    requested_at TEXT NOT NULL,
    provider TEXT NOT NULL CHECK(provider IN ('openalex','arxiv','crossref')),
    operation TEXT NOT NULL,
    destination_host TEXT NOT NULL,
    topics_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(topics_json)),
    dois_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(dois_json)),
    ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(ids_json)),
    outcome TEXT NOT NULL CHECK(outcome IN ('sent','succeeded','failed','rate_limited')),
    status_code INTEGER,
    run_id TEXT
);
CREATE INDEX IF NOT EXISTS science_egress_time ON science_egress(requested_at, id);
CREATE TABLE IF NOT EXISTS science_paid_checks (
    work_id TEXT PRIMARY KEY REFERENCES science_works(id) ON DELETE CASCADE,
    checked_at TEXT,
    alternatives_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(alternatives_json)),
    suggestion_shown_at TEXT
);
"""
