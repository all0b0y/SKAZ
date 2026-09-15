"""Versioned additive migrations; old transcript/source tables remain intact."""
from __future__ import annotations

import sqlite3

_NATIVE_LIVE_V1 = (
    """CREATE TABLE native_recordings (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        sample_rate INTEGER NOT NULL CHECK(sample_rate BETWEEN 8000 AND 48000),
        saved_samples INTEGER NOT NULL DEFAULT 0,
        next_sequence INTEGER NOT NULL DEFAULT 0
    )""",
    """CREATE TABLE asr_connections (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES native_recordings(session_id) ON DELETE CASCADE,
        start_sample INTEGER NOT NULL,
        end_sample INTEGER,
        model TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active','finished','incomplete')),
        final_sample INTEGER NOT NULL,
        processed_sample INTEGER NOT NULL,
        next_event INTEGER NOT NULL DEFAULT 0,
        draft_json TEXT NOT NULL DEFAULT '[]'
    )""",
    "CREATE UNIQUE INDEX one_active_asr ON asr_connections(session_id) WHERE status='active'",
    """CREATE TABLE native_audio_blocks (
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        start_sample INTEGER NOT NULL,
        end_sample INTEGER NOT NULL,
        PRIMARY KEY(session_id, sequence),
        FOREIGN KEY(session_id, sequence) REFERENCES chunks(session_id, sequence) ON DELETE CASCADE
    )""",
    """CREATE TABLE native_asr_events (
        connection_id TEXT NOT NULL REFERENCES asr_connections(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        digest TEXT NOT NULL,
        segment_ids TEXT NOT NULL,
        PRIMARY KEY(connection_id, ordinal)
    )""",
    """CREATE TABLE transcript_revisions (
        segment_id TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        text TEXT NOT NULL,
        origin TEXT NOT NULL CHECK(origin IN ('soniox','user')),
        PRIMARY KEY(segment_id, revision)
    )""",
)


_NATIVE_TOKENS_V2 = (
    """CREATE TABLE native_speakers (
        connection_id TEXT NOT NULL REFERENCES asr_connections(id) ON DELETE CASCADE,
        provider_id TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES native_recordings(session_id) ON DELETE CASCADE,
        number INTEGER NOT NULL CHECK(number > 0),
        PRIMARY KEY(connection_id, provider_id),
        UNIQUE(session_id, number)
    )""",
    """CREATE TABLE native_token_events (
        connection_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        tokens_json TEXT NOT NULL,
        PRIMARY KEY(connection_id, ordinal),
        FOREIGN KEY(connection_id, ordinal)
            REFERENCES native_asr_events(connection_id, ordinal) ON DELETE CASCADE
    )""",
)


_NATIVE_TRANSLATION_V3 = (
    "ALTER TABLE asr_connections ADD COLUMN translation_draft_json TEXT NOT NULL DEFAULT '[]'",
    """CREATE TABLE native_translation_events (
        connection_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        tokens_json TEXT NOT NULL,
        PRIMARY KEY(connection_id, ordinal),
        FOREIGN KEY(connection_id, ordinal)
            REFERENCES native_asr_events(connection_id, ordinal) ON DELETE CASCADE
    )""",
)


_NATIVE_RECORDING_CONFIG_V4 = (
    "ALTER TABLE native_recordings ADD COLUMN recording_mode TEXT NOT NULL DEFAULT 'transcription' "
    "CHECK(recording_mode IN ('transcription','translation','audio_only'))",
    "ALTER TABLE native_recordings ADD COLUMN translation_target_language TEXT NOT NULL DEFAULT 'ru'",
)


_NATIVE_STREAM_ORDER_V5 = (
    "ALTER TABLE asr_connections ADD COLUMN stream_draft_json TEXT NOT NULL DEFAULT '[]'",
    """CREATE TABLE native_stream_events (
        connection_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        tokens_json TEXT NOT NULL,
        PRIMARY KEY(connection_id, ordinal),
        FOREIGN KEY(connection_id, ordinal)
            REFERENCES native_asr_events(connection_id, ordinal) ON DELETE CASCADE
    )""",
)


_NATIVE_LANGUAGES_V6 = (
    "ALTER TABLE native_recordings ADD COLUMN used_languages_json TEXT",
)


def migrate_native_live(connection: sqlite3.Connection) -> None:
    connection.execute("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY)")
    for name, statements in (
        ("native_live_v1", _NATIVE_LIVE_V1), ("native_tokens_v2", _NATIVE_TOKENS_V2),
        ("native_translation_v3", _NATIVE_TRANSLATION_V3),
        ("native_recording_config_v4", _NATIVE_RECORDING_CONFIG_V4),
        ("native_stream_order_v5", _NATIVE_STREAM_ORDER_V5),
        ("native_languages_v6", _NATIVE_LANGUAGES_V6),
    ):
        if connection.execute("SELECT 1 FROM schema_migrations WHERE name=?", (name,)).fetchone():
            continue
        for statement in statements:
            connection.execute(statement)
        connection.execute("INSERT INTO schema_migrations(name) VALUES (?)", (name,))
