"""Portable capture and insert-only recovery. Never reconciles a whole library.

Capture returns bytes, not a publication acknowledgement. Publication, migration
and Runtime wiring must not use this until all their own durability gates pass.
"""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import stat
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .db import Database
from .library_discovery import LibraryUnavailable, _object, _stamp
from .library_native_archive import capture_native, restore_native
from .library_notes import RegisteredNotes, _read
from .library_session_schema import SessionDocument
from .library_session_validation import validate_document
from .session_files import _directory


class ArchiveRefused(ValueError):
    """Unsupported or invalid data; nothing was imported or discarded."""


@dataclass(frozen=True)
class ArchiveBytes:
    marker: bytes
    notes: dict[str, bytes]


def _json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))


def _read_document(fd: int) -> tuple[SessionDocument, os.stat_result]:
    info = os.stat("session.json", dir_fd=fd, follow_symlinks=False)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise ArchiveRefused("Session marker is not a regular unlinked file.")
    raw = _read(fd, "session.json", info)
    try:
        document = SessionDocument.model_validate(json.loads(raw.decode("utf-8"), object_pairs_hook=_object))
        validate_document(document)
    except (ValueError, UnicodeError, RecursionError) as error:
        raise ArchiveRefused("Session marker is invalid or unsupported.") from error
    return document, info


@contextmanager
def _snapshot(db: Database) -> Iterator[sqlite3.Connection]:
    # Database.read() serializes this process, not other SQLite connections.
    # BEGIN pins the export to one committed WAL snapshot, including all notes.
    with db.read() as connection:
        if connection.in_transaction:
            raise ArchiveRefused("Cannot archive an uncommitted database transaction.")
        connection.execute("BEGIN")
        try:
            yield connection
        finally:
            connection.rollback()


class SessionArchive:
    @staticmethod
    def capture(db: Database, session_id: str, *, note_paths: dict[str, str]) -> ArchiveBytes:
        """Capture a consistent DB snapshot; caller explicitly assigns note filenames."""
        with _snapshot(db) as connection:
            row = connection.execute("SELECT * FROM sessions WHERE id=?", (session_id,)).fetchone()
            if row is None:
                raise ArchiveRefused("Session does not exist.")
            imported = connection.execute(
                "SELECT status FROM native_imports WHERE session_id=?", (session_id,),
            ).fetchone()
            if imported is not None and imported["status"] != "completed":
                raise ArchiveRefused("Finish or cancel this import before exporting the session.")
            # Refuse instead of quietly omitting storage we cannot yet round-trip.
            for table in (
                "chunks",
                "live_asr_drafts",
                "live_asr_finality",
                "live_asr_fragments",
                "file_preservations",
            ):
                if connection.execute(
                    f"SELECT 1 FROM {table} WHERE session_id=? LIMIT 1", (session_id,)
                ).fetchone():
                    raise ArchiveRefused("Session contains state not yet supported by this archive version.")
            if (
                connection.execute("SELECT 1 FROM sqlite_master WHERE name='note_history'").fetchone()
                and connection.execute(
                    "SELECT 1 FROM note_history h JOIN notes n ON n.id=h.note_id "
                    "WHERE n.session_id=? LIMIT 1",
                    (session_id,),
                ).fetchone()
            ):
                raise ArchiveRefused("Note history requires explicit migration before archive capture.")
            notes = connection.execute(
                "SELECT * FROM notes WHERE session_id=? ORDER BY rowid", (session_id,)
            ).fetchall()
            if any("deleted_at" in dict(note) and note["deleted_at"] is not None for note in notes):
                raise ArchiveRefused("Note trash requires migration before archive capture.")
            if set(note_paths) != {note["id"] for note in notes}:
                raise ArchiveRefused("Every note requires exactly one registered filename.")
            metadata: list[dict[str, Any]] = []
            bodies: dict[str, bytes] = {}
            for note in notes:
                content = note["content"].encode("utf-8")
                name = note_paths[note["id"]]
                metadata.append({
                    "id": note["id"], "relative_path": name,
                    "content_sha256": hashlib.sha256(content).hexdigest(),
                    "created_at": note["created_at"], "updated_at": note["updated_at"],
                    "revision": note["revision"], "source_revision": note["source_revision"],
                    "model": note["model"], "citations": json.loads(note["citations"]),
                })
                header = _json({"format": "skaz.note", "version": 1, "id": note["id"]})
                bodies[name] = f"---\n{header}\n---\n".encode() + content
            messages = []
            for message in connection.execute("SELECT * FROM messages WHERE session_id=? ORDER BY rowid",
                                              (session_id,)):
                messages.append({key: message[key] for key in ("id", "role", "content", "created_at")} | {
                    "citations": json.loads(message["citations"]),
                })
            segments = []
            for segment_row in connection.execute(
                "SELECT * FROM segments WHERE session_id=? ORDER BY rowid", (session_id,),
            ):
                segment = dict(segment_row)
                segment.pop("session_id")
                segment["revisions"] = [dict(revision) for revision in connection.execute(
                    "SELECT revision,text,origin FROM transcript_revisions "
                    "WHERE segment_id=? ORDER BY revision",
                    (segment_row["id"],),
                )]
                segments.append(segment)
            document = SessionDocument.model_validate({
                "format": "skaz.session", "version": 1, "session": dict(row),
                "notes": metadata, "messages": messages, "segments": segments,
                "native": capture_native(connection, session_id),
            })
            validate_document(document)
        return ArchiveBytes(document.model_dump_json(exclude_unset=True).encode(), bodies)

    @staticmethod
    def restore_new(db: Database, directory: Path) -> str:
        """Insert one previously absent session; refuse collisions, never replace rows.

        This is not a root scan. It does not remove absent sessions, publish files,
        reopen sockets, execute provider jobs, or activate a library in Runtime.
        """
        if not directory.is_absolute() or ".." in directory.parts:
            raise ArchiveRefused("An absolute non-traversing directory is required.")
        try:
            with _directory(directory, create=False) as fd:
                before = os.fstat(fd)
                document, marker_info = _read_document(fd)
                snapshot = RegisteredNotes().scan(directory, tuple(n.registration() for n in document.notes))
                # Re-read the marker after notes: a file edit need not change its directory.
                if _stamp(marker_info) != _stamp(os.stat("session.json", dir_fd=fd, follow_symlinks=False)):
                    raise LibraryUnavailable("Session marker changed during recovery.")
                with _directory(directory, create=False) as current:
                    if _stamp(before) != _stamp(os.fstat(current)):
                        raise LibraryUnavailable("Session directory changed during recovery.")
                found = {n.id: n for n in snapshot.notes}
                s = document.session
                with db.write() as connection:
                    connection.execute(
                        "INSERT INTO sessions(id,title,created_at,status,duration_ms,mode,source_revision) "
                        "VALUES (?,?,?,?,?,?,?)",
                        (s.id, directory.name, s.created_at,
                         "paused" if s.status == "recording" else s.status,
                         s.duration_ms, s.mode, s.source_revision),
                    )
                    for segment in document.segments:
                        connection.execute(
                            "INSERT INTO segments(id,session_id,sequence,start_ms,end_ms,"
                            "text,language,created_at) "
                            "VALUES (?,?,?,?,?,?,?,?)", (segment.id, s.id, segment.sequence, segment.start_ms,
                                                         segment.end_ms, segment.text, segment.language,
                                                         segment.created_at),
                        )
                        connection.execute(
                            "INSERT INTO segments_fts(segment_id,session_id,text) VALUES (?,?,?)",
                                           (segment.id, s.id, segment.text))
                        for revision in segment.revisions:
                            connection.execute(
                                "INSERT INTO transcript_revisions(segment_id,revision,text,origin) "
                                "VALUES (?,?,?,?)",
                                (segment.id, revision.revision, revision.text, revision.origin),
                            )
                    if document.native is not None:
                        restore_native(connection, s.id, document.native)
                    # Inserting recovered sources fires source triggers. Recovery is
                    # not an edit: restore the original counter in the same transaction.
                    connection.execute("UPDATE sessions SET source_revision=? WHERE id=?",
                                       (s.source_revision, s.id))
                    for message in document.messages:
                        connection.execute(
                            "INSERT INTO messages(id,session_id,role,content,created_at,citations) "
                            "VALUES (?,?,?,?,?,?)", (message.id, s.id, message.role, message.content,
                                                     message.created_at,
                                                     _json(message.model_dump()["citations"])),
                        )
                    for note in document.notes:
                        disk = found.get(note.id)
                        if disk is None:
                            continue
                        connection.execute(
                            "INSERT INTO notes(id,session_id,content,created_at,model,citations,revision,"
                            "source_revision,title,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                            (note.id, s.id, disk.content, note.created_at, note.model,
                             "[]" if disk.content_changed else _json(note.model_dump()["citations"]),
                             note.revision + int(disk.content_changed), note.source_revision,
                             disk.title, note.updated_at),
                        )
                return s.id
        except sqlite3.IntegrityError as error:
            raise ArchiveRefused("Archive identities collide or violate the session schema.") from error
        except OSError as error:
            raise LibraryUnavailable("Session files are unavailable. No recovery applied.") from error
