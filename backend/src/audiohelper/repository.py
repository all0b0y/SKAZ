"""SQLite persistence for sessions, chunks, segments, messages and notes."""

from __future__ import annotations

import json
import sqlite3
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal

from .db import Database
from .schemas import (
    AudioChunkStatus,
    Citation,
    Message,
    Note,
    Segment,
    SegmentSource,
    Session,
    SessionMode,
    SessionStatus,
)

CHUNK_PENDING: AudioChunkStatus = "pending"
CHUNK_DONE: AudioChunkStatus = "done"
CHUNK_FAILED: AudioChunkStatus = "failed"


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds")


def _new_id() -> str:
    return uuid.uuid4().hex


@dataclass(frozen=True)
class ChunkRecord:
    session_id: str
    sequence: int
    start_ms: int
    end_ms: int
    sha256: str
    path: str
    status: AudioChunkStatus
    error: str | None


@dataclass
class ChunkManifestRecord:
    sequence: int
    start_ms: int
    end_ms: int
    path: str
    status: AudioChunkStatus
    segment_ids: list[str]


@dataclass(frozen=True)
class LiveAsrDraftRecord:
    session_id: str
    revision: int
    epoch: int
    first_sequence: int
    last_sequence: int
    source_fingerprint: str
    config_fingerprint: str
    config_revision: int
    snapshot_json: str
    updated_at: str


@dataclass(frozen=True)
class LiveAsrFinalityRecord:
    session_id: str
    stable_text: str
    stable_tokens_json: str
    stable_frontier_ms: int
    active_anchor_ms: int
    stable_token_offset: int
    agreement_epoch: int
    previous_window_start_ms: int | None
    previous_window_end_ms: int | None
    previous_words_json: str
    last_revision: int
    last_segment_ids_json: str
    updated_at: str


@dataclass(frozen=True)
class SegmentSourceRecord:
    sequence: int
    sample_start: int
    sample_end: int
    sha256: str


@dataclass(frozen=True)
class LiveAsrFragmentRecord:
    fragment_id: str
    session_id: str
    ordinal: int
    start_ms: int
    observed_end_ms: int
    protected_through_ms: int
    text: str
    language: str | None
    state: Literal["open", "complete", "error"]
    state_reason: str | None
    revision: int
    draft_revision: int
    config_revision: int
    protected: bool
    completion_provenance: str | None
    segment_id: str | None
    accepted_at: str | None
    accepted_key: str | None
    updated_at: str


@dataclass(frozen=True)
class OpenFragmentWrite:
    start_ms: int
    observed_end_ms: int
    text: str
    language: str | None
    draft_revision: int
    config_revision: int
    sources: tuple[SegmentSourceRecord, ...]


@dataclass(frozen=True)
class FragmentCompletion:
    fragment_id: str
    expected_revision: int
    provenance: Literal["live_agreement", "source_ended_final_pass", "ordinary_recovery"]


@dataclass(frozen=True)
class SourceEndedFragmentWrite:
    fragment_id: str
    expected_revision: int
    segment: Segment
    sources: tuple[SegmentSourceRecord, ...]
    replace_unprotected_range: bool = False


class LiveDraftWriteConflict(Exception):
    """The persisted revision changed after the update took its snapshot."""


class LiveDraftSessionMissing(Exception):
    """The owning session disappeared before the draft transaction committed."""


FinalWriterKind = Literal["legacy", "contextual", "native"]


class FinalWriterConflict(Exception):
    """A final transcript already belongs to the other immutable writer family."""

    def __init__(self, existing_writer: FinalWriterKind, requested_writer: FinalWriterKind) -> None:
        self.existing_writer = existing_writer
        self.requested_writer = requested_writer
        super().__init__(
            f"Session final transcript is owned by the {existing_writer} writer; "
            f"{requested_writer} finalization is not allowed."
        )


# --- sessions ---------------------------------------------------------------


def create_session(db: Database, title: str, mode: SessionMode = "legacy") -> Session:
    session = Session(
        id=_new_id(), title=title, created_at=_now(), status="recording", duration_ms=0, mode=mode
    )
    with db.write() as connection:
        connection.execute(
            "INSERT INTO sessions(id, title, created_at, status, duration_ms, mode) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (
                session.id,
                session.title,
                session.created_at,
                session.status,
                session.duration_ms,
                session.mode,
            ),
        )
    return session


def list_sessions(db: Database) -> list[Session]:
    with db.read() as connection:
        rows = connection.execute("SELECT * FROM sessions ORDER BY created_at DESC, rowid DESC").fetchall()
    return [_session(row) for row in rows]


def get_session(db: Database, session_id: str) -> Session | None:
    with db.read() as connection:
        row = connection.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
    return _session(row) if row else None


def update_session(
    db: Database, session_id: str, *, status: SessionStatus | None = None, title: str | None = None
) -> Session | None:
    assignments: list[str] = []
    values: list[object] = []
    if status is not None:
        assignments.append("status = ?")
        values.append(status)
    if title is not None:
        assignments.append("title = ?")
        values.append(title)
    if assignments:
        with db.write() as connection:
            cursor = connection.execute(
                f"UPDATE sessions SET {', '.join(assignments)} WHERE id = ?", (*values, session_id)
            )
            if cursor.rowcount == 0:
                return None
    return get_session(db, session_id)


def delete_session(db: Database, session_id: str) -> bool:
    with db.write() as connection:
        connection.execute("DELETE FROM segments_fts WHERE session_id = ?", (session_id,))
        cursor = connection.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
        return cursor.rowcount > 0


def extend_duration(db: Database, session_id: str, end_ms: int) -> None:
    with db.write() as connection:
        connection.execute(
            "UPDATE sessions SET duration_ms = MAX(duration_ms, ?) WHERE id = ?", (end_ms, session_id)
        )


def _session(row: sqlite3.Row) -> Session:
    return Session(
        id=row["id"],
        title=row["title"],
        created_at=row["created_at"],
        status=row["status"],
        duration_ms=row["duration_ms"],
        mode=row["mode"],
    )


def has_legacy_segments(db: Database, session_id: str) -> bool:
    with db.read() as connection:
        row = connection.execute(
            """
            SELECT 1 FROM segments
            WHERE session_id = ?
              AND NOT EXISTS (
                  SELECT 1 FROM segment_sources
                  WHERE segment_sources.segment_id = segments.id
              )
            LIMIT 1
            """,
            (session_id,),
        ).fetchone()
    return row is not None


def _assert_final_writer_available(
    connection: sqlite3.Connection, session_id: str, requested_writer: FinalWriterKind
) -> None:
    if connection.execute(
        "SELECT 1 FROM native_recordings WHERE session_id=?", (session_id,)
    ).fetchone():
        raise FinalWriterConflict("native", requested_writer)
    if requested_writer == "legacy":
        opposite: FinalWriterKind = "contextual"
        association_clause = "EXISTS"
    else:
        opposite = "legacy"
        association_clause = "NOT EXISTS"
    row = connection.execute(
        f"""
        SELECT 1 FROM segments
        WHERE session_id = ?
          AND {association_clause} (
              SELECT 1 FROM segment_sources
              WHERE segment_sources.segment_id = segments.id
          )
        LIMIT 1
        """,
        (session_id,),
    ).fetchone()
    if row is not None:
        raise FinalWriterConflict(opposite, requested_writer)


def assert_final_writer_available(
    db: Database, session_id: str, requested_writer: FinalWriterKind
) -> None:
    """Fail-fast ownership check; final write transactions repeat this check atomically."""
    with db.read() as connection:
        _assert_final_writer_available(connection, session_id, requested_writer)


# --- live ASR draft ---------------------------------------------------------


def get_live_asr_draft(db: Database, session_id: str) -> LiveAsrDraftRecord | None:
    with db.read() as connection:
        row = connection.execute(
            "SELECT * FROM live_asr_drafts WHERE session_id = ?", (session_id,)
        ).fetchone()
    if row is None:
        return None
    return LiveAsrDraftRecord(
        session_id=row["session_id"],
        revision=row["revision"],
        epoch=row["epoch"],
        first_sequence=row["first_sequence"],
        last_sequence=row["last_sequence"],
        source_fingerprint=row["source_fingerprint"],
        config_fingerprint=row["config_fingerprint"],
        config_revision=row["config_revision"],
        snapshot_json=row["snapshot_json"],
        updated_at=row["updated_at"],
    )


def write_live_asr_draft(
    db: Database,
    draft: LiveAsrDraftRecord,
    *,
    expected_revision: int | None,
    expected_config_revision: int,
) -> None:
    """CAS one draft without ever touching final transcript tables."""
    with db.write() as connection:
        session = connection.execute(
            "SELECT 1 FROM sessions WHERE id = ?", (draft.session_id,)
        ).fetchone()
        if session is None:
            raise LiveDraftSessionMissing
        _assert_final_writer_available(connection, draft.session_id, "contextual")
        settings_row = connection.execute(
            "SELECT revision FROM settings_revisions WHERE scope = 'asr'"
        ).fetchone()
        settings_revision = int(settings_row["revision"]) if settings_row is not None else 0
        if settings_revision != expected_config_revision:
            raise LiveDraftWriteConflict
        current = connection.execute(
            "SELECT revision FROM live_asr_drafts WHERE session_id = ?", (draft.session_id,)
        ).fetchone()
        current_revision = int(current["revision"]) if current is not None else None
        if current_revision != expected_revision:
            raise LiveDraftWriteConflict
        connection.execute(
            """
            INSERT INTO live_asr_drafts(
                session_id, revision, epoch, first_sequence, last_sequence,
                source_fingerprint, config_fingerprint, config_revision,
                snapshot_json, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
                revision = excluded.revision,
                epoch = excluded.epoch,
                first_sequence = excluded.first_sequence,
                last_sequence = excluded.last_sequence,
                source_fingerprint = excluded.source_fingerprint,
                config_fingerprint = excluded.config_fingerprint,
                config_revision = excluded.config_revision,
                snapshot_json = excluded.snapshot_json,
                updated_at = excluded.updated_at
            """,
            (
                draft.session_id,
                draft.revision,
                draft.epoch,
                draft.first_sequence,
                draft.last_sequence,
                draft.source_fingerprint,
                draft.config_fingerprint,
                draft.config_revision,
                draft.snapshot_json,
                draft.updated_at,
            ),
        )


def get_live_asr_finality(db: Database, session_id: str) -> LiveAsrFinalityRecord | None:
    with db.read() as connection:
        row = connection.execute(
            "SELECT * FROM live_asr_finality WHERE session_id = ?", (session_id,)
        ).fetchone()
    if row is None:
        return None
    return LiveAsrFinalityRecord(
        session_id=row["session_id"],
        stable_text=row["stable_text"],
        stable_tokens_json=row["stable_tokens_json"],
        stable_frontier_ms=row["stable_frontier_ms"],
        active_anchor_ms=row["active_anchor_ms"],
        stable_token_offset=row["stable_token_offset"],
        agreement_epoch=row["agreement_epoch"],
        previous_window_start_ms=row["previous_window_start_ms"],
        previous_window_end_ms=row["previous_window_end_ms"],
        previous_words_json=row["previous_words_json"],
        last_revision=row["last_revision"],
        last_segment_ids_json=row["last_segment_ids_json"],
        updated_at=row["updated_at"],
    )


def _fragment_record(row: sqlite3.Row) -> LiveAsrFragmentRecord:
    return LiveAsrFragmentRecord(
        fragment_id=row["fragment_id"],
        session_id=row["session_id"],
        ordinal=row["ordinal"],
        start_ms=row["start_ms"],
        observed_end_ms=row["observed_end_ms"],
        protected_through_ms=row["protected_through_ms"],
        text=row["text"],
        language=row["language"],
        state=row["state"],
        state_reason=row["state_reason"],
        revision=row["revision"],
        draft_revision=row["draft_revision"],
        config_revision=row["config_revision"],
        protected=bool(row["protected"]),
        completion_provenance=row["completion_provenance"],
        segment_id=row["segment_id"],
        accepted_at=row["accepted_at"],
        accepted_key=row["accepted_key"],
        updated_at=row["updated_at"],
    )


def get_live_asr_fragment(
    db: Database, session_id: str, fragment_id: str
) -> LiveAsrFragmentRecord | None:
    with db.read() as connection:
        row = connection.execute(
            "SELECT * FROM live_asr_fragments WHERE session_id=? AND fragment_id=?",
            (session_id, fragment_id),
        ).fetchone()
    return _fragment_record(row) if row is not None else None


def list_live_asr_fragments(db: Database, session_id: str) -> list[LiveAsrFragmentRecord]:
    with db.read() as connection:
        rows = connection.execute(
            "SELECT * FROM live_asr_fragments WHERE session_id=? ORDER BY ordinal",
            (session_id,),
        ).fetchall()
    return [_fragment_record(row) for row in rows]


def fragment_sources(
    db: Database, fragment_id: str
) -> list[SegmentSourceRecord]:
    with db.read() as connection:
        rows = connection.execute(
            """
            SELECT sequence, sample_start, sample_end, sha256
            FROM live_asr_fragment_sources WHERE fragment_id=? ORDER BY sequence
            """,
            (fragment_id,),
        ).fetchall()
    return [
        SegmentSourceRecord(
            sequence=row["sequence"],
            sample_start=row["sample_start"],
            sample_end=row["sample_end"],
            sha256=row["sha256"],
        )
        for row in rows
    ]


def latest_protected_open_fragment(
    db: Database, session_id: str
) -> LiveAsrFragmentRecord | None:
    with db.read() as connection:
        row = connection.execute(
            """
            SELECT * FROM live_asr_fragments
            WHERE session_id=? AND state='open' AND protected=1
            ORDER BY ordinal LIMIT 1
            """,
            (session_id,),
        ).fetchone()
    return _fragment_record(row) if row is not None else None


def fragment_guard(db: Database, session_id: str) -> str:
    with db.read() as connection:
        return _fragment_guard(connection, session_id)


def _fragment_guard(connection: sqlite3.Connection, session_id: str) -> str:
    rows = connection.execute(
        "SELECT fragment_id, revision, state FROM live_asr_fragments "
        "WHERE session_id=? ORDER BY ordinal",
        (session_id,),
    ).fetchall()
    return json.dumps([tuple(row) for row in rows], separators=(",", ":"))


def edit_live_asr_fragment(
    db: Database,
    session_id: str,
    fragment_id: str,
    *,
    expected_revision: int,
    text: str,
) -> LiveAsrFragmentRecord | None:
    with db.write() as connection:
        row = connection.execute(
            "SELECT * FROM live_asr_fragments WHERE session_id=? AND fragment_id=?",
            (session_id, fragment_id),
        ).fetchone()
        if row is None:
            return None
        if int(row["revision"]) != expected_revision or row["state"] == "complete":
            raise LiveDraftWriteConflict
        connection.execute(
            """
            UPDATE live_asr_fragments
            SET text=?, protected=1, state='open', state_reason=NULL,
                revision=revision+1, accepted_at=NULL, accepted_key=NULL, updated_at=?
            WHERE fragment_id=?
            """,
            (text, _now(), fragment_id),
        )
        updated = connection.execute(
            "SELECT * FROM live_asr_fragments WHERE fragment_id=?", (fragment_id,)
        ).fetchone()
    assert updated is not None
    return _fragment_record(updated)


def accept_live_asr_fragment(
    db: Database,
    session_id: str,
    fragment_id: str,
    *,
    expected_revision: int,
    idempotency_key: str,
) -> LiveAsrFragmentRecord | None:
    with db.write() as connection:
        row = connection.execute(
            "SELECT * FROM live_asr_fragments WHERE session_id=? AND fragment_id=?",
            (session_id, fragment_id),
        ).fetchone()
        if row is None:
            return None
        if row["accepted_key"] == idempotency_key and int(row["revision"]) == expected_revision + 1:
            return _fragment_record(row)
        if int(row["revision"]) != expected_revision:
            raise LiveDraftWriteConflict
        if row["state"] != "complete":
            raise ValueError("Fragment processing is not complete.")
        connection.execute(
            """
            UPDATE live_asr_fragments
            SET accepted_at=?, accepted_key=?, revision=revision+1, updated_at=?
            WHERE fragment_id=?
            """,
            (_now(), idempotency_key, _now(), fragment_id),
        )
        updated = connection.execute(
            "SELECT * FROM live_asr_fragments WHERE fragment_id=?", (fragment_id,)
        ).fetchone()
    assert updated is not None
    return _fragment_record(updated)


def write_live_asr_final_update(
    db: Database,
    draft: LiveAsrDraftRecord,
    finality: LiveAsrFinalityRecord,
    *,
    expected_revision: int | None,
    expected_config_revision: int,
    segment: Segment | None,
    sources: list[SegmentSourceRecord],
    expected_fragment_guard: str = "[]",
    open_fragment: OpenFragmentWrite | None = None,
    fragment_completion: FragmentCompletion | None = None,
) -> None:
    """Atomically CAS draft/frontier and optionally insert one immutable final."""
    with db.write() as connection:
        session = connection.execute(
            "SELECT 1 FROM sessions WHERE id = ?", (draft.session_id,)
        ).fetchone()
        if session is None:
            raise LiveDraftSessionMissing
        _assert_final_writer_available(connection, draft.session_id, "contextual")
        settings_row = connection.execute(
            "SELECT revision FROM settings_revisions WHERE scope = 'asr'"
        ).fetchone()
        settings_revision = int(settings_row["revision"]) if settings_row is not None else 0
        if settings_revision != expected_config_revision:
            raise LiveDraftWriteConflict
        current = connection.execute(
            "SELECT revision FROM live_asr_drafts WHERE session_id = ?", (draft.session_id,)
        ).fetchone()
        current_revision = int(current["revision"]) if current is not None else None
        if current_revision != expected_revision:
            raise LiveDraftWriteConflict
        if _fragment_guard(connection, draft.session_id) != expected_fragment_guard:
            raise LiveDraftWriteConflict

        if segment is not None:
            if not sources:
                raise ValueError("A live final segment requires source provenance.")
            connection.execute(
                """
                INSERT INTO segments(id, session_id, sequence, start_ms, end_ms, text, language, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    segment.id,
                    draft.session_id,
                    sources[0].sequence,
                    segment.start_ms,
                    segment.end_ms,
                    segment.text,
                    segment.language,
                    finality.updated_at,
                ),
            )
            connection.execute(
                "INSERT INTO segments_fts(segment_id, session_id, text) VALUES (?, ?, ?)",
                (segment.id, draft.session_id, segment.text),
            )
            for source in sources:
                connection.execute(
                    """
                    INSERT INTO segment_sources(
                        segment_id, session_id, sequence, sample_start, sample_end, sha256
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        segment.id,
                        draft.session_id,
                        source.sequence,
                        source.sample_start,
                        source.sample_end,
                        source.sha256,
                    ),
                )


            if fragment_completion is not None:
                fragment_row = connection.execute(
                    "SELECT * FROM live_asr_fragments WHERE fragment_id=? AND session_id=?",
                    (fragment_completion.fragment_id, draft.session_id),
                ).fetchone()
                if (
                    fragment_row is None
                    or int(fragment_row["revision"]) != fragment_completion.expected_revision
                    or fragment_row["state"] != "open"
                ):
                    raise LiveDraftWriteConflict
                if not bool(fragment_row["protected"]):
                    connection.execute(
                        """
                        UPDATE live_asr_fragments
                        SET start_ms=?, observed_end_ms=?, protected_through_ms=?,
                            text=?, language=?
                        WHERE fragment_id=?
                        """,
                        (
                            segment.start_ms,
                            segment.end_ms,
                            segment.end_ms,
                            segment.text,
                            segment.language,
                            fragment_completion.fragment_id,
                        ),
                    )
                    connection.execute(
                        "DELETE FROM live_asr_fragment_sources WHERE fragment_id=?",
                        (fragment_completion.fragment_id,),
                    )
                    for source in sources:
                        connection.execute(
                            """
                            INSERT INTO live_asr_fragment_sources(
                                fragment_id, session_id, sequence, sample_start, sample_end, sha256
                            ) VALUES (?, ?, ?, ?, ?, ?)
                            """,
                            (
                                fragment_completion.fragment_id,
                                draft.session_id,
                                source.sequence,
                                source.sample_start,
                                source.sample_end,
                                source.sha256,
                            ),
                        )
                cursor = connection.execute(
                    """
                    UPDATE live_asr_fragments
                    SET state='complete', state_reason=NULL, revision=revision+1,
                        completion_provenance=?, segment_id=?, updated_at=?
                    WHERE fragment_id=? AND session_id=? AND revision=? AND state='open'
                    """,
                    (
                        fragment_completion.provenance,
                        segment.id,
                        finality.updated_at,
                        fragment_completion.fragment_id,
                        draft.session_id,
                        fragment_completion.expected_revision,
                    ),
                )
                if cursor.rowcount != 1:
                    raise LiveDraftWriteConflict
            else:
                # An unprotected ASR tail may be split as confidence advances.
                # It has no human-authored state, so replace its provisional row
                # with one completed immutable fragment plus the new tail below.
                connection.execute(
                    "DELETE FROM live_asr_fragments "
                    "WHERE session_id=? AND state='open' AND protected=0",
                    (draft.session_id,),
                )
                ordinal_row = connection.execute(
                    "SELECT COALESCE(MAX(ordinal), -1) + 1 FROM live_asr_fragments WHERE session_id=?",
                    (draft.session_id,),
                ).fetchone()
                completed_id = _new_id()
                connection.execute(
                    """
                    INSERT INTO live_asr_fragments(
                        fragment_id, session_id, ordinal, start_ms, observed_end_ms,
                        protected_through_ms, text, language, state, state_reason,
                        revision, draft_revision, config_revision, protected,
                        completion_provenance, segment_id, accepted_at, accepted_key, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'complete', NULL, 1, ?, ?, 0,
                              'live_agreement', ?, NULL, NULL, ?)
                    """,
                    (
                        completed_id,
                        draft.session_id,
                        int(ordinal_row[0]),
                        segment.start_ms,
                        segment.end_ms,
                        segment.end_ms,
                        segment.text,
                        segment.language,
                        draft.revision,
                        draft.config_revision,
                        segment.id,
                        finality.updated_at,
                    ),
                )
                for source in sources:
                    connection.execute(
                        """
                        INSERT INTO live_asr_fragment_sources(
                            fragment_id, session_id, sequence, sample_start, sample_end, sha256
                        ) VALUES (?, ?, ?, ?, ?, ?)
                        """,
                        (
                            completed_id,
                            draft.session_id,
                            source.sequence,
                            source.sample_start,
                            source.sample_end,
                            source.sha256,
                        ),
                    )

        connection.execute(
            """
            INSERT INTO live_asr_finality(
                session_id, stable_text, stable_tokens_json, stable_frontier_ms,
                active_anchor_ms, stable_token_offset, agreement_epoch,
                previous_window_start_ms, previous_window_end_ms, previous_words_json,
                last_revision, last_segment_ids_json, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
                stable_text=excluded.stable_text,
                stable_tokens_json=excluded.stable_tokens_json,
                stable_frontier_ms=excluded.stable_frontier_ms,
                active_anchor_ms=excluded.active_anchor_ms,
                stable_token_offset=excluded.stable_token_offset,
                agreement_epoch=excluded.agreement_epoch,
                previous_window_start_ms=excluded.previous_window_start_ms,
                previous_window_end_ms=excluded.previous_window_end_ms,
                previous_words_json=excluded.previous_words_json,
                last_revision=excluded.last_revision,
                last_segment_ids_json=excluded.last_segment_ids_json,
                updated_at=excluded.updated_at
            """,
            (
                finality.session_id,
                finality.stable_text,
                finality.stable_tokens_json,
                finality.stable_frontier_ms,
                finality.active_anchor_ms,
                finality.stable_token_offset,
                finality.agreement_epoch,
                finality.previous_window_start_ms,
                finality.previous_window_end_ms,
                finality.previous_words_json,
                finality.last_revision,
                finality.last_segment_ids_json,
                finality.updated_at,
            ),
        )

        if open_fragment is not None:
            existing = connection.execute(
                """
                SELECT * FROM live_asr_fragments
                WHERE session_id=? AND state='open' AND protected=0
                ORDER BY ordinal DESC LIMIT 1
                """,
                (draft.session_id,),
            ).fetchone()
            same_identity = bool(
                existing is not None
                and abs(int(existing["start_ms"]) - open_fragment.start_ms) <= 250
            )
            if same_identity:
                fragment_id = str(existing["fragment_id"])
                connection.execute(
                    """
                    UPDATE live_asr_fragments
                    SET start_ms=?, observed_end_ms=?, protected_through_ms=?, text=?,
                        language=?, revision=revision+1, draft_revision=?, config_revision=?,
                        state_reason=NULL, updated_at=?
                    WHERE fragment_id=?
                    """,
                    (
                        open_fragment.start_ms,
                        open_fragment.observed_end_ms,
                        open_fragment.observed_end_ms,
                        open_fragment.text,
                        open_fragment.language,
                        open_fragment.draft_revision,
                        open_fragment.config_revision,
                        finality.updated_at,
                        fragment_id,
                    ),
                )
                connection.execute(
                    "DELETE FROM live_asr_fragment_sources WHERE fragment_id=?",
                    (fragment_id,),
                )
            else:
                fragment_id = _new_id()
                ordinal_row = connection.execute(
                    "SELECT COALESCE(MAX(ordinal), -1) + 1 FROM live_asr_fragments WHERE session_id=?",
                    (draft.session_id,),
                ).fetchone()
                connection.execute(
                    """
                    INSERT INTO live_asr_fragments(
                        fragment_id, session_id, ordinal, start_ms, observed_end_ms,
                        protected_through_ms, text, language, state, state_reason,
                        revision, draft_revision, config_revision, protected,
                        completion_provenance, segment_id, accepted_at, accepted_key, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, 1, ?, ?, 0, NULL, NULL, NULL, NULL, ?)
                    """,
                    (
                        fragment_id,
                        draft.session_id,
                        int(ordinal_row[0]),
                        open_fragment.start_ms,
                        open_fragment.observed_end_ms,
                        open_fragment.observed_end_ms,
                        open_fragment.text,
                        open_fragment.language,
                        open_fragment.draft_revision,
                        open_fragment.config_revision,
                        finality.updated_at,
                    ),
                )
            for source in open_fragment.sources:
                connection.execute(
                    """
                    INSERT INTO live_asr_fragment_sources(
                        fragment_id, session_id, sequence, sample_start, sample_end, sha256
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        fragment_id,
                        draft.session_id,
                        source.sequence,
                        source.sample_start,
                        source.sample_end,
                        source.sha256,
                    ),
                )
        connection.execute(
            """
            INSERT INTO live_asr_drafts(
                session_id, revision, epoch, first_sequence, last_sequence,
                source_fingerprint, config_fingerprint, config_revision,
                snapshot_json, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
                revision=excluded.revision, epoch=excluded.epoch,
                first_sequence=excluded.first_sequence, last_sequence=excluded.last_sequence,
                source_fingerprint=excluded.source_fingerprint,
                config_fingerprint=excluded.config_fingerprint,
                config_revision=excluded.config_revision,
                snapshot_json=excluded.snapshot_json, updated_at=excluded.updated_at
            """,
            (
                draft.session_id,
                draft.revision,
                draft.epoch,
                draft.first_sequence,
                draft.last_sequence,
                draft.source_fingerprint,
                draft.config_fingerprint,
                draft.config_revision,
                draft.snapshot_json,
                draft.updated_at,
            ),
        )


def write_source_ended_finalization(
    db: Database,
    draft: LiveAsrDraftRecord,
    finality: LiveAsrFinalityRecord,
    *,
    expected_revision: int,
    expected_config_revision: int,
    expected_fragment_guard: str,
    fragments: tuple[SourceEndedFragmentWrite, ...],
) -> None:
    """Atomically finalize trusted EOF fragments without invoking the legacy writer."""
    if not fragments:
        raise ValueError("Source-ended finalization requires at least one fragment.")
    with db.write() as connection:
        session = connection.execute(
            "SELECT 1 FROM sessions WHERE id=?", (draft.session_id,)
        ).fetchone()
        settings = connection.execute(
            "SELECT revision FROM settings_revisions WHERE scope='asr'"
        ).fetchone()
        current = connection.execute(
            "SELECT revision FROM live_asr_drafts WHERE session_id=?", (draft.session_id,)
        ).fetchone()
        if session is None:
            raise LiveDraftSessionMissing
        _assert_final_writer_available(connection, draft.session_id, "contextual")
        if (
            (int(settings["revision"]) if settings is not None else 0)
            != expected_config_revision
            or current is None
            or int(current["revision"]) != expected_revision
            or _fragment_guard(connection, draft.session_id) != expected_fragment_guard
        ):
            raise LiveDraftWriteConflict

        for item in fragments:
            row = connection.execute(
                "SELECT * FROM live_asr_fragments WHERE session_id=? AND fragment_id=?",
                (draft.session_id, item.fragment_id),
            ).fetchone()
            if (
                row is None
                or int(row["revision"]) != item.expected_revision
                or row["state"] not in {"open", "error"}
                or not item.sources
            ):
                raise LiveDraftWriteConflict
            connection.execute(
                """
                INSERT INTO segments(id, session_id, sequence, start_ms, end_ms, text, language, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    item.segment.id,
                    draft.session_id,
                    item.sources[0].sequence,
                    item.segment.start_ms,
                    item.segment.end_ms,
                    item.segment.text,
                    item.segment.language,
                    finality.updated_at,
                ),
            )
            connection.execute(
                "INSERT INTO segments_fts(segment_id, session_id, text) VALUES (?, ?, ?)",
                (item.segment.id, draft.session_id, item.segment.text),
            )
            for source in item.sources:
                connection.execute(
                    """
                    INSERT INTO segment_sources(
                        segment_id, session_id, sequence, sample_start, sample_end, sha256
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        item.segment.id,
                        draft.session_id,
                        source.sequence,
                        source.sample_start,
                        source.sample_end,
                        source.sha256,
                    ),
                )
            if item.replace_unprotected_range:
                connection.execute(
                    """
                    UPDATE live_asr_fragments
                    SET start_ms=?, observed_end_ms=?, protected_through_ms=?, text=?, language=?
                    WHERE fragment_id=?
                    """,
                    (
                        item.segment.start_ms,
                        item.segment.end_ms,
                        item.segment.end_ms,
                        item.segment.text,
                        item.segment.language,
                        item.fragment_id,
                    ),
                )
                connection.execute(
                    "DELETE FROM live_asr_fragment_sources WHERE fragment_id=?",
                    (item.fragment_id,),
                )
                for source in item.sources:
                    connection.execute(
                        """
                        INSERT INTO live_asr_fragment_sources(
                            fragment_id, session_id, sequence, sample_start, sample_end, sha256
                        ) VALUES (?, ?, ?, ?, ?, ?)
                        """,
                        (
                            item.fragment_id,
                            draft.session_id,
                            source.sequence,
                            source.sample_start,
                            source.sample_end,
                            source.sha256,
                        ),
                    )
            connection.execute(
                """
                UPDATE live_asr_fragments
                SET state='complete', state_reason=NULL, revision=revision+1,
                    completion_provenance='source_ended_final_pass', segment_id=?, updated_at=?
                WHERE fragment_id=?
                """,
                (item.segment.id, finality.updated_at, item.fragment_id),
            )

        connection.execute(
            """
            INSERT INTO live_asr_finality(
                session_id, stable_text, stable_tokens_json, stable_frontier_ms,
                active_anchor_ms, stable_token_offset, agreement_epoch,
                previous_window_start_ms, previous_window_end_ms, previous_words_json,
                last_revision, last_segment_ids_json, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
                stable_text=excluded.stable_text,
                stable_tokens_json=excluded.stable_tokens_json,
                stable_frontier_ms=excluded.stable_frontier_ms,
                active_anchor_ms=excluded.active_anchor_ms,
                stable_token_offset=excluded.stable_token_offset,
                agreement_epoch=excluded.agreement_epoch,
                previous_window_start_ms=excluded.previous_window_start_ms,
                previous_window_end_ms=excluded.previous_window_end_ms,
                previous_words_json=excluded.previous_words_json,
                last_revision=excluded.last_revision,
                last_segment_ids_json=excluded.last_segment_ids_json,
                updated_at=excluded.updated_at
            """,
            (
                finality.session_id,
                finality.stable_text,
                finality.stable_tokens_json,
                finality.stable_frontier_ms,
                finality.active_anchor_ms,
                finality.stable_token_offset,
                finality.agreement_epoch,
                finality.previous_window_start_ms,
                finality.previous_window_end_ms,
                finality.previous_words_json,
                finality.last_revision,
                finality.last_segment_ids_json,
                finality.updated_at,
            ),
        )
        cursor = connection.execute(
            """
            UPDATE live_asr_drafts
            SET revision=?, epoch=?, first_sequence=?, last_sequence=?,
                source_fingerprint=?, config_fingerprint=?, config_revision=?,
                snapshot_json=?, updated_at=?
            WHERE session_id=? AND revision=?
            """,
            (
                draft.revision,
                draft.epoch,
                draft.first_sequence,
                draft.last_sequence,
                draft.source_fingerprint,
                draft.config_fingerprint,
                draft.config_revision,
                draft.snapshot_json,
                draft.updated_at,
                draft.session_id,
                expected_revision,
            ),
        )
        if cursor.rowcount != 1:
            raise LiveDraftWriteConflict


def mark_live_asr_fragments_error(db: Database, session_id: str, reason: str) -> None:
    with db.write() as connection:
        connection.execute(
            """
            UPDATE live_asr_fragments
            SET state='error', state_reason=?, revision=revision+1, updated_at=?
            WHERE session_id=? AND state='open'
            """,
            (reason, _now(), session_id),
        )


# --- chunks -----------------------------------------------------------------


def get_chunk(db: Database, session_id: str, sequence: int) -> ChunkRecord | None:
    with db.read() as connection:
        row = connection.execute(
            "SELECT * FROM chunks WHERE session_id = ? AND sequence = ?", (session_id, sequence)
        ).fetchone()
    if row is None:
        return None
    return ChunkRecord(
        session_id=row["session_id"],
        sequence=row["sequence"],
        start_ms=row["start_ms"],
        end_ms=row["end_ms"],
        sha256=row["sha256"],
        path=row["path"],
        status=row["status"],
        error=row["error"],
    )


def chunk_bounds(db: Database, session_id: str) -> tuple[ChunkRecord, ChunkRecord] | None:
    """Return the first/latest durable chunk without materialising an unbounded manifest."""
    with db.read() as connection:
        first = connection.execute(
            "SELECT * FROM chunks WHERE session_id = ? ORDER BY sequence LIMIT 1",
            (session_id,),
        ).fetchone()
        last = connection.execute(
            "SELECT * FROM chunks WHERE session_id = ? ORDER BY sequence DESC LIMIT 1",
            (session_id,),
        ).fetchone()
    if first is None or last is None:
        return None

    def record(row: sqlite3.Row) -> ChunkRecord:
        return ChunkRecord(
            session_id=row["session_id"],
            sequence=row["sequence"],
            start_ms=row["start_ms"],
            end_ms=row["end_ms"],
            sha256=row["sha256"],
            path=row["path"],
            status=row["status"],
            error=row["error"],
        )

    return record(first), record(last)


def chunks_in_sequence_range(
    db: Database, session_id: str, first_sequence: int, last_sequence: int, *, limit: int
) -> list[ChunkRecord]:
    """Read a bounded inclusive source interval in numeric sequence order."""
    with db.read() as connection:
        rows = connection.execute(
            """
            SELECT * FROM chunks
            WHERE session_id = ? AND sequence BETWEEN ? AND ?
            ORDER BY sequence
            LIMIT ?
            """,
            (session_id, first_sequence, last_sequence, limit),
        ).fetchall()
    return [
        ChunkRecord(
            session_id=row["session_id"],
            sequence=row["sequence"],
            start_ms=row["start_ms"],
            end_ms=row["end_ms"],
            sha256=row["sha256"],
            path=row["path"],
            status=row["status"],
            error=row["error"],
        )
        for row in rows
    ]


def insert_chunk(db: Database, chunk: ChunkRecord) -> bool:
    """Claim ``(session_id, sequence)``. False when another request claimed it first.

    Atomic so two concurrent uploads of the same sequence cannot both believe they
    own the slot and overwrite each other's stored audio.
    """
    with db.write() as connection:
        cursor = connection.execute(
            """
            INSERT INTO chunks(
                session_id, sequence, start_ms, end_ms, sha256, path, status, error, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_id, sequence) DO NOTHING
            """,
            (
                chunk.session_id,
                chunk.sequence,
                chunk.start_ms,
                chunk.end_ms,
                chunk.sha256,
                chunk.path,
                chunk.status,
                chunk.error,
                _now(),
            ),
        )
        return cursor.rowcount > 0


def delete_pending_chunk_claim(db: Database, session_id: str, sequence: int, sha256: str) -> bool:
    """Roll back a newly claimed row when its audio could not be persisted."""
    with db.write() as connection:
        cursor = connection.execute(
            """
            DELETE FROM chunks
            WHERE session_id = ? AND sequence = ? AND sha256 = ? AND status = ?
            """,
            (session_id, sequence, sha256, CHUNK_PENDING),
        )
        return cursor.rowcount > 0


def set_chunk_status(
    db: Database,
    session_id: str,
    sequence: int,
    status: AudioChunkStatus,
    error: str | None,
) -> None:
    with db.write() as connection:
        connection.execute(
            "UPDATE chunks SET status = ?, error = ? WHERE session_id = ? AND sequence = ?",
            (status, error, session_id, sequence),
        )


def unfinished_chunks(db: Database, session_id: str) -> list[ChunkRecord]:
    """Chunks whose audio is stored but whose transcript is missing, oldest first."""
    with db.read() as connection:
        rows = connection.execute(
            "SELECT sequence FROM chunks WHERE session_id = ? AND status != ? ORDER BY sequence",
            (session_id, CHUNK_DONE),
        ).fetchall()
    records = [get_chunk(db, session_id, row["sequence"]) for row in rows]
    return [record for record in records if record is not None]


def chunk_manifest_page(
    db: Database, session_id: str, *, after_sequence: int | None, limit: int
) -> list[ChunkManifestRecord]:
    """Return bounded chunks with segment IDs from their stored sequence relationship."""
    with db.read() as connection:
        rows = connection.execute(
            """
            WITH page AS (
                SELECT sequence, start_ms, end_ms, path, status
                FROM chunks
                WHERE session_id = ? AND (? IS NULL OR sequence > ?)
                ORDER BY sequence
                LIMIT ?
            )
            SELECT page.*, associations.segment_id AS segment_id
            FROM page
            LEFT JOIN (
                SELECT segment_id, session_id, sequence FROM segment_sources
                UNION
                SELECT id AS segment_id, session_id, sequence FROM segments
                WHERE NOT EXISTS (
                    SELECT 1 FROM segment_sources WHERE segment_sources.segment_id = segments.id
                )
            ) AS associations
              ON associations.session_id = ? AND associations.sequence = page.sequence
            ORDER BY page.sequence, associations.segment_id
            """,
            (session_id, after_sequence, after_sequence, limit, session_id),
        ).fetchall()

    chunks: list[ChunkManifestRecord] = []
    for row in rows:
        if not chunks or chunks[-1].sequence != row["sequence"]:
            chunks.append(
                ChunkManifestRecord(
                    sequence=row["sequence"],
                    start_ms=row["start_ms"],
                    end_ms=row["end_ms"],
                    path=row["path"],
                    status=row["status"],
                    segment_ids=[],
                )
            )
        if row["segment_id"] is not None:
            chunks[-1].segment_ids.append(row["segment_id"])
    return chunks


# --- segments ---------------------------------------------------------------


def replace_chunk_segments(
    db: Database, session_id: str, sequence: int, segments: list[Segment]
) -> list[Segment]:
    with db.write() as connection:
        _assert_final_writer_available(connection, session_id, "legacy")
        stale = connection.execute(
            "SELECT id FROM segments WHERE session_id = ? AND sequence = ?", (session_id, sequence)
        ).fetchall()
        for row in stale:
            connection.execute("DELETE FROM segments_fts WHERE segment_id = ?", (row["id"],))
        connection.execute(
            "DELETE FROM segments WHERE session_id = ? AND sequence = ?", (session_id, sequence)
        )
        created_at = _now()
        for segment in segments:
            connection.execute(
                """
                INSERT INTO segments(id, session_id, sequence, start_ms, end_ms, text, language, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    segment.id,
                    session_id,
                    sequence,
                    segment.start_ms,
                    segment.end_ms,
                    segment.text,
                    segment.language,
                    created_at,
                ),
            )
            connection.execute(
                "INSERT INTO segments_fts(segment_id, session_id, text) VALUES (?, ?, ?)",
                (segment.id, session_id, segment.text),
            )
    return segments


def list_segments(db: Database, session_id: str) -> list[Segment]:
    with db.read() as connection:
        rows = connection.execute(
            "SELECT * FROM segments WHERE session_id = ? ORDER BY start_ms, sequence", (session_id,)
        ).fetchall()
    return _segments_with_sources(db, rows)


def segments_in_range(db: Database, session_id: str, start_ms: int, end_ms: int) -> list[Segment]:
    """Segments overlapping [start_ms, end_ms]."""
    with db.read() as connection:
        rows = connection.execute(
            """
            SELECT * FROM segments
            WHERE session_id = ? AND end_ms > ? AND start_ms < ?
            ORDER BY start_ms, sequence
            """,
            (session_id, start_ms, end_ms),
        ).fetchall()
    return _segments_with_sources(db, rows)


def segments_for_chunk(db: Database, session_id: str, sequence: int) -> list[Segment]:
    with db.read() as connection:
        rows = connection.execute(
            "SELECT * FROM segments WHERE session_id = ? AND sequence = ? ORDER BY start_ms",
            (session_id, sequence),
        ).fetchall()
    return _segments_with_sources(db, rows)


def search_segments(db: Database, session_id: str, query: str, limit: int = 40) -> list[Segment]:
    """Full-text search inside one session; returns matches in timeline order."""
    if not query.strip():
        return []
    with db.read() as connection:
        try:
            rows = connection.execute(
                """
                SELECT s.* FROM segments_fts f
                JOIN segments s ON s.id = f.segment_id
                WHERE f.session_id = ? AND segments_fts MATCH ?
                ORDER BY s.start_ms LIMIT ?
                """,
                (session_id, query, limit),
            ).fetchall()
        except sqlite3.OperationalError:
            return []  # malformed FTS expression: caller falls back to another scope
    return _segments_with_sources(db, rows)


def segments_by_ids(db: Database, session_id: str, segment_ids: list[str]) -> list[Segment]:
    if not segment_ids:
        return []
    placeholders = ",".join("?" for _ in segment_ids)
    with db.read() as connection:
        rows = connection.execute(
            f"SELECT * FROM segments WHERE session_id = ? AND id IN ({placeholders})",
            (session_id, *segment_ids),
        ).fetchall()
    by_id = {row["id"]: row for row in rows}
    ordered = [by_id[segment_id] for segment_id in segment_ids if segment_id in by_id]
    return _segments_with_sources(db, ordered)


def latest_segment_end(db: Database, session_id: str) -> int:
    with db.read() as connection:
        row = connection.execute(
            "SELECT MAX(end_ms) AS watermark FROM segments WHERE session_id = ?", (session_id,)
        ).fetchone()
    return int(row["watermark"] or 0)


def _segments_with_sources(db: Database, rows: list[sqlite3.Row]) -> list[Segment]:
    if not rows:
        return []
    ids = [str(row["id"]) for row in rows]
    placeholders = ",".join("?" for _ in ids)
    with db.read() as connection:
        source_rows = connection.execute(
            f"""
            SELECT segment_id, sequence, sample_start, sample_end, sha256
            FROM segment_sources WHERE segment_id IN ({placeholders})
            ORDER BY segment_id, sequence
            """,
            ids,
        ).fetchall()
    sources: dict[str, list[SegmentSource]] = {segment_id: [] for segment_id in ids}
    for source in source_rows:
        sources[str(source["segment_id"])].append(
            SegmentSource(
                sequence=source["sequence"],
                sample_start=source["sample_start"],
                sample_end=source["sample_end"],
                sha256=source["sha256"],
            )
        )
    return [_segment(row, sources[str(row["id"])]) for row in rows]


def _segment(row: sqlite3.Row, sources: list[SegmentSource] | None = None) -> Segment:
    return Segment(
        id=row["id"],
        start_ms=row["start_ms"],
        end_ms=row["end_ms"],
        text=row["text"],
        language=row["language"],
        sources=sources or [],
    )


def new_segment(start_ms: int, end_ms: int, text: str, language: str | None) -> Segment:
    return Segment(id=_new_id(), start_ms=start_ms, end_ms=end_ms, text=text, language=language)


# --- messages and notes -----------------------------------------------------


def add_message(db: Database, session_id: str, role: str, content: str, citations: list[Citation]) -> Message:
    message = Message(
        id=_new_id(),
        role=role,  # type: ignore[arg-type]
        content=content,
        created_at=_now(),
        citations=citations,
    )
    with db.write() as connection:
        connection.execute(
            "INSERT INTO messages(id, session_id, role, content, created_at, citations)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (
                message.id,
                session_id,
                message.role,
                message.content,
                message.created_at,
                json.dumps([c.model_dump() for c in citations], ensure_ascii=False),
            ),
        )
    return message


def list_messages(db: Database, session_id: str) -> list[Message]:
    with db.read() as connection:
        rows = connection.execute(
            "SELECT * FROM messages WHERE session_id = ? ORDER BY created_at, rowid", (session_id,)
        ).fetchall()
    return [
        Message(
            id=row["id"],
            role=row["role"],
            content=row["content"],
            created_at=row["created_at"],
            citations=[Citation.model_validate(item) for item in json.loads(row["citations"])],
        )
        for row in rows
    ]


def add_note(db: Database, session_id: str, content: str, model: str, citations: list[Citation]) -> Note:
    note = Note(content=content, created_at=_now(), model=model, citations=citations)
    with db.write() as connection:
        connection.execute(
            "INSERT INTO notes(id, session_id, content, created_at, model, citations)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (
                _new_id(),
                session_id,
                note.content,
                note.created_at,
                note.model,
                json.dumps([c.model_dump() for c in citations], ensure_ascii=False),
            ),
        )
    return note


def latest_note(db: Database, session_id: str) -> Note | None:
    with db.read() as connection:
        row = connection.execute(
            "SELECT * FROM notes WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
            (session_id,),
        ).fetchone()
    if row is None:
        return None
    return Note(
        content=row["content"],
        created_at=row["created_at"],
        model=row["model"],
        citations=[Citation.model_validate(item) for item in json.loads(row["citations"])],
    )
