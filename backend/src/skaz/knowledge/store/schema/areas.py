"""0.4.0 areas storage contract. JSON shapes are the matching Kb models.

v2 (EX2, after G2): the map is the user's own topics (``level='custom'``, two levels by ``parent_id``). A wiki
material has at most one topic (``explore_area_materials``; ``origin`` agent|user — the user's move
wins). Each own topic carries a hidden OpenAlex label in ``explore_area_topics`` with ``mapping_state``
and the name it was mapped
for (``mapped_name``: a rename re-maps). Pre-EX2 OpenAlex rows stay (history of signals/runs), off the map.

v3 (EX3 S4): ``mapping_reason`` — why a topic has no label (``areas.mapping.MappingReason``, system only).
The ``no_match`` labels stored before v3 came from one joined ``/topics`` search that OpenAlex could not
match (it ANDs the words), so they wait for their label again, once.
"""

from __future__ import annotations

import sqlite3
from collections.abc import Callable

NAME = "areas"
VERSION = 3

SQL = """
CREATE TABLE IF NOT EXISTS explore_areas (
    id TEXT PRIMARY KEY,
    parent_id TEXT REFERENCES explore_areas(id),
    taxonomy_id TEXT,
    level TEXT NOT NULL CHECK(level IN ('domain','field','subfield','topic','custom')),
    original_name TEXT NOT NULL,
    name TEXT NOT NULL,
    hidden INTEGER NOT NULL DEFAULT 0 CHECK(hidden IN (0,1)),
    pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0,1)),
    mapping_state TEXT NOT NULL DEFAULT 'pending' CHECK(mapping_state IN ('pending','mapped','no_match')),
    mapped_name TEXT,
    mapping_reason TEXT
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
CREATE TABLE IF NOT EXISTS explore_area_materials (
    material_id TEXT PRIMARY KEY,
    area_id TEXT NOT NULL REFERENCES explore_areas(id) ON DELETE CASCADE,
    origin TEXT NOT NULL CHECK(origin IN ('agent','user')),
    labelled_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS explore_area_materials_area ON explore_area_materials(area_id);
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


def _v2(connection: sqlite3.Connection) -> None:
    """Idempotent (an ALTER commits on its own; a start cut before the version row re-runs this — R2-02)."""
    present = {row[1] for row in connection.execute("PRAGMA table_info(explore_areas)")}
    if "mapping_state" not in present:
        connection.execute(
            "ALTER TABLE explore_areas ADD COLUMN mapping_state TEXT NOT NULL DEFAULT 'pending'"
            " CHECK(mapping_state IN ('pending','mapped','no_match'))"
        )
    if "mapped_name" not in present:
        connection.execute("ALTER TABLE explore_areas ADD COLUMN mapped_name TEXT")
    connection.execute(
        "CREATE TABLE IF NOT EXISTS explore_area_materials (material_id TEXT PRIMARY KEY,"
        " area_id TEXT NOT NULL REFERENCES explore_areas(id) ON DELETE CASCADE,"
        " origin TEXT NOT NULL CHECK(origin IN ('agent','user')),"
        " labelled_at TEXT NOT NULL)"
    )
    connection.execute(
        "CREATE INDEX IF NOT EXISTS explore_area_materials_area ON explore_area_materials(area_id)"
    )
    # A custom area of a build before EX2 was made from OpenAlex topics: those are its hidden label already.
    has_topics = connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'explore_area_topics'"
    ).fetchone()
    if has_topics is None:
        return
    connection.execute(
        "UPDATE explore_areas SET mapping_state = 'mapped', mapped_name = name "
        "WHERE level = 'custom' AND mapping_state = 'pending' "
        "AND EXISTS (SELECT 1 FROM explore_area_topics t WHERE t.area_id = explore_areas.id)"
    )


def _v3(connection: sqlite3.Connection) -> None:
    """Idempotent: a no-match with a kept reason (stored by v3 code) is never retried here."""
    present = {row[1] for row in connection.execute("PRAGMA table_info(explore_areas)")}
    if "mapping_reason" not in present:
        connection.execute("ALTER TABLE explore_areas ADD COLUMN mapping_reason TEXT")
    connection.execute(
        "UPDATE explore_areas SET mapping_state = 'pending' "
        "WHERE level = 'custom' AND mapping_state = 'no_match' AND mapping_reason IS NULL"
    )


UPGRADES: dict[int, Callable[[sqlite3.Connection], None]] = {2: _v2, 3: _v3}
