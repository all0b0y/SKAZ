"""Codex notes: one clean document with sentence-level provenance, restarted after interruption.

Real temporary SQLite, real queue and a real subprocess App Server peer. The replies
are authored fixture text, not model evaluation (see CODEX-NOTES-FIX-SPEC.md).
"""
from __future__ import annotations

import asyncio
import json
import sys
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import pytest

from audiohelper import monologues as mono
from audiohelper import note_store
from audiohelper import repository as repo
from audiohelper.agent.codex_dispatcher import CodexDispatcher
from audiohelper.agent.codex_notes import note_problems, notes_request
from audiohelper.agent.codex_runtime import CodexRuntime
from audiohelper.agent.snapshot_queue import SnapshotQueue, SnapshotTask
from audiohelper.agent.transcript_snapshot import TranscriptSnapshot
from audiohelper.codex_schemas import CodexSettings
from audiohelper.db import Database
from audiohelper.gateways.codex_rpc import CodexRpc
from audiohelper.gateways.codex_session import CodexSession
from audiohelper.schemas import Segment

RUNTIME_FIXTURE = Path(__file__).parent / "fixtures/codex_runtime_server.py"
SESSION_FIXTURE = Path(__file__).parent / "fixtures/codex_session_server.py"


async def generate(tmp_path: Path, answers: list[str]) -> tuple[Database, CodexRuntime, str, dict[str, Any]]:
    db = Database(tmp_path / "app.sqlite")
    sid = repo.create_session(db, "Authored lecture").id
    repo.replace_chunk_segments(db, sid, 0, [
        Segment(id="s1", start_ms=0, end_ms=1000, text="Profit is an indicator of sustainability."),
    ])
    service = CodexRuntime(db, tmp_path / "codex")
    env = {"FIXTURE_ANSWERS": json.dumps(answers)} if answers else {}
    service.connection.rpc = lambda: CodexRpc(  # type: ignore[method-assign]
        (sys.executable, str(RUNTIME_FIXTURE)), cwd=tmp_path, env=env,
    )
    service.connection.view.update(status="connected", models=[{"id": "fixture", "efforts": ["high"]}])
    await service.configure(CodexSettings(notes_enabled=True, notes_model="fixture", notes_effort="high"))
    task = await service.notes(sid, "Russian", "normal")
    await service.dispatcher.idle()
    service._finalize(service.queue.get(task["id"]))
    return db, service, sid, task


async def test_codex_note_is_stored_without_labels_and_cites_the_monologue(tmp_path: Path) -> None:
    db, service, sid, _task = await generate(tmp_path, [])
    try:
        note = note_store.list_notes(db, sid)[0]
        assert note.content == "# Authored note\n\nAuthored fixture answer"
        assert "[P" not in note.content
        [citation] = note.citations
        assert citation.monologue_id == "s1" and citation.segment_id == "s1"
        assert citation.text == "Profit is an indicator of sustainability."
        assert citation.labels == []
    finally:
        await service.close()
        db.close()


async def test_two_documents_get_one_correction_then_save_one(tmp_path: Path) -> None:
    doubled = "# Lecture\n\nFirst copy [P1]\n\n# Lecture\n\nSecond copy [P1]"
    db, service, sid, task = await generate(tmp_path, [doubled, "# Lecture\n\nOnly copy [P1]"])
    try:
        assert service.queue.get(task["id"]).status == "completed"
        [note] = note_store.list_notes(db, sid)
        assert note.content == "# Lecture\n\nOnly copy"
    finally:
        await service.close()
        db.close()


async def test_second_bad_answer_discards_the_note(tmp_path: Path) -> None:
    db, service, sid, task = await generate(tmp_path, ["# A\n\nx [P1]\n\n# B\n\ny [P1]", "# A\n\nx [P7]"])
    try:
        result = service.queue.get(task["id"])
        assert (result.status, result.error, result.answer) == ("failed", "answer_rejected", "")
        assert note_store.list_notes(db, sid) == []
    finally:
        await service.close()
        db.close()


def test_note_rules_are_the_ordinary_ones_and_the_check_reads_structure() -> None:
    request = notes_request("Russian", "brief")
    assert "Use only what the transcript says" in request
    assert "retain every substantive explanation and distinct example" in request
    assert "self-contained" in request and "SKAZ_NOTE_CONTINUE" in request
    assert "exactly ONE note" in request and "tables are allowed" in request
    assert note_problems("# T\n\nx [P1]", {"P1"}) == []
    # A '#' line inside a fenced block is code, not a second document.
    assert note_problems("# T\n\n```\n# comment\n```\nx [P1]", {"P1"}) == []
    assert len(note_problems("# T\n\nx [P1]\n# T\n\nx [P1]", {"P1"})) == 1
    assert any("P9" in p for p in note_problems("# T\n\nx [P9]", {"P1"}))
    assert any("cites no" in p for p in note_problems("# T\n\nx", {"P1"}))


async def test_resumed_task_restarts_its_answer_instead_of_appending(tmp_path: Path) -> None:
    db = Database(tmp_path / "source.sqlite")
    queue = SnapshotQueue(tmp_path / "queue")
    launches = 0

    @asynccontextmanager
    async def runner(task: SnapshotTask) -> AsyncIterator[CodexSession]:
        nonlocal launches
        launches += 1
        # First run times out after streaming "Final"; the resumed run completes it.
        timeout = 0.15 if launches == 1 else 5
        async with CodexRpc((sys.executable, str(SESSION_FIXTURE)), cwd=tmp_path, env={}) as rpc:
            yield CodexSession(rpc, cwd=tmp_path, model=task.model, tools=[], turn_timeout=timeout)

    dispatcher = CodexDispatcher(queue, runner)
    writes: list[tuple[int, str]] = []
    original = queue.checkpoint

    def recording(task_id: str, answer: str) -> None:
        writes.append((launches, answer))
        original(task_id, answer)

    queue.checkpoint = recording  # type: ignore[method-assign]
    try:
        sid = repo.create_session(db, "fixture").id
        task = await asyncio.to_thread(
            queue.enqueue, db, chat_id="a", session_ids=(sid,), question="case:stream", model="fixture"
        )
        await asyncio.to_thread(queue.wait, task.id)
        dispatcher.wake()
        await dispatcher.idle()
        assert queue.get(task.id).status == "paused" and queue.get(task.id).answer == "Final"
        queue.resume(task.id)
        dispatcher.wake()
        async with asyncio.timeout(3):
            while not any(run == 2 and "Final" in answer for run, answer in writes):
                await asyncio.sleep(0.01)
        # The old code produced "Final\n\nFinal" here: the partial run glued to the new one.
        assert queue.get(task.id).answer == "Final"
        assert all(not answer.startswith("Final\n") for _run, answer in writes)
        await dispatcher.stop(task.id)
    finally:
        await dispatcher.close()
        db.close()


async def test_restart_resets_what_the_interrupted_run_read(tmp_path: Path) -> None:
    db = Database(tmp_path / "app.sqlite")
    sid = repo.create_session(db, "x").id
    service = CodexRuntime(db, tmp_path / "codex")
    try:
        service._save_meta("t" * 32, {
            "kind": "notes", "effort": "high", "context": [], "finalized": False, "session_id": sid,
            "citations": {"x:1": {"labels": ["P1"]}}, "coverage": {sid: 5}, "activity": ["Read"],
        })
        first = service._restart("t" * 32)
        assert (first["citations"], first["coverage"], first["activity"]) == ({}, {}, [])
        assert first["attempts"] == 1
        assert service._restart("t" * 32)["attempts"] == 2
    finally:
        await service.close()
        db.close()


def test_snapshot_blocks_are_the_monologues_of_the_whole_session(tmp_path: Path) -> None:
    db = Database(tmp_path / "source.sqlite")
    try:
        sid = repo.create_session(db, "Long speaker").id
        # 300 short chunks, one speaker, no pauses: one monologue by the shared module,
        # which the old 256-token pre-chunking split into two blocks.
        segments = [
            Segment(id=f"c{i:03}", start_ms=i * 100, end_ms=i * 100 + 90, text="да")
            for i in range(300)
        ]
        repo.replace_chunk_segments(db, sid, 0, segments)
        expected = mono.build([
            mono.Token(s.id, s.text + " ", s.start_ms, s.end_ms, None, s.id) for s in segments
        ])
        with TranscriptSnapshot.capture(db, (sid,)) as snapshot:
            blocks = snapshot.read(sid, limit=100)["blocks"]
        assert len(blocks) == len(expected) == 1
        assert blocks[0]["start_token_id"] == expected[0].id
        assert blocks[0]["segment_id"] == "c000"
    finally:
        db.close()


@pytest.mark.parametrize("attempts,restarted", [(1, False), (2, True)])
async def test_chat_answer_regenerated_after_interruption_is_marked(
    tmp_path: Path, attempts: int, restarted: bool,
) -> None:
    db = Database(tmp_path / "app.sqlite")
    sid = repo.create_session(db, "x").id
    service = CodexRuntime(db, tmp_path / "codex")
    try:
        cid = service.chats.create(sid, "session")["id"]
        tid = "a" * 32
        service._save_meta(tid, {"kind": "assistant", "attempts": attempts})
        service.chats.append(cid, "assistant", "Answer", [], identity=tid + "-answer")
        [message] = service.messages(cid)
        assert message["restarted"] is restarted
    finally:
        await service.close()
        db.close()
