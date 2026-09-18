"""Independent notes with optimistic edits and database-only expiring history."""
from __future__ import annotations

import json
import re
import sqlite3
import time
import unicodedata
from datetime import UTC, datetime
from uuid import uuid4

from .db import Database
from .schemas import Citation, Note, NoteVersion

HISTORY_SECONDS = 30 * 24 * 60 * 60
# None denotes unknown historical provenance; manual edits retain it verbatim.
KEEP_SOURCE_REVISION = -1
TITLE_LIMIT = 120


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds")


class NoteMissing(ValueError):
    pass


class NoteConflict(ValueError):
    pass


class BlankTitle(ValueError):
    """A name that sanitises to nothing is refused, keeping the previous one."""


def sanitise_title(raw: str) -> str:
    """Reduce a typed name to one safe line, or refuse it.

    The note's name reaches a filesystem through the projected Markdown, so path
    separators, control characters and a trailing ``.md`` are stripped rather than
    trusted. A value that ends up empty is not stored at all: the user who clears
    the field gets the previous name back instead of an unnamed note.
    """
    collapsed = re.sub(r"\s+", " ", raw.replace("/", " ").replace("\\", " "))
    printable = "".join(c for c in collapsed if unicodedata.category(c) != "Cc")
    cleaned = printable.strip()
    while cleaned.lower().endswith(".md"):
        cleaned = cleaned[: -len(".md")].strip()
    cleaned = cleaned.strip(" .").strip()
    if not cleaned:
        raise BlankTitle("A note name cannot be empty.")
    return cleaned[:TITLE_LIMIT].strip()


def source_revision(connection: sqlite3.Connection, session_id: str) -> int:
    row = connection.execute("SELECT source_revision FROM sessions WHERE id=?", (session_id,)).fetchone()
    if row is None:
        raise NoteMissing("This session does not exist.")
    return int(row["source_revision"])


def _note(row: sqlite3.Row, current_revision: int) -> Note:
    keys = row.keys()
    return Note(
        id=row["id"], revision=row["revision"], content=row["content"],
        title=row["title"] if "title" in keys else "",
        updated_at=(row["updated_at"] if "updated_at" in keys else None) or row["created_at"],
        source_revision=row["source_revision"], stale=row["source_revision"] != current_revision,
        created_at=row["created_at"], model=row["model"],
        citations=[Citation.model_validate(c) for c in json.loads(row["citations"])],
    )


def _get(connection: sqlite3.Connection, session_id: str, note_id: str) -> Note:
    row = connection.execute(
        "SELECT * FROM notes WHERE id=? AND session_id=? AND deleted_at IS NULL", (note_id, session_id),
    ).fetchone()
    if row is None:
        raise NoteMissing("This note does not exist in the session.")
    return _note(row, source_revision(connection, session_id))


def list_notes(db: Database, session_id: str) -> list[Note]:
    with db.read() as connection:
        current = source_revision(connection, session_id)
        return [_note(row, current) for row in connection.execute(
            "SELECT * FROM notes WHERE session_id=? AND deleted_at IS NULL "
            "ORDER BY COALESCE(updated_at, created_at) DESC, rowid DESC", (session_id,),
        )]


def latest(db: Database, session_id: str) -> Note | None:
    with db.read() as connection:
        row = connection.execute(
            "SELECT * FROM notes WHERE session_id=? AND deleted_at IS NULL "
            "ORDER BY COALESCE(updated_at, created_at) DESC, rowid DESC LIMIT 1",
            (session_id,),
        ).fetchone()
        return None if row is None else _note(row, source_revision(connection, session_id))


def soft_delete(db: Database, session_id: str, note_id: str) -> None:
    """Hide a note without destroying it.

    The row stays for the future trash screen, so a mistaken click is recoverable;
    every read path filters on ``deleted_at``, which is why an already deleted note
    reports as missing rather than as a second successful deletion.
    """
    with db.write() as connection:
        _get(connection, session_id, note_id)
        connection.execute(
            "UPDATE notes SET deleted_at=? WHERE id=? AND session_id=?",
            (_now(), note_id, session_id),
        )


def check_revision(db: Database, session_id: str, note_id: str, expected: int | None) -> Note:
    with db.read() as connection:
        note = _get(connection, session_id, note_id)
        if note.revision != expected:
            raise NoteConflict("The note changed. Reload it before replacing or editing.")
        return note


def prune_history(db: Database) -> None:
    with db.write() as connection:
        connection.execute("DELETE FROM note_history WHERE expires_at<=?", (time.time(),))


def history(db: Database, session_id: str, note_id: str) -> list[NoteVersion]:
    prune_history(db)
    with db.read() as connection:
        _get(connection, session_id, note_id)
        return [
            NoteVersion(
                id=row["id"], expires_at=row["expires_at"],
                note=Note.model_validate_json(row["snapshot"]),
            )
            for row in connection.execute(
                "SELECT * FROM note_history WHERE note_id=? ORDER BY expires_at DESC, rowid DESC", (note_id,),
            )
        ]


def _replace(
    connection: sqlite3.Connection, session_id: str, note_id: str, expected: int | None,
    content: str | None, model: str | None, citations: list[Citation] | None,
    generated_revision: int | None = KEEP_SOURCE_REVISION, title: str | None = None,
) -> Note:
    previous = _get(connection, session_id, note_id)
    if previous.revision != expected:
        raise NoteConflict("The note changed. Reload it before replacing or editing.")
    now = time.time()
    connection.execute("DELETE FROM note_history WHERE expires_at<=?", (now,))
    connection.execute(
        "INSERT INTO note_history(id,note_id,snapshot,expires_at) VALUES (?,?,?,?)",
        (uuid4().hex, note_id, previous.model_dump_json(), now + HISTORY_SECONDS),
    )
    note = previous.model_copy(update={
        "content": previous.content if content is None else content,
        "title": previous.title if title is None else title,
        "revision": previous.revision + 1,
        "updated_at": _now(),
        "model": previous.model if model is None else model,
        "citations": previous.citations if citations is None else citations,
        "source_revision": (
            previous.source_revision if generated_revision == KEEP_SOURCE_REVISION else generated_revision
        ),
    })
    note.stale = note.source_revision != source_revision(connection, session_id)
    connection.execute(
        "UPDATE notes SET content=?,title=?,model=?,citations=?,revision=?,source_revision=?,updated_at=? "
        "WHERE id=? AND session_id=?",
        (note.content, note.title, note.model,
         json.dumps([c.model_dump() for c in note.citations], ensure_ascii=False),
         note.revision, note.source_revision, note.updated_at, note.id, session_id),
    )
    return note


def replace(
    db: Database, session_id: str, note_id: str, expected: int | None, *,
    content: str | None = None, model: str | None = None, citations: list[Citation] | None = None,
    generated_revision: int | None = KEEP_SOURCE_REVISION, title: str | None = None,
) -> Note:
    with db.write() as connection:
        return _replace(
            connection, session_id, note_id, expected, content, model, citations,
            generated_revision, title,
        )


def restore(db: Database, session_id: str, note_id: str, version_id: str, expected: int) -> Note:
    prune_history(db)
    with db.write() as connection:
        _get(connection, session_id, note_id)
        row = connection.execute(
            "SELECT snapshot FROM note_history WHERE id=? AND note_id=? AND expires_at>?",
            (version_id, note_id, time.time()),
        ).fetchone()
        if row is None:
            raise NoteMissing("This version expired or does not exist.")
        previous = Note.model_validate_json(row["snapshot"])
        return _replace(connection, session_id, note_id, expected,
                        previous.content, previous.model, previous.citations,
                        previous.source_revision, previous.title)
