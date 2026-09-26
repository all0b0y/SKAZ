"""Task/snapshot lifecycle seam with real disk and authored source data."""
from pathlib import Path

import pytest

from audiohelper import repository as repo
from audiohelper.agent.snapshot_queue import SnapshotQueue
from audiohelper.db import Database
from audiohelper.schemas import Segment


def test_queued_requests_own_snapshots_and_restart_requires_manual_resume(tmp_path: Path) -> None:
    db = Database(tmp_path / "source.sqlite")
    sid = repo.create_session(db, "Fixture").id
    repo.replace_chunk_segments(db, sid, 0, [
        Segment(id="old", start_ms=0, end_ms=1000, text="Before."),
    ])
    root = tmp_path / "queue"
    try:
        with SnapshotQueue(root) as queue:
            first = queue.enqueue(db, chat_id="one", session_ids=(sid,), question="First?", model="fixture")
            queue.wait(first.id, timeout=3)
            repo.replace_chunk_segments(db, sid, 0, [
                Segment(id="new", start_ms=0, end_ms=1000, text="After."),
            ])
            second = queue.enqueue(db, chat_id="two", session_ids=(sid,), question="Second?", model="fixture")
            queue.wait(second.id, timeout=3)
            claimed = queue.claim_next()
            assert claimed is not None and claimed.id == first.id
            assert queue.claim_next() is None
            queue.checkpoint(first.id, "Partial answer")
            before = queue.read(first.id, sid)
            assert before["blocks"][0]["text"] == "Before."
            assert queue.read(second.id, sid)["blocks"][0]["text"] == "After."
        db.close()
        with SnapshotQueue(root) as restored:
            assert [t.status for t in restored.list()] == ["paused", "paused"]
            assert restored.get(first.id).answer == "Partial answer"
            assert restored.claim_next() is None
            assert restored.read(first.id, sid) == before
            restored.resume(second.id)
            claimed = restored.claim_next()
            assert claimed is not None and claimed.id == second.id
            restored.finish(second.id, "completed", "Answer")
            assert restored.get(second.id).status == "completed"
            restored.cancel(first.id)
            assert restored.get(first.id).status == "cancelled"
            with pytest.raises(ValueError):
                restored.read(first.id, sid)
            assert not list((root / "snapshots").glob("*.sqlite"))
    finally:
        db.close()


def test_running_cancel_holds_execution_slot_until_acknowledged(tmp_path: Path) -> None:
    db = Database(tmp_path / "source.sqlite")
    try:
        sid = repo.create_session(db, "Fixture").id
        with SnapshotQueue(tmp_path / "queue") as queue:
            one = queue.enqueue(db, chat_id="one", session_ids=(sid,), question="One?", model="fixture")
            queue.wait(one.id)
            two = queue.enqueue(db, chat_id="two", session_ids=(sid,), question="Two?", model="fixture")
            queue.wait(two.id)
            assert queue.claim_next() is not None
            queue.cancel(one.id)
            assert queue.get(one.id).status == "stopping"
            assert queue.claim_next() is None
            with pytest.raises(ValueError):
                queue.read(one.id, sid)
            with pytest.raises(ValueError):
                queue.finish(one.id, "completed", "Late result")
            queue.acknowledge_cancel(one.id)
            assert queue.get(one.id).status == "cancelled"
            claimed = queue.claim_next()
            assert claimed is not None and claimed.id == two.id
    finally:
        db.close()
