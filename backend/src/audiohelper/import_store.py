"""Imported audio files: job bookkeeping and the transcript they produce.

An import is a recording whose audio was never captured by this app.  It reuses
every live transcript table — segments, tokens, speakers, translation events —
so monologues, note anchors, Ask, search and the Markdown projection treat an
imported lecture exactly like a recorded one.

Two things make it a different animal, and both are explicit here rather than
implied:

* There is no device sample clock.  ``native_recordings.sample_rate`` is fixed at
  :data:`IMPORT_SAMPLE_RATE` and means "16 samples per millisecond", a unit of
  time, not a property of the source file.  We never decode the file, so we do
  not know its real rate and must not pretend to.
* There is no stored PCM.  The source file stays where the user put it; we keep
  its identity (path, size, mtime, digest) so playback can tell "the same file"
  from "a file that has since changed" instead of guessing.

Provider I/O belongs to the caller.  Everything here is synchronous SQLite work
and never holds the lock across an await.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import uuid
from collections.abc import Iterable, Sequence
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from .db import Database
from .gateways.soniox import SonioxEvent, SonioxToken, SonioxTokenRef, SonioxTranslationToken
from .gateways.soniox_async import AsyncToken
from .monologues import MAX_MONOLOGUE_CHARS, MAX_MONOLOGUE_MS, MONOLOGUE_GAP_MS
from .native_tokens import persist_tokens

#: Time unit for imported recordings: 16 samples per millisecond makes the
#: millisecond↔sample conversion exact in both directions, so a two-hour file
#: never accumulates rounding drift. It is not the file's real sample rate.
IMPORT_SAMPLE_RATE = 16_000

ImportStatus = Literal["queued", "uploading", "processing", "completed", "failed", "cancelled"]
#: Statuses a restart must pick back up rather than leave stranded.
UNSETTLED: tuple[ImportStatus, ...] = ("queued", "uploading", "processing")

#: Digest of an unreadable source is impossible, but an import must still record
#: which file it came from; this marks an identity we could not compute.
UNKNOWN_DIGEST = ""


class ImportConflict(ValueError):
    """Invalid transition, unknown import, or a transcript that does not fit."""


@dataclass(frozen=True)
class ImportSource:
    """Identity of the user's file at the moment of import."""

    path: str
    name: str
    size_bytes: int
    mtime_ns: int
    sha256: str


@dataclass(frozen=True)
class ImportRecord:
    session_id: str
    source: ImportSource
    declared_duration_ms: int | None
    audio_duration_ms: int | None
    model: str
    translate: bool
    status: ImportStatus
    provider_file_id: str | None
    transcription_id: str | None
    error: str | None
    created_at: str
    settled_at: str | None


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds")


def digest_file(path: Path, *, chunk_bytes: int = 1 << 20) -> str:
    """Stream the file into a digest; never load a multi-gigabyte lecture at once."""
    hasher = hashlib.sha256()
    with path.open("rb") as handle:
        while block := handle.read(chunk_bytes):
            hasher.update(block)
    return hasher.hexdigest()


class ImportStore:
    def __init__(self, db: Database) -> None:
        self.db = db

    def create(
        self, session_id: str, *, source: ImportSource, model: str, translate: bool,
        translation_target_language: str, used_languages: tuple[str, ...] | None,
        declared_duration_ms: int | None,
    ) -> ImportRecord:
        """Claim the session for an import. The session must have no recording yet."""
        if source.size_bytes <= 0:
            raise ImportConflict("The source file is empty.")
        with self.db.write() as connection:
            if connection.execute("SELECT 1 FROM sessions WHERE id=?", (session_id,)).fetchone() is None:
                raise ImportConflict("Session does not exist.")
            if connection.execute(
                "SELECT 1 FROM native_recordings WHERE session_id=?", (session_id,)
            ).fetchone():
                raise ImportConflict("This session already holds a recording.")
            if connection.execute(
                "SELECT 1 FROM chunks WHERE session_id=? LIMIT 1", (session_id,)
            ).fetchone():
                raise ImportConflict("This session already holds captured audio.")
            connection.execute(
                "INSERT INTO native_recordings(session_id,sample_rate,recording_mode,"
                "translation_target_language,used_languages_json,origin) VALUES (?,?,?,?,?,'import')",
                (session_id, IMPORT_SAMPLE_RATE, "translation" if translate else "transcription",
                 translation_target_language,
                 json.dumps(list(used_languages)) if used_languages is not None else None),
            )
            # An import is not a capture: leaving the session in the 'recording'
            # state that create_session assigns would make the recorder and the
            # navigator both lie about what is happening.
            connection.execute("UPDATE sessions SET status='stopped' WHERE id=?", (session_id,))
            connection.execute(
                "INSERT INTO native_imports(session_id,source_path,source_name,source_bytes,"
                "source_mtime_ns,source_sha256,declared_duration_ms,audio_duration_ms,model,translate,"
                "status,provider_file_id,transcription_id,error,created_at,settled_at) "
                "VALUES (?,?,?,?,?,?,?,NULL,?,?,'queued',NULL,NULL,NULL,?,NULL)",
                (session_id, source.path, source.name, source.size_bytes, source.mtime_ns,
                 source.sha256, declared_duration_ms, model, int(translate), _now()),
            )
            return _record(self._row(connection, session_id))

    def get(self, session_id: str) -> ImportRecord | None:
        with self.db.read() as connection:
            row = connection.execute(
                "SELECT * FROM native_imports WHERE session_id=?", (session_id,)
            ).fetchone()
        return _record(row) if row is not None else None

    def unsettled(self) -> list[ImportRecord]:
        """Imports a restart must resume, oldest first."""
        with self.db.read() as connection:
            rows = connection.execute(
                f"SELECT * FROM native_imports WHERE status IN ({','.join('?' * len(UNSETTLED))}) "
                "ORDER BY created_at, rowid", UNSETTLED,
            ).fetchall()
        return [_record(row) for row in rows]

    def mark_uploading(self, session_id: str) -> ImportRecord:
        return self._transition(session_id, "uploading", allowed=("queued", "uploading"))

    def mark_uploaded(self, session_id: str, *, provider_file_id: str) -> ImportRecord:
        return self._transition(
            session_id, "uploading", allowed=("queued", "uploading"),
            assignments={"provider_file_id": provider_file_id},
        )

    def mark_processing(self, session_id: str, *, transcription_id: str) -> ImportRecord:
        """Record the job id. Written before the first poll so a crash cannot lose it."""
        return self._transition(
            session_id, "processing", allowed=("queued", "uploading", "processing"),
            assignments={"transcription_id": transcription_id},
        )

    def mark_failed(self, session_id: str, *, error: str) -> ImportRecord:
        return self._transition(
            session_id, "failed", allowed=("queued", "uploading", "processing"),
            assignments={"error": error[:500]}, settle=True,
        )

    def mark_cancelled(self, session_id: str) -> ImportRecord:
        return self._transition(
            session_id, "cancelled", allowed=("queued", "uploading", "processing"), settle=True,
        )

    def _transition(
        self, session_id: str, status: ImportStatus, *, allowed: tuple[ImportStatus, ...],
        assignments: dict[str, Any] | None = None, settle: bool = False,
    ) -> ImportRecord:
        with self.db.write() as connection:
            row = self._row(connection, session_id)
            if row["status"] == status and not assignments:
                return _record(row)
            if row["status"] not in allowed:
                raise ImportConflict(
                    f"An import in state {row['status']} cannot move to {status}."
                )
            fields = {"status": status, **(assignments or {})}
            if settle:
                fields["settled_at"] = _now()
            columns = ",".join(f"{name}=?" for name in fields)
            connection.execute(
                f"UPDATE native_imports SET {columns} WHERE session_id=?",
                (*fields.values(), session_id),
            )
            return _record(self._row(connection, session_id))

    def apply_transcript(
        self, session_id: str, *, tokens: Sequence[AsyncToken], audio_duration_ms: int,
    ) -> ImportRecord:
        """Store the finished transcript as live-shaped segments, tokens and speakers.

        Idempotent: replaying the completion of an already completed import returns
        the stored record without writing a second transcript.
        """
        if audio_duration_ms < 0:
            raise ImportConflict("The provider reported a negative audio duration.")
        groups = segment_tokens(tokens)
        with self.db.write() as connection:
            row = self._row(connection, session_id)
            if row["status"] == "completed":
                return _record(row)
            if row["status"] != "processing":
                raise ImportConflict(f"An import in state {row['status']} cannot complete.")
            span_ms = max((token.end_ms for token in tokens if _is_timed(token)), default=0)
            # The transcript may not claim speech past the audio the provider billed.
            duration_ms = max(audio_duration_ms, span_ms)
            total_samples = duration_ms * IMPORT_SAMPLE_RATE // 1000
            identity = uuid.uuid4().hex
            connection.execute(
                "INSERT INTO asr_connections(id,session_id,start_sample,end_sample,model,status,"
                "final_sample,processed_sample,next_event) VALUES (?,?,0,?,?,'finished',?,?,?)",
                (identity, session_id, total_samples, row["model"], total_samples, total_samples,
                 len(groups)),
            )
            connection.execute(
                "UPDATE native_recordings SET saved_samples=?,next_sequence=0 WHERE session_id=?",
                (total_samples, session_id),
            )
            connection.execute("UPDATE sessions SET duration_ms=? WHERE id=?", (duration_ms, session_id))
            event_row = connection.execute(
                "SELECT a.*,r.sample_rate FROM asr_connections a JOIN native_recordings r "
                "ON r.session_id=a.session_id WHERE a.id=?", (identity,),
            ).fetchone()
            for ordinal, group in enumerate(groups):
                self._write_group(connection, event_row, ordinal, group, duration_ms)
            connection.execute(
                "UPDATE native_imports SET status='completed',audio_duration_ms=?,settled_at=?,"
                "error=NULL WHERE session_id=?", (audio_duration_ms, _now(), session_id),
            )
            return _record(self._row(connection, session_id))

    @staticmethod
    def _write_group(
        connection: sqlite3.Connection, row: sqlite3.Row, ordinal: int,
        group: Sequence[AsyncToken], duration_ms: int,
    ) -> None:
        event = _event(group, total_audio_proc_ms=duration_ms)
        segment_ids: list[str] = []
        text = "".join(token.text for token in event.final_tokens)
        if text.strip():
            start_ms = min(token.start_ms for token in event.final_tokens)
            end_ms = max(token.end_ms for token in event.final_tokens)
            segment_id = uuid.uuid5(uuid.UUID(hex=row["id"]), str(ordinal)).hex
            languages = {token.language for token in event.final_tokens if token.language}
            connection.execute(
                "INSERT INTO segments(id,session_id,sequence,start_ms,end_ms,text,language,created_at) "
                # sequence -1: an import owns no captured audio chunk.
                "VALUES (?,?,-1,?,?,?,?,?)",
                (segment_id, row["session_id"], start_ms, max(end_ms, start_ms + 1), text,
                 next(iter(languages)) if len(languages) == 1 else None, _now()),
            )
            connection.execute("INSERT INTO segments_fts(segment_id,session_id,text) VALUES (?,?,?)",
                               (segment_id, row["session_id"], text))
            connection.execute("INSERT INTO transcript_revisions VALUES (?,1,?,'soniox')",
                               (segment_id, text))
            segment_ids.append(segment_id)
        payload = json.dumps(asdict(event), sort_keys=True, allow_nan=False)
        connection.execute(
            "INSERT INTO native_asr_events VALUES (?,?,?,?)",
            (row["id"], ordinal, hashlib.sha256(payload.encode()).hexdigest(),
             json.dumps(segment_ids)),
        )
        persist_tokens(connection, row, ordinal, event, segment_ids[0] if segment_ids else None)

    @staticmethod
    def _row(connection: sqlite3.Connection, session_id: str) -> sqlite3.Row:
        row = connection.execute(
            "SELECT i.*,r.origin FROM native_imports i JOIN native_recordings r USING(session_id) "
            "WHERE i.session_id=?", (session_id,),
        ).fetchone()
        if not isinstance(row, sqlite3.Row):
            raise ImportConflict("This session is not an import.")
        return row


def _is_timed(token: AsyncToken) -> bool:
    """Translated tokens carry no audio timing; only originals place speech in time."""
    return token.translation_status != "translation"


def segment_tokens(tokens: Iterable[AsyncToken]) -> list[list[AsyncToken]]:
    """Cut the provider's flat token stream into citable, live-shaped segments.

    The boundaries are the monologue rules — speaker change, a pause longer than
    :data:`~.monologues.MONOLOGUE_GAP_MS`, or the duration and length ceilings —
    so an imported transcript is grouped the same way a recorded one is. Tokens
    are kept in the provider's own order, which is what lets a translated chunk
    stay attached to the original speech it follows.
    """
    groups: list[list[AsyncToken]] = []
    speaker: str | None = None
    started_ms = 0
    last_end_ms = 0
    length = 0
    for token in tokens:
        if not _is_timed(token):
            # A translation can never open a segment: it belongs to speech already seen.
            if groups:
                groups[-1].append(token)
                length += len(token.text)
            continue
        boundary = (
            not groups
            or token.speaker != speaker
            or token.start_ms - last_end_ms > MONOLOGUE_GAP_MS
            or token.end_ms - started_ms > MAX_MONOLOGUE_MS
            or length + len(token.text) > MAX_MONOLOGUE_CHARS
        )
        if boundary:
            groups.append([])
            speaker, started_ms, length = token.speaker, token.start_ms, 0
        groups[-1].append(token)
        last_end_ms = max(last_end_ms, token.end_ms)
        length += len(token.text)
    return [group for group in groups if any(_is_timed(token) for token in group)]


def _event(group: Sequence[AsyncToken], *, total_audio_proc_ms: int) -> SonioxEvent:
    """Re-express one segment in the live event shape the token store already speaks."""
    originals: list[SonioxToken] = []
    translations: list[SonioxTranslationToken] = []
    order: list[SonioxTokenRef] = []
    for token in group:
        if token.translation_status == "translation":
            order.append(SonioxTokenRef("translation", True, len(translations)))
            translations.append(SonioxTranslationToken(
                text=token.text, confidence=token.confidence, is_final=True,
                language=token.language, source_language=None, speaker=token.speaker,
            ))
            continue
        order.append(SonioxTokenRef(token.translation_status, True, len(originals)))
        originals.append(SonioxToken(
            text=token.text, start_ms=token.start_ms, end_ms=token.end_ms,
            confidence=token.confidence, is_final=True, language=token.language,
            speaker=token.speaker,
        ))
    return SonioxEvent(
        final_tokens=tuple(originals),
        partial_tokens=(),
        markers=(),
        final_audio_proc_ms=total_audio_proc_ms,
        total_audio_proc_ms=total_audio_proc_ms,
        finished=True,
        final_translation_tokens=tuple(translations),
        partial_translation_tokens=(),
        token_order=tuple(order),
    )


def _record(row: sqlite3.Row) -> ImportRecord:
    return ImportRecord(
        session_id=row["session_id"],
        source=ImportSource(
            path=row["source_path"], name=row["source_name"], size_bytes=row["source_bytes"],
            mtime_ns=row["source_mtime_ns"], sha256=row["source_sha256"],
        ),
        declared_duration_ms=row["declared_duration_ms"],
        audio_duration_ms=row["audio_duration_ms"],
        model=row["model"],
        translate=bool(row["translate"]),
        status=row["status"],
        provider_file_id=row["provider_file_id"],
        transcription_id=row["transcription_id"],
        error=row["error"],
        created_at=row["created_at"],
        settled_at=row["settled_at"],
    )
