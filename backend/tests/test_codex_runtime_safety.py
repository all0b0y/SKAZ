"""Runtime safety against real temporary SQLite; no model/network calls."""

from __future__ import annotations

import asyncio
import json
import sqlite3
import sys
import threading
from pathlib import Path
from typing import Any

import pytest

from skaz import note_store
from skaz import repository as repo
from skaz.agent.codex_runtime import CodexRuntime
from skaz.codex_schemas import CodexSettings
from skaz.db import Database
from skaz.gateways.codex_rpc import CodexRpc


@pytest.mark.asyncio
async def test_dispatch_waits_for_submission_metadata(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    db, service, _sid, cid = service_at(tmp_path)
    saving = threading.Event()
    release = threading.Event()
    original_save = service._save_meta
    fixture = Path(__file__).parent / "fixtures/codex_runtime_server.py"

    def delayed_save(task_id: str, meta: dict[str, Any]) -> None:
        if not saving.is_set():
            saving.set()
            assert release.wait(5), "Test did not release metadata write"
        original_save(task_id, meta)

    monkeypatch.setattr(service, "_save_meta", delayed_save)
    monkeypatch.setattr(service.connection, "rpc", lambda: CodexRpc(
        (sys.executable, str(fixture)), cwd=tmp_path, env={},
    ))
    submission = asyncio.create_task(service.submit(cid, "Authored admission test"))
    try:
        assert await asyncio.to_thread(saving.wait, 5)
        # Simulate an already-active pump picking up the newly published snapshot.
        service.dispatcher.wake()
        async with asyncio.timeout(5):
            while not any(t.status in {"running", "paused"} for t in service.queue.list()):
                await asyncio.sleep(0.01)
        # Allow validation to execute if it is not gated on admission.
        await asyncio.sleep(0.1)
        assert service.queue.list()[0].status == "running"
        release.set()
        task = await submission
        await service.dispatcher.idle()
        result = service.queue.get(task["id"])
        assert result.status == "completed"
        service._finalize(result)
        assert [m["role"] for m in service.chats.messages(cid)] == ["user", "assistant"]
    finally:
        release.set()
        await asyncio.gather(submission, return_exceptions=True)
        await service.close()
        db.close()


def service_at(tmp_path: Path) -> tuple[Database, CodexRuntime, str, str]:
    db = Database(tmp_path / "app.sqlite")
    sid = repo.create_session(db, "Authored source").id
    service = CodexRuntime(db, tmp_path / "codex")
    service.connection.view.update(status="connected", models=[{"id": "fixture", "efforts": ["high"]}])
    service._save_settings(
        CodexSettings(
            assistant_enabled=True, notes_enabled=True,
            assistant_model="fixture",
            notes_model="fixture",
            assistant_effort="high",
            notes_effort="high",
        )
    )
    cid = service.chats.create(sid, "session")["id"]
    return db, service, sid, cid


async def prepared(service: CodexRuntime, sid: str, cid: str) -> str:
    task = service.queue.enqueue(
        service.db, chat_id=cid, session_ids=(sid,), question="Note", model="fixture"
    )
    for _ in range(100):
        if service.queue.get(task.id).status == "queued":
            break
        await asyncio.sleep(0.01)
    assert service.queue.claim_next() is not None
    service._save_meta(
        task.id,
        {
            "kind": "notes",
            "effort": "high",
            "context": [],
            "citations": {},
            "coverage": {},
            "finalized": False,
            "session_id": sid,
        },
    )
    return task.id


@pytest.mark.asyncio
async def test_note_and_message_roll_back_if_finalization_marker_fails(tmp_path: Path) -> None:
    db, service, sid, cid = service_at(tmp_path)
    try:
        tid = await prepared(service, sid, cid)
        service.queue.finish(tid, "completed", "Authored note")
        with db.write() as c:
            c.execute(
                "CREATE TRIGGER reject_marker BEFORE INSERT ON codex_task_meta "
                "BEGIN SELECT RAISE(ABORT, 'fixture marker failure'); END"
            )
        with pytest.raises(sqlite3.IntegrityError, match="fixture marker failure"):
            service._finalize(service.queue.get(tid))
        assert note_store.list_notes(db, sid) == []
        assert service.chats.messages(cid) == []
        assert service._meta(tid)["finalized"] is False
        with db.write() as c:
            c.execute("DROP TRIGGER reject_marker")
        service._finalize(service.queue.get(tid))
        service._finalize(service.queue.get(tid))
        assert len(note_store.list_notes(db, sid)) == 1
        assert len(service.chats.messages(cid)) == 1
    finally:
        await service.close()
        db.close()


@pytest.mark.asyncio
async def test_read_notes_rejects_unknown_arguments(tmp_path: Path) -> None:
    db, service, sid, cid = service_at(tmp_path)
    try:
        tid = await prepared(service, sid, cid)
        assert [t.name for t in service._tools(service.queue.get(tid))] == ["skaz_read_transcript"]
        meta = service._meta(tid)
        meta["kind"] = "assistant"
        service._save_meta(tid, meta)
        tool = next(t for t in service._tools(service.queue.get(tid)) if t.name == "skaz_read_notes")
        assert json.loads(await tool.handler({"session_id": sid})) == {"notes": []}
        with pytest.raises(ValueError):
            await tool.handler({"session_id": sid, "sql": "SELECT * FROM secrets"})
    finally:
        await service.close()
        db.close()


@pytest.mark.asyncio
async def test_constructor_does_not_take_queue_ownership_and_close_never_acquires(tmp_path: Path) -> None:
    db, first, _sid, _cid = service_at(tmp_path)
    second = CodexRuntime(db, tmp_path / "codex")
    try:
        first.start()
        with pytest.raises(sqlite3.OperationalError, match="locked"):
            second.start()
        await second.close()
        assert first.queue.list() == []
        await first.close()
        third = CodexRuntime(db, tmp_path / "codex")
        third.start()
        await third.close()
    finally:
        await first.close()
        db.close()

@pytest.mark.asyncio
async def test_preview_confirmation_revision_and_marker_are_atomic(tmp_path: Path) -> None:
    db, service, sid, cid = service_at(tmp_path)
    try:
        tid = await prepared(service, sid, cid)
        note = repo.add_note(db, sid, "Original", "fixture", [])
        task = service.queue.get(tid)
        preview = service._propose(task, {"session_id": sid, "note_id": note.id, "content": "Replacement"})
        pid = preview["preview_id"]
        assert note_store.list_notes(db, sid)[0].content == "Original"
        with db.write() as c:
            c.execute("CREATE TRIGGER reject_preview BEFORE UPDATE ON codex_previews "
                      "BEGIN SELECT RAISE(ABORT, 'fixture preview failure'); END")
        with pytest.raises(sqlite3.IntegrityError):
            service.apply_preview(pid, apply=True)
        assert note_store.list_notes(db, sid)[0].content == "Original"
        assert len(service.previews(cid)) == 1
        with db.write() as c:
            c.execute("DROP TRIGGER reject_preview")
            note_store._replace(c, sid, note.id, note.revision, "Manual edit", None, None)
        with pytest.raises(note_store.NoteConflict):
            service.apply_preview(pid, apply=True)
        assert note_store.list_notes(db, sid)[0].content == "Manual edit"
        service.apply_preview(pid, apply=False)
        second = service._propose(task, {"session_id": sid, "note_id": note.id, "content": "Approved"})
        service.apply_preview(second["preview_id"], apply=True)
        revision = note_store.list_notes(db, sid)[0].revision
        with pytest.raises(ValueError, match="already resolved"):
            service.apply_preview(second["preview_id"], apply=True)
        assert note_store.list_notes(db, sid)[0].revision == revision
        assert note_store.list_notes(db, sid)[0].content == "Approved"
    finally:
        await service.close()
        db.close()

