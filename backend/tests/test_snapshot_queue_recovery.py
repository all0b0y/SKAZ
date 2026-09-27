"""Capture admission, cancellation and crash recovery at OS/SQLite boundaries."""
import sqlite3
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event
from typing import Any

import pytest

from skaz import repository as repo
from skaz.agent.snapshot_queue import SnapshotQueue
from skaz.db import Database
from skaz.schemas import Segment


@pytest.mark.parametrize("cancel_capture", [False, True])
def test_enqueue_pins_before_return_without_waiting_for_copy(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, cancel_capture: bool,
) -> None:
    db = Database(tmp_path / "source.sqlite")
    sid = repo.create_session(db, "Fixture").id
    repo.replace_chunk_segments(db, sid, 0, [
        Segment(id="old", start_ms=0, end_ms=1000, text="Before."),
    ])
    entered, release = Event(), Event()
    connect = sqlite3.connect

    def trace(sql: str) -> None:
        if "FROM native_token_events" in sql:
            entered.set()
            release.wait(timeout=5)

    def traced_connect(*args: Any, **kwargs: Any) -> sqlite3.Connection:
        connection: sqlite3.Connection = connect(*args, **kwargs)
        connection.set_trace_callback(trace)
        return connection

    try:
        with SnapshotQueue(tmp_path / "queue") as queue, ThreadPoolExecutor(max_workers=1) as writer:
            monkeypatch.setattr(sqlite3, "connect", traced_connect)
            task = queue.enqueue(
                db, chat_id="chat", session_ids=(sid,), question="Question?", model="fixture",
            )
            try:
                assert entered.wait(timeout=2)
                assert task.status == "preparing"
                assert queue.claim_next() is None
                with pytest.raises(ValueError, match="busy"):
                    queue.enqueue(db, chat_id="other", session_ids=(sid,), question="Other?", model="fixture")
                writer.submit(repo.replace_chunk_segments, db, sid, 0, [
                    Segment(id="new", start_ms=0, end_ms=1000, text="After."),
                ]).result(timeout=2)
                if cancel_capture:
                    queue.cancel(task.id)
                    assert queue.get(task.id).status == "cancelled"
            finally:
                release.set()
            result = queue.wait(task.id, timeout=3)
            if cancel_capture:
                assert result.status == "cancelled"
                with pytest.raises(ValueError):
                    queue.read(task.id, sid)
                assert not list((tmp_path / "queue" / "snapshots").iterdir())
            else:
                assert result.status == "queued"
                assert queue.read(task.id, sid)["blocks"][0]["text"] == "Before."
            with db.write() as source:
                assert tuple(source.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()) == (0, 0, 0)
    finally:
        release.set()
        db.close()


def test_exclusive_owner_capacity_chat_and_scope_guards(tmp_path: Path) -> None:
    db = Database(tmp_path / "source.sqlite")
    sid = repo.create_session(db, "Fixture").id
    try:
        with SnapshotQueue(tmp_path / "queue", max_pending=2) as queue:
            with pytest.raises(sqlite3.OperationalError, match="locked"):
                SnapshotQueue(tmp_path / "queue")
            task = queue.enqueue(
                db, chat_id="chat", session_ids=(sid,), question="Question?", model="fixture",
            )
            queue.wait(task.id)
            with pytest.raises(ValueError, match="unfinished"):
                queue.enqueue(db, chat_id="chat", session_ids=(sid,), question="Again?", model="fixture")
            with pytest.raises(ValueError, match="outside scope"):
                queue.read(task.id, "other")
            second = queue.enqueue(
                db, chat_id="second", session_ids=(sid,), question="Next?", model="fixture",
            )
            queue.wait(second.id)
            with pytest.raises(ValueError, match="capacity"):
                queue.enqueue(db, chat_id="third", session_ids=(sid,), question="Last?", model="fixture")
    finally:
        db.close()


CRASH_SCRIPT = '''
import os, sqlite3, sys
from pathlib import Path
from skaz import repository as repo
from skaz.agent.snapshot_queue import SnapshotQueue
from skaz.db import Database
from skaz.schemas import Segment
root, stage = Path(sys.argv[1]), sys.argv[2]
db = Database(root / "source.sqlite")
sid = repo.create_session(db, "Fixture").id
repo.replace_chunk_segments(db, sid, 0, [Segment(id="source", start_ms=0, end_ms=1000, text="Evidence.")])
connect = sqlite3.connect
def trace(sql):
    if stage == "copying" and "INSERT INTO blocks" in sql:
        os._exit(0)
    if stage == "published" and "UPDATE tasks SET status='queued'" in sql:
        os._exit(0)
def traced_connect(*args, **kwargs):
    c = connect(*args, **kwargs)
    c.set_trace_callback(trace)
    return c
sqlite3.connect = traced_connect
queue = SnapshotQueue(root / "queue")
task = queue.enqueue(
                db, chat_id="chat", session_ids=(sid,), question="Question?", model="fixture",
            )
queue.wait(task.id)
if stage in ("running", "stopping"):
    queue.claim_next()
    queue.checkpoint(task.id, "Saved partial")
if stage == "stopping":
    queue.cancel(task.id)
os._exit(0)
'''


@pytest.mark.parametrize("stage", ["copying", "published", "queued", "running", "stopping"])
def test_hard_process_exit_recovers_without_repinning_or_autostart(tmp_path: Path, stage: str) -> None:
    process = subprocess.run([sys.executable, "-c", CRASH_SCRIPT, str(tmp_path), stage],
                             capture_output=True, text=True, timeout=10)
    assert process.returncode == 0, process.stderr
    with SnapshotQueue(tmp_path / "queue") as queue:
        tasks = queue.list()
        assert len(tasks) == 1
        task = tasks[0]
        assert queue.claim_next() is None
        if stage in ("copying", "published", "stopping"):
            assert task.status == ("cancelled" if stage == "stopping" else "failed")
            with pytest.raises(ValueError):
                queue.resume(task.id)
            assert not list((tmp_path / "queue" / "snapshots").iterdir())
        else:
            assert task.status == "paused"
            assert queue.read(task.id, task.session_ids[0])["blocks"][0]["text"] == "Evidence."
            if stage == "running":
                assert task.answer == "Saved partial"


@pytest.mark.parametrize("damage", ["missing", "corrupt", "missing_blocks"])
def test_recovery_refuses_missing_or_corrupt_snapshot(tmp_path: Path, damage: str) -> None:
    db = Database(tmp_path / "source.sqlite")
    try:
        sid = repo.create_session(db, "Fixture").id
        with SnapshotQueue(tmp_path / "queue") as queue:
            task = queue.enqueue(
                db, chat_id="chat", session_ids=(sid,), question="Question?", model="fixture",
            )
            queue.wait(task.id)
        path = tmp_path / "queue" / "snapshots" / f"{task.id}.sqlite"
        if damage == "missing":
            path.unlink()
        elif damage == "missing_blocks":
            connection = sqlite3.connect(path)
            try:
                connection.execute("DROP TABLE blocks")
                connection.commit()
            finally:
                connection.close()
        else:
            path.write_bytes(b"not SQLite")
        with SnapshotQueue(tmp_path / "queue") as restored:
            assert restored.get(task.id).status == "failed"
            assert restored.get(task.id).error == "snapshot_unavailable"
            assert restored.claim_next() is None
    finally:
        db.close()
