"""0.4.0 areas storage contract. JSON shapes are the matching Kb models."""

NAME = "areas"
VERSION = 1

SQL = """
CREATE TABLE IF NOT EXISTS explore_areas (
    id TEXT PRIMARY KEY,
    parent_id TEXT REFERENCES explore_areas(id),
    taxonomy_id TEXT,
    level TEXT NOT NULL CHECK(level IN ('domain','field','subfield','topic','custom')),
    original_name TEXT NOT NULL,
    name TEXT NOT NULL,
    hidden INTEGER NOT NULL DEFAULT 0 CHECK(hidden IN (0,1)),
    pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0,1))
);
CREATE TABLE IF NOT EXISTS explore_area_topics (
    area_id TEXT NOT NULL REFERENCES explore_areas(id) ON DELETE CASCADE,
    topic_id TEXT NOT NULL,
    PRIMARY KEY(area_id, topic_id)
);
CREATE TABLE IF NOT EXISTS explore_area_pages (
    area_id TEXT NOT NULL REFERENCES explore_areas(id) ON DELETE CASCADE,
    page_id TEXT NOT NULL,
    PRIMARY KEY(area_id, page_id)
);
CREATE TABLE IF NOT EXISTS explore_read_marks (
    target_kind TEXT NOT NULL CHECK(target_kind IN ('material','finding')),
    target_id TEXT NOT NULL,
    value TEXT NOT NULL CHECK(value IN ('useful_method','changed_my_view','already_knew','not_for_me')),
    updated_at TEXT NOT NULL,
    PRIMARY KEY(target_kind, target_id)
);
CREATE TABLE IF NOT EXISTS explore_signals (
    id TEXT PRIMARY KEY,
    subject_kind TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    predicate TEXT NOT NULL,
    object_kind TEXT NOT NULL,
    object_id TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    origin TEXT NOT NULL CHECK(origin IN ('user_action','task_event','study_event')),
    value TEXT,
    evidence_id TEXT NOT NULL,
    supersedes_id TEXT REFERENCES explore_signals(id)
);
CREATE INDEX IF NOT EXISTS explore_signals_subject ON explore_signals(subject_kind, subject_id, occurred_at);
CREATE INDEX IF NOT EXISTS explore_signals_object ON explore_signals(object_kind, object_id, occurred_at);
"""
