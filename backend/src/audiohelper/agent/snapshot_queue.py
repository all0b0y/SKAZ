"""Persistent task/snapshot ownership, deliberately not a Codex dispatcher.

A synchronous enqueue waits only for the worker's WAL pin, not corpus copying.
That pin is the acceptance linearization point (not a frontend click timestamp).
Busy capture admission is rejected, never delayed behind model execution. All
SQLite capture/read/close work stays in its owning thread. Runtime must call
blocking control methods off the ASR event loop. Only one owner per directory.
Callers supply authorized session IDs; group/chat authorization is not provided
by this component. Recovery never claims work or invokes a provider.
"""
from __future__ import annotations

import json
import math
import sqlite3
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from threading import Event, RLock
from types import TracebackType
from typing import Any, Literal
from uuid import uuid4

from ..db import Database
from .transcript_snapshot import TranscriptSnapshot

LIVE = ("preparing", "queued", "running", "stopping", "paused")


@dataclass(frozen=True)
class SnapshotTask:
    id: str
    chat_id: str
    session_ids: tuple[str, ...]
    question: str
    model: str
    status: str
    snapshot_id: str | None
    answer: str
    error: str | None


class SnapshotQueue:
    def __init__(self, root: Path, *, max_pending: int = 32) -> None:
        if type(max_pending) is not int or max_pending < 1:
            raise ValueError("Invalid queue capacity")
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
        self._snapshots = root / "snapshots"
        self._snapshots.mkdir(mode=0o700, exist_ok=True)
        self._lock = RLock()
        self._closed = False
        self._capacity = max_pending
        # A separate rollback-journal DB holds a process-lifetime ownership lock.
        self._owner = sqlite3.connect(root / "owner.sqlite", timeout=0, check_same_thread=False)
        try:
            self._owner.execute("BEGIN EXCLUSIVE")
            self._db = sqlite3.connect(root / "queue.sqlite", check_same_thread=False)
            self._db.row_factory = sqlite3.Row
            self._db.execute("PRAGMA journal_mode=WAL")
            self._db.execute("PRAGMA synchronous=FULL")
            self._db.execute("PRAGMA fullfsync=ON")
            self._db.executescript("""
                CREATE TABLE IF NOT EXISTS tasks(
                    seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, chat_id TEXT NOT NULL,
                    sessions TEXT NOT NULL, question TEXT NOT NULL, model TEXT NOT NULL,
                    status TEXT NOT NULL, snapshot_id TEXT, answer TEXT NOT NULL DEFAULT '', error TEXT
                );
                CREATE UNIQUE INDEX IF NOT EXISTS one_chat_task ON tasks(chat_id)
                    WHERE status IN ('preparing','queued','running','stopping','paused');
            """)
            self._recover()
        except BaseException:
            if hasattr(self, "_db"):
                self._db.close()
            self._owner.close()
            raise
        self._worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="transcript-capture")
        self._captures: dict[str, tuple[Future[None], Event]] = {}

    def _path(self, task_id: str) -> Path:
        # Only identifiers read from our task registry reach this method.
        if len(task_id) != 32 or any(c not in "0123456789abcdef" for c in task_id):
            raise ValueError("Invalid task identity")
        return self._snapshots / f"{task_id}.sqlite"

    def _recover(self) -> None:
        with self._db:
            self._db.execute("UPDATE tasks SET status='paused' WHERE status IN ('queued','running')")
            self._db.execute("UPDATE tasks SET status='cancelled' WHERE status='stopping'")
            self._db.execute(
                "UPDATE tasks SET status='failed',error='capture_interrupted' WHERE status='preparing'",
            )
        for task in self.list():
            if task.status == "paused":
                try:
                    with TranscriptSnapshot.open(self._path(task.id)) as snapshot:
                        if snapshot.id != task.snapshot_id:
                            raise ValueError("Snapshot identity mismatch")
                except (OSError, ValueError, sqlite3.Error):
                    with self._db:
                        self._db.execute(
                            "UPDATE tasks SET status='failed',error='snapshot_unavailable' WHERE id=?",
                            (task.id,),
                        )
            if self.get(task.id).status not in LIVE:
                self._path(task.id).unlink(missing_ok=True)
        # These names belong exclusively to interrupted save operations in this directory.
        for staging in self._snapshots.glob(".snapshot-*"):
            staging.unlink()

    def _ensure_open(self) -> None:
        if self._closed:
            raise ValueError("Queue is closed")

    @staticmethod
    def _task(row: sqlite3.Row) -> SnapshotTask:
        return SnapshotTask(row["id"], row["chat_id"], tuple(json.loads(row["sessions"])),
                            row["question"], row["model"], row["status"], row["snapshot_id"],
                            row["answer"], row["error"])

    def get(self, task_id: str) -> SnapshotTask:
        with self._lock:
            self._ensure_open()
            row = self._db.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
            if row is None:
                raise ValueError("Unknown task")
            return self._task(row)

    def list(self) -> list[SnapshotTask]:
        with self._lock:
            self._ensure_open()
            return [self._task(row) for row in self._db.execute("SELECT * FROM tasks ORDER BY seq")]

    def enqueue(
        self, db: Database, *, chat_id: str, session_ids: tuple[str, ...], question: str,
        model: str, max_seconds: float = 10,
    ) -> SnapshotTask:
        if (not chat_id or len(chat_id) > 128 or not question.strip()
                or len(question.encode()) > 65536 or not model or len(model) > 256
                or not session_ids or len(session_ids) > 100
                or any(not isinstance(s, str) or not s or len(s) > 128 for s in session_ids)
                or not math.isfinite(max_seconds) or max_seconds <= 0):
            raise ValueError("Invalid task request")
        accepted, cancel = Event(), Event()
        task_id = uuid4().hex
        with self._lock:
            self._ensure_open()
            self._captures = {k: v for k, v in self._captures.items() if not v[0].done()}
            if self._captures:
                raise ValueError("Snapshot capture busy; request not accepted")
            tasks = self.list()
            if sum(t.status in LIVE for t in tasks) >= self._capacity:
                raise ValueError("Queue capacity exceeded")
            if any(t.chat_id == chat_id and t.status in LIVE for t in tasks):
                raise ValueError("Chat already has an unfinished task")
            with self._db:
                self._db.execute(
                    "INSERT INTO tasks(id,chat_id,sessions,question,model,status) "
                    "VALUES (?,?,?,?,?,'preparing')",
                    (task_id, chat_id, json.dumps(tuple(dict.fromkeys(session_ids))), question, model),
                )
            future = self._worker.submit(
                self._capture, db, task_id, session_ids, accepted, cancel, max_seconds,
            )
            self._captures[task_id] = future, cancel
        # No full-copy wait and no queue lock held during the worker handshake.
        if not accepted.wait(timeout=max_seconds):
            self.cancel(task_id)
            raise TimeoutError("Snapshot acceptance timed out")
        return self.get(task_id)

    def _capture(
        self, db: Database, task_id: str, sessions: tuple[str, ...], accepted: Event,
        cancel: Event, max_seconds: float,
    ) -> None:
        try:
            with TranscriptSnapshot.capture(
                db, sessions, cancel=cancel, max_seconds=max_seconds, on_pinned=accepted.set,
            ) as snapshot:
                snapshot.save(self._path(task_id), cancel=cancel, max_seconds=max_seconds)
                with self._lock:
                    if cancel.is_set():
                        self._path(task_id).unlink(missing_ok=True)
                    else:
                        with self._db:
                            self._db.execute(
                                "UPDATE tasks SET status='queued',snapshot_id=? "
                                "WHERE id=? AND status='preparing'",
                                (snapshot.id, task_id),
                            )
        except Exception:
            with self._lock:
                with self._db:
                    self._db.execute(
                        "UPDATE tasks SET status='failed',error='capture_failed' "
                        "WHERE id=? AND status='preparing'",
                        (task_id,),
                    )
                self._path(task_id).unlink(missing_ok=True)
        finally:
            accepted.set()

    def wait(self, task_id: str, *, timeout: float = 10) -> SnapshotTask:
        """Wait for capture, not execution. Intended for shutdown/tests, never an ASR loop."""
        with self._lock:
            self.get(task_id)
            pending = self._captures.get(task_id)
        if pending is not None:
            pending[0].result(timeout=timeout)
        return self.get(task_id)

    def claim_next(self) -> SnapshotTask | None:
        """Explicit dispatcher action; construction/resume never invokes a provider."""
        with self._lock:
            tasks = self.list()
            if any(t.status in ("running", "stopping") for t in tasks):
                return None
            task = next((t for t in tasks if t.status in ("preparing", "queued")), None)
            if task is None or task.status == "preparing":
                return None
            with self._db:
                self._db.execute("UPDATE tasks SET status='running' WHERE id=?", (task.id,))
            return self.get(task.id)

    def resume(self, task_id: str) -> None:
        with self._lock:
            if self.get(task_id).status != "paused":
                raise ValueError("Only paused tasks can resume")
            with self._db:
                self._db.execute("UPDATE tasks SET status='queued' WHERE id=?", (task_id,))

    def pause(self, task_id: str, error: str = "execution_interrupted") -> None:
        """Preserve the snapshot for explicit resume after the runner has stopped."""
        with self._lock:
            if self.get(task_id).status != "running":
                raise ValueError("Task is not running")
            with self._db:
                self._db.execute("UPDATE tasks SET status='paused',error=? WHERE id=?", (error, task_id))

    def checkpoint(self, task_id: str, answer: str) -> None:
        if len(answer.encode()) > 1024 * 1024:
            raise ValueError("Answer exceeds limit")
        with self._lock:
            if self.get(task_id).status != "running":
                raise ValueError("Task is not running")
            with self._db:
                self._db.execute("UPDATE tasks SET answer=? WHERE id=?", (answer, task_id))

    def finish(
        self, task_id: str, status: Literal["completed", "failed"], answer: str, *, error: str | None = None,
    ) -> None:
        if status not in ("completed", "failed"):
            raise ValueError("Invalid terminal status")
        with self._lock:
            self.checkpoint(task_id, answer)
            with self._db:
                self._db.execute("UPDATE tasks SET status=?,error=? WHERE id=?", (status, error, task_id))
            self._path(task_id).unlink(missing_ok=True)

    def cancel(self, task_id: str) -> None:
        with self._lock:
            task = self.get(task_id)
            if task.status not in LIVE:
                return
            pending = self._captures.get(task_id)
            if pending is not None:
                pending[1].set()
            with self._db:
                self._db.execute("UPDATE tasks SET status=? WHERE id=?",
                                 ("stopping" if task.status in ("running", "stopping") else "cancelled",
                                  task_id))
            self._path(task_id).unlink(missing_ok=True)

    def acknowledge_cancel(self, task_id: str) -> None:
        """Dispatcher confirms the old execution has stopped before freeing its slot."""
        with self._lock:
            if self.get(task_id).status != "stopping":
                raise ValueError("Task is not stopping")
            with self._db:
                self._db.execute("UPDATE tasks SET status='cancelled' WHERE id=?", (task_id,))

    def read(
        self, task_id: str, session_id: str, *, start_ms: int = 0, end_ms: int | None = None,
        after: int = 0, limit: int = 20, query: str = "",
    ) -> dict[str, Any]:
        with self._lock:
            task = self.get(task_id)
            if task.status not in ("queued", "running", "paused") or session_id not in task.session_ids:
                raise ValueError("Task snapshot unavailable or session outside scope")
            with TranscriptSnapshot.open(self._path(task_id)) as snapshot:
                if snapshot.id != task.snapshot_id:
                    raise ValueError("Snapshot identity mismatch")
                return snapshot.read(session_id, start_ms=start_ms, end_ms=end_ms,
                                     after=after, limit=limit, query=query)

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            # Captures cannot be reconstructed at the original cutoff after restart.
            for task_id, (_, cancel) in self._captures.items():
                if self.get(task_id).status == "preparing":
                    cancel.set()
            self._closed = True
        self._worker.shutdown(wait=True)
        with self._lock:
            with self._db:
                self._db.execute("UPDATE tasks SET status='paused' WHERE status IN ('queued','running')")
            self._db.close()
            self._owner.close()

    def __enter__(self) -> SnapshotQueue:
        return self

    def __exit__(
        self, exc_type: type[BaseException] | None, exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self.close()
