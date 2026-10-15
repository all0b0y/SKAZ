"""Speech carriers (area S2): which legacy recording/import session feeds which material.

Service data, not rebuilt from files by the index scan; the speech service
restores a missing row from ``origin.session_id`` in ``material.json``.
"""
from __future__ import annotations

NAME = "speech"
VERSION = 1

SQL = """
CREATE TABLE IF NOT EXISTS speech_carriers (
    material_id   TEXT PRIMARY KEY,
    session_id    TEXT NOT NULL UNIQUE,
    kind          TEXT NOT NULL CHECK (kind IN ('recording', 'audio', 'video', 'video_link')),
    created_at    TEXT NOT NULL,
    -- The last recognition attempt's problem, in plain English; NULL when it went fine.
    attempt_error TEXT
);
"""
