"""Scoped transcript snapshots with bounded reads and optional durable publication.

Capture uses a dedicated pinned WAL reader, not the recording connection lock.
It is synchronous: callers must run capture and reads in their owning worker,
not the ASR event loop. Cancellation/deadline bound cooperative work and WAL
retention. Capture is temporary; save/open produce durable files owned by the
caller. Closing an opened snapshot never deletes that file.
"""
from __future__ import annotations

import json
import math
import os
import sqlite3
import tempfile
from collections.abc import Callable
from pathlib import Path
from threading import Event
from time import monotonic
from types import TracebackType
from typing import Any
from uuid import uuid4

from .. import monologues as mono
from ..db import Database


class TranscriptSnapshot:
    def __init__(self, sessions: tuple[str, ...]) -> None:
        self.id = uuid4().hex
        self._sessions = frozenset(sessions)
        self._revisions: dict[str, int] = {}
        self._closed = False
        self._db = sqlite3.connect("")  # Private temporary file, not an entire in-memory library.
        self._db.row_factory = sqlite3.Row
        self._db.create_function("casefold", 1, str.casefold, deterministic=True)
        self._db.executescript("""
            CREATE TABLE raw(session TEXT, id TEXT, text TEXT, start INTEGER, end INTEGER,
                             speaker INTEGER, segment TEXT);
            CREATE INDEX covered ON raw(session,segment);
            CREATE TABLE blocks(seq INTEGER PRIMARY KEY, session_id TEXT, text TEXT,
                                start_ms INTEGER, end_ms INTEGER, speaker INTEGER,
                                start_token_id TEXT, end_token_id TEXT);
            CREATE INDEX pages ON blocks(session_id,seq);
            CREATE TABLE metadata(version INTEGER, snapshot_id TEXT, sessions TEXT, source_revisions TEXT);
        """)
        self._db.execute("INSERT INTO metadata VALUES (2,?,?,?)", (self.id, json.dumps(sessions), "{}"))

    @classmethod
    def open(cls, path: Path) -> TranscriptSnapshot:
        """Borrow an application-owned snapshot; close never deletes the durable file."""
        connection = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
        try:
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA query_only=ON")
            connection.execute("PRAGMA trusted_schema=OFF")
            connection.execute(
                "SELECT seq,session_id,text,start_ms,end_ms,speaker,start_token_id,end_token_id "
                "FROM blocks LIMIT 0",
            )
            rows = connection.execute("SELECT * FROM metadata LIMIT 2").fetchall()
            if len(rows) != 1 or rows[0]["version"] not in (1, 2):
                raise ValueError("Unsupported transcript snapshot")
            row = rows[0]
            sessions = json.loads(row["sessions"])
            if (not isinstance(sessions, list) or not 1 <= len(sessions) <= 100
                    or any(not isinstance(s, str) or not s for s in sessions)
                    or not isinstance(row["snapshot_id"], str) or not row["snapshot_id"]):
                raise ValueError("Invalid transcript snapshot metadata")
            revisions = json.loads(row["source_revisions"]) if row["version"] == 2 else {}
            if not isinstance(revisions, dict) or (row["version"] == 2 and (
                set(revisions) != set(sessions)
                or any(type(value) is not int or value < 0 for value in revisions.values())
            )):
                raise ValueError("Invalid snapshot source revisions")
            snapshot = cls.__new__(cls)
            snapshot.id = row["snapshot_id"]
            snapshot._sessions = frozenset(sessions)
            snapshot._revisions = revisions
            snapshot._closed = False
            snapshot._db = connection
            connection.create_function("casefold", 1, str.casefold, deterministic=True)
            return snapshot
        except BaseException:
            connection.close()
            raise

    def save(self, path: Path, *, cancel: Event | None = None, max_seconds: float = 10) -> None:
        """Publish a complete private SQLite file without replacing an existing path."""
        if self._closed or not math.isfinite(max_seconds) or max_seconds <= 0:
            raise ValueError("Invalid snapshot save")
        deadline = monotonic() + max_seconds

        def check(*_: int) -> None:
            if cancel is not None and cancel.is_set():
                raise InterruptedError("Transcript snapshot cancelled")
            if monotonic() >= deadline:
                raise TimeoutError("Transcript snapshot deadline exceeded")

        check()
        fd, name = tempfile.mkstemp(prefix=".snapshot-", dir=path.parent)
        os.close(fd)
        staging = Path(name)
        published = False
        try:
            target = sqlite3.connect(staging)
            try:
                self._db.backup(target, pages=64, progress=check)
            finally:
                target.close()
            with staging.open("rb") as saved:
                os.fsync(saved.fileno())
            check()
            os.link(staging, path)  # Atomic no-clobber publication in the same directory.
            published = True
            directory = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        except BaseException:
            if published:
                path.unlink()
            raise
        finally:
            staging.unlink(missing_ok=True)

    @classmethod
    def capture(
        cls, db: Database, session_ids: tuple[str, ...], *,
        max_rows: int = 100_000, max_text_bytes: int = 16 * 1024 * 1024,
        max_seconds: float = 10, cancel: Event | None = None,
        on_pinned: Callable[[], None] | None = None,
    ) -> TranscriptSnapshot:
        if not session_ids or len(session_ids) > 100 or max_rows < 1 or max_text_bytes < 1:
            raise ValueError("Invalid snapshot limits/scope")
        if not math.isfinite(max_seconds) or max_seconds <= 0:
            raise ValueError("Invalid snapshot deadline")
        deadline = monotonic() + max_seconds

        def check() -> None:
            if cancel is not None and cancel.is_set():
                raise InterruptedError("Transcript snapshot cancelled")
            if monotonic() >= deadline:
                raise TimeoutError("Transcript snapshot deadline exceeded")

        def interrupted() -> int:
            return int((cancel is not None and cancel.is_set()) or monotonic() >= deadline)

        check()
        snapshot = cls(session_ids)
        snapshot._db.set_progress_handler(interrupted, 1000)
        count = size = 0

        def store(values: tuple[Any, ...]) -> None:
            nonlocal count, size
            check()
            text = values[2]
            if not isinstance(text, str):
                raise ValueError("Invalid transcript source")
            encoded = len(text.encode())
            count += 1
            size += encoded
            if count > max_rows or size > max_text_bytes or encoded > 8192:
                raise ValueError("Transcript snapshot exceeds limit; no partial snapshot created")
            snapshot._db.execute("INSERT INTO raw VALUES (?,?,?,?,?,?,?)", values)

        try:
            with db.snapshot_read() as source:
                check()
                if on_pinned is not None:
                    on_pinned()
                source.set_progress_handler(interrupted, 1000)
                source.execute("SAVEPOINT agent_snapshot")
                try:
                    for sid in dict.fromkeys(session_ids):
                        revision = source.execute(
                            "SELECT source_revision FROM sessions WHERE id=?", (sid,),
                        ).fetchone()
                        if revision is None:
                            raise ValueError("Snapshot session unavailable")
                        snapshot._revisions[sid] = int(revision["source_revision"])
                        rows = source.execute(
                            "SELECT json_extract(t.value,'$.id'),json_extract(t.value,'$.text'),"
                            "json_extract(t.value,'$.start_sample')*1000/r.sample_rate,"
                            "json_extract(t.value,'$.end_sample')*1000/r.sample_rate,"
                            "json_extract(t.value,'$.speaker_number'),json_extract(t.value,'$.segment_id') "
                            "FROM native_token_events e JOIN asr_connections c ON c.id=e.connection_id "
                            "JOIN native_recordings r ON r.session_id=c.session_id, "
                            "json_each(e.tokens_json) t WHERE c.session_id=? "
                            "ORDER BY c.rowid,e.ordinal,CAST(t.key AS INTEGER)", (sid,),
                        )
                        for row in rows:
                            store((sid, *tuple(row)))
                        for row in source.execute(
                            "SELECT id,text,start_ms,end_ms FROM segments WHERE session_id=? "
                            "ORDER BY start_ms,sequence,id", (sid,),
                        ):
                            covered = snapshot._db.execute(
                                "SELECT 1 FROM raw WHERE session=? AND segment=? LIMIT 1", (sid, row["id"]),
                            ).fetchone()
                            if covered is None:
                                text = row["text"]
                                store((sid, row["id"], text + " ", row["start_ms"], row["end_ms"],
                                       None, row["id"]))
                finally:
                    source.execute("RELEASE agent_snapshot")
            snapshot._build_blocks(check)
            snapshot._db.execute("DROP TABLE raw")
            snapshot._db.execute(
                "UPDATE metadata SET source_revisions=?", (json.dumps(snapshot._revisions),),
            )
            snapshot._db.commit()
            snapshot._db.execute("PRAGMA query_only=ON")
            check()
            snapshot._db.set_progress_handler(None, 0)
            return snapshot
        except sqlite3.OperationalError:
            snapshot.close()
            check()  # Translate SQLite progress-handler interruption without masking other errors.
            raise
        except BaseException:
            snapshot.close()
            raise

    def _build_blocks(self, check: Callable[[], None]) -> None:
        """One block per monologue, cut exactly as :func:`monologues.build` cuts them.

        The whole session goes through one ``mono.build`` call, the same grouping the
        ordinary Notes and the transcript view use. Pre-chunking the tokens here would
        cut monologues at different places, so a Codex citation and an ordinary one
        would name different stretches of the same speech.
        """
        self._db.execute("ALTER TABLE blocks ADD COLUMN segment_id TEXT")
        for sid in sorted(self._sessions):
            tokens: list[mono.Token] = []
            for row in self._db.execute("SELECT * FROM raw WHERE session=? ORDER BY start,end,rowid", (sid,)):
                check()
                if not row["text"].strip():
                    continue
                if (
                    not isinstance(row["id"], str)
                    or type(row["start"]) is not int or type(row["end"]) is not int
                ):
                    raise ValueError("Invalid transcript provenance")
                if row["start"] < 0 or row["end"] < row["start"]:
                    raise ValueError("Invalid transcript timing")
                tokens.append(mono.Token(row["id"], row["text"], row["start"], row["end"],
                                         row["speaker"], row["segment"]))
            for block in mono.build(tokens):
                check()
                first = block.tokens[0]
                self._db.execute(
                    "INSERT INTO blocks(session_id,text,start_ms,end_ms,speaker,"
                    "start_token_id,end_token_id,segment_id) "
                    "VALUES (?,?,?,?,?,?,?,?)",
                    (sid, block.text, block.start_ms, block.end_ms, block.speaker,
                     first.id, block.tokens[-1].id, first.segment_id or first.id),
                )

    def read(
        self, session_id: str, *, start_ms: int = 0, end_ms: int | None = None,
        after: int = 0, limit: int = 20, query: str = "",
    ) -> dict[str, Any]:
        if self._closed or session_id not in self._sessions:
            raise ValueError("Snapshot unavailable or session outside scope")
        if (
            any(type(value) is not int for value in (start_ms, after, limit))
            or start_ms < 0 or after < 0 or not 1 <= limit <= 100
            or (end_ms is not None and (type(end_ms) is not int or end_ms <= start_ms))
            or not isinstance(query, str) or len(query.encode()) > 4096
        ):
            raise ValueError("Invalid snapshot query")
        rows = self._db.execute(
            "SELECT * FROM blocks WHERE session_id=? AND seq>? AND end_ms>=? "
            "AND (? IS NULL OR start_ms<?) AND instr(casefold(text),casefold(?))>0 ORDER BY seq LIMIT ?",
            (session_id, after, start_ms, end_ms, end_ms, query, limit + 1),
        )
        blocks: list[dict[str, Any]] = []
        byte_count = 0
        more = False
        for row in rows:
            block = dict(row)
            encoded = len(json.dumps(block, ensure_ascii=False).encode())
            if len(blocks) == limit or byte_count + encoded > 16384:
                if not blocks:
                    raise ValueError("Source block exceeds response limit")
                more = True
                break
            blocks.append(block)
            byte_count += encoded
        return {
            "snapshot_id": self.id, "blocks": blocks,
            "source_revision": self._revisions.get(session_id),
            "next_after": blocks[-1]["seq"] if more else None,
        }

    def close(self) -> None:
        if not self._closed:
            self._closed = True
            self._db.close()

    def __enter__(self) -> TranscriptSnapshot:
        return self

    def __exit__(
        self, exc_type: type[BaseException] | None, exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self.close()
