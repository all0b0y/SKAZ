"""SQLite storage.

Single local user, small data volume: a synchronous connection guarded by a lock
is simpler and fast enough. Long-running work (ASR, LLM calls) happens outside
the lock, so the connection is never held across an await.
"""

from __future__ import annotations

import sqlite3
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from .migrations import migrate_native_live

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    status      TEXT NOT NULL,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    mode        TEXT NOT NULL DEFAULT 'legacy' CHECK (mode IN ('legacy', 'contextual_local'))
);

CREATE TABLE IF NOT EXISTS chunks (
    session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    sequence    INTEGER NOT NULL,
    start_ms    INTEGER NOT NULL,
    end_ms      INTEGER NOT NULL,
    sha256      TEXT NOT NULL,
    path        TEXT NOT NULL,
    status      TEXT NOT NULL,
    error       TEXT,
    created_at  TEXT NOT NULL,
    PRIMARY KEY (session_id, sequence)
);

CREATE TABLE IF NOT EXISTS segments (
    id          TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    sequence    INTEGER NOT NULL,
    start_ms    INTEGER NOT NULL,
    end_ms      INTEGER NOT NULL,
    text        TEXT NOT NULL,
    language    TEXT,
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS segments_by_time ON segments(session_id, start_ms, end_ms);

CREATE VIRTUAL TABLE IF NOT EXISTS segments_fts USING fts5(segment_id UNINDEXED, session_id UNINDEXED, text);

-- New live-final segments may span several archived chunks. These sample ranges
-- describe the authenticated decoder snapshot, not exact spoken-word boundaries.
CREATE TABLE IF NOT EXISTS segment_sources (
    segment_id   TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
    session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    sequence     INTEGER NOT NULL,
    sample_start INTEGER NOT NULL CHECK (sample_start >= 0),
    sample_end   INTEGER NOT NULL CHECK (sample_end > sample_start),
    sha256       TEXT NOT NULL,
    PRIMARY KEY (segment_id, sequence),
    FOREIGN KEY (session_id, sequence) REFERENCES chunks(session_id, sequence) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS segment_sources_by_chunk
ON segment_sources(session_id, sequence, segment_id);

CREATE TABLE IF NOT EXISTS messages (
    id         TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role       TEXT NOT NULL,
    content    TEXT NOT NULL,
    created_at TEXT NOT NULL,
    citations  TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS messages_by_session ON messages(session_id, created_at);

CREATE TABLE IF NOT EXISTS notes (
    id         TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    content    TEXT NOT NULL,
    created_at TEXT NOT NULL,
    model      TEXT NOT NULL,
    citations  TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS notes_by_session ON notes(session_id, created_at);

CREATE TABLE IF NOT EXISTS app_settings (
    id  INTEGER PRIMARY KEY CHECK (id = 1),
    doc TEXT NOT NULL
);

-- Monotonic generation for ASR-relevant settings. It invalidates an in-flight
-- result even when a profile is changed and then changed back before decode ends.
CREATE TABLE IF NOT EXISTS settings_revisions (
    scope    TEXT PRIMARY KEY CHECK (scope = 'asr'),
    revision INTEGER NOT NULL CHECK (revision >= 0)
);

-- A revisable ASR hypothesis is deliberately isolated from final segments/FTS.
CREATE TABLE IF NOT EXISTS live_asr_drafts (
    session_id         TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    revision           INTEGER NOT NULL CHECK (revision > 0),
    epoch              INTEGER NOT NULL CHECK (epoch > 0),
    first_sequence     INTEGER NOT NULL CHECK (first_sequence >= 0),
    last_sequence      INTEGER NOT NULL CHECK (last_sequence >= first_sequence),
    source_fingerprint TEXT NOT NULL,
    config_fingerprint TEXT NOT NULL,
    config_revision    INTEGER NOT NULL CHECK (config_revision >= 0),
    snapshot_json      TEXT NOT NULL,
    updated_at         TEXT NOT NULL
);

-- Private consecutive-hypothesis evidence and the monotonic committed frontier.
-- Draft text remains in live_asr_drafts; final text remains only in segments/FTS.
CREATE TABLE IF NOT EXISTS live_asr_finality (
    session_id               TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    stable_text              TEXT NOT NULL DEFAULT '',
    stable_tokens_json       TEXT NOT NULL DEFAULT '[]',
    stable_frontier_ms       INTEGER NOT NULL DEFAULT 0 CHECK (stable_frontier_ms >= 0),
    active_anchor_ms         INTEGER NOT NULL DEFAULT 0 CHECK (active_anchor_ms >= 0),
    stable_token_offset      INTEGER NOT NULL DEFAULT 0 CHECK (stable_token_offset >= 0),
    agreement_epoch          INTEGER NOT NULL CHECK (agreement_epoch > 0),
    previous_window_start_ms INTEGER,
    previous_window_end_ms   INTEGER,
    previous_words_json      TEXT NOT NULL DEFAULT '[]',
    last_revision            INTEGER NOT NULL DEFAULT 0 CHECK (last_revision >= 0),
    last_segment_ids_json    TEXT NOT NULL DEFAULT '[]',
    updated_at               TEXT NOT NULL
);

-- Stable absolute-range identities for the currently revisable contextual text.
-- Human text is deliberately independent of word timestamps; source rows bind the
-- entire protected acoustic range instead.
CREATE TABLE IF NOT EXISTS live_asr_fragments (
    fragment_id          TEXT PRIMARY KEY,
    session_id           TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    ordinal              INTEGER NOT NULL CHECK (ordinal >= 0),
    start_ms             INTEGER NOT NULL CHECK (start_ms >= 0),
    observed_end_ms      INTEGER NOT NULL CHECK (observed_end_ms > start_ms),
    protected_through_ms INTEGER NOT NULL CHECK (protected_through_ms >= observed_end_ms),
    text                 TEXT NOT NULL CHECK (length(trim(text)) > 0),
    language             TEXT,
    state                TEXT NOT NULL CHECK (state IN ('open', 'complete', 'error')),
    state_reason         TEXT,
    revision             INTEGER NOT NULL CHECK (revision > 0),
    draft_revision       INTEGER NOT NULL CHECK (draft_revision > 0),
    config_revision      INTEGER NOT NULL CHECK (config_revision >= 0),
    protected            INTEGER NOT NULL DEFAULT 0 CHECK (protected IN (0, 1)),
    completion_provenance TEXT CHECK (
        completion_provenance IS NULL OR completion_provenance IN ('live_agreement', 'source_ended_final_pass', 'ordinary_recovery')
    ),
    segment_id           TEXT REFERENCES segments(id) ON DELETE RESTRICT,
    accepted_at          TEXT,
    accepted_key         TEXT,
    updated_at           TEXT NOT NULL,
    UNIQUE(session_id, ordinal)
);
CREATE INDEX IF NOT EXISTS live_asr_fragments_by_range
ON live_asr_fragments(session_id, start_ms, ordinal);

CREATE TABLE IF NOT EXISTS live_asr_fragment_sources (
    fragment_id  TEXT NOT NULL REFERENCES live_asr_fragments(fragment_id) ON DELETE CASCADE,
    session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    sequence     INTEGER NOT NULL,
    sample_start INTEGER NOT NULL CHECK (sample_start >= 0),
    sample_end   INTEGER NOT NULL CHECK (sample_end > sample_start),
    sha256       TEXT NOT NULL,
    PRIMARY KEY (fragment_id, sequence),
    FOREIGN KEY (session_id, sequence) REFERENCES chunks(session_id, sequence) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS live_asr_fragment_sources_by_chunk
ON live_asr_fragment_sources(session_id, sequence, fragment_id);

-- Capability provenance: written only after a real successful provider call.
CREATE TABLE IF NOT EXISTS verifications (
    provider    TEXT NOT NULL,
    model       TEXT NOT NULL,
    task        TEXT NOT NULL,
    verified_at TEXT NOT NULL,
    detail      TEXT NOT NULL,
    PRIMARY KEY (provider, model, task)
);
"""


class Database:
    """Thread-safe wrapper around one SQLite connection."""

    def __init__(self, path: Path | str) -> None:
        self._lock = threading.RLock()
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._connection = sqlite3.connect(str(path), check_same_thread=False)
        self._connection.row_factory = sqlite3.Row
        with self._lock:
            self._connection.execute("PRAGMA journal_mode=WAL")
            self._connection.execute("PRAGMA synchronous=FULL")
            self._connection.execute("PRAGMA fullfsync=ON")
            self._connection.execute("PRAGMA foreign_keys=ON")
            self._connection.executescript(SCHEMA)
            self._migrate_session_mode()
            self._migrate_live_asr_finality()
            migrate_native_live(self._connection)
            self._connection.commit()

    def _migrate_session_mode(self) -> None:
        columns = {row["name"] for row in self._connection.execute("PRAGMA table_info(sessions)")}
        if "mode" not in columns:
            self._connection.execute(
                "ALTER TABLE sessions ADD COLUMN mode TEXT NOT NULL DEFAULT 'legacy'"
            )

    def _migrate_live_asr_finality(self) -> None:
        columns = {
            row["name"]
            for row in self._connection.execute("PRAGMA table_info(live_asr_finality)")
        }
        if "active_anchor_ms" not in columns:
            self._connection.execute(
                "ALTER TABLE live_asr_finality ADD COLUMN "
                "active_anchor_ms INTEGER NOT NULL DEFAULT 0 CHECK (active_anchor_ms >= 0)"
            )
            self._connection.execute(
                "UPDATE live_asr_finality "
                "SET active_anchor_ms=COALESCE(previous_window_start_ms, 0)"
            )
        if "stable_token_offset" not in columns:
            self._connection.execute(
                "ALTER TABLE live_asr_finality ADD COLUMN "
                "stable_token_offset INTEGER NOT NULL DEFAULT 0 "
                "CHECK (stable_token_offset >= 0)"
            )

    @contextmanager
    def write(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            try:
                yield self._connection
                self._connection.commit()
            except Exception:
                self._connection.rollback()
                raise

    @contextmanager
    def read(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            yield self._connection

    def close(self) -> None:
        with self._lock:
            self._connection.close()
