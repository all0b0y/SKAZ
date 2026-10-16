"""Real queue + real subprocess transport; authored replies are not model evaluation."""

from __future__ import annotations

import asyncio
import sys
import threading
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import pytest

from skaz import repository as repo
from skaz.agent.codex_dispatcher import CodexDispatcher
from skaz.agent.snapshot_queue import SnapshotQueue, SnapshotTask
from skaz.db import Database
from skaz.gateways.codex_rpc import CodexRpc
from skaz.gateways.codex_session import CodexSession, ToolDefinition

FIXTURE = Path(__file__).parent / "fixtures" / "codex_session_server.py"


@pytest.mark.parametrize("boundary,wake_again", [("claim_next", False), ("claim_next", True), ("list", True)])
async def test_snapshot_publication_during_idle_check_is_not_lost(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, boundary: str, wake_again: bool,
) -> None:
    db = Database(tmp_path / "source.sqlite")
    queue = SnapshotQueue(tmp_path / "queue")
    checked = threading.Event()
    release = threading.Event()
    original = getattr(queue, boundary)
    checks = 0

    def delayed_check() -> Any:
        nonlocal checks
        result = original()
        checks += 1
        # claim_next internally calls list under its lock; pause only the
        # dispatcher's later standalone list, outside the queue lock.
        if checks == (2 if boundary == "list" else 1):
            checked.set()
            assert release.wait(5), "Test did not release queue check"
        return result

    async def read(arguments: dict[str, Any]) -> str:
        return "Authored evidence"

    @asynccontextmanager
    async def runner(task: SnapshotTask) -> AsyncIterator[CodexSession]:
        async with CodexRpc((sys.executable, str(FIXTURE)), cwd=tmp_path, env={}) as rpc:
            yield CodexSession(rpc, cwd=tmp_path, model=task.model, tools=[
                ToolDefinition("skaz_read_range", "fixture", {"type": "object"}, read),
            ])

    dispatcher = CodexDispatcher(queue, runner)
    monkeypatch.setattr(queue, boundary, delayed_check)
    try:
        sid = repo.create_session(db, "fixture").id
        dispatcher.wake()
        assert await asyncio.to_thread(checked.wait, 5)
        task = await asyncio.to_thread(
            queue.enqueue, db, chat_id="a", session_ids=(sid,), question="case:plain", model="fixture",
        )
        await asyncio.to_thread(queue.wait, task.id)
        if wake_again:
            dispatcher.wake()
        release.set()
        await dispatcher.idle()
        assert queue.get(task.id).status == "completed"
    finally:
        release.set()
        await dispatcher.close()
        db.close()


async def test_dispatcher_serializes_processes_and_streams_to_disk(tmp_path: Path) -> None:
    db = Database(tmp_path / "source.sqlite")
    queue = SnapshotQueue(tmp_path / "queue")
    live = 0
    maximum = 0
    started: list[str] = []

    @asynccontextmanager
    async def runner(task: SnapshotTask) -> AsyncIterator[CodexSession]:
        nonlocal live, maximum
        live += 1
        maximum = max(maximum, live)
        started.append(task.id)

        async def read(arguments: dict[str, object]) -> str:
            return "Authored evidence"

        try:
            async with CodexRpc((sys.executable, str(FIXTURE)), cwd=tmp_path, env={}) as rpc:
                yield CodexSession(
                    rpc,
                    cwd=tmp_path,
                    model=task.model,
                    tools=[
                        ToolDefinition("skaz_read_range", "fixture", {"type": "object"}, read),
                    ],
                )
        finally:
            live -= 1

    dispatcher = CodexDispatcher(queue, runner)
    try:
        sid = repo.create_session(db, "fixture").id
        tasks = []
        for chat in ("a", "b"):
            task = await asyncio.to_thread(
                queue.enqueue, db, chat_id=chat, session_ids=(sid,), question="answer", model="fixture"
            )
            await asyncio.to_thread(queue.wait, task.id)
            tasks.append(task)
        assert started == []
        dispatcher.wake()
        await dispatcher.idle()
        assert maximum == 1 and live == 0
        assert started == [t.id for t in tasks]
        assert [queue.get(t.id).answer for t in tasks] == ["Fixture answer"] * 2
        assert all(queue.get(t.id).status == "completed" for t in tasks)
    finally:
        await dispatcher.close()
        db.close()


async def test_stop_reaps_process_before_releasing_slot_and_preserves_checkpoint(tmp_path: Path) -> None:
    db = Database(tmp_path / "source.sqlite")
    queue = SnapshotQueue(tmp_path / "queue")
    processes: list[CodexRpc] = []

    @asynccontextmanager
    async def runner(task: SnapshotTask) -> AsyncIterator[CodexSession]:
        async with CodexRpc((sys.executable, str(FIXTURE)), cwd=tmp_path, env={}) as rpc:
            processes.append(rpc)
            yield CodexSession(rpc, cwd=tmp_path, model=task.model, tools=[])

    dispatcher = CodexDispatcher(queue, runner)
    try:
        sid = repo.create_session(db, "fixture").id
        task = await asyncio.to_thread(
            queue.enqueue, db, chat_id="a", session_ids=(sid,), question="case:stream", model="fixture"
        )
        await asyncio.to_thread(queue.wait, task.id)
        dispatcher.wake()
        async with asyncio.timeout(2):
            while queue.get(task.id).answer != "Final":
                await asyncio.sleep(0.01)
        await dispatcher.stop(task.id)
        assert processes[0].closed
        assert queue.get(task.id).status == "cancelled"
        assert queue.get(task.id).answer == "Final"
    finally:
        await dispatcher.close()
        db.close()


async def test_timeout_pauses_without_retry_and_restart_requires_resume(tmp_path: Path) -> None:
    db = Database(tmp_path / "source.sqlite")
    root = tmp_path / "queue"
    queue = SnapshotQueue(root)
    launches = []

    @asynccontextmanager
    async def runner(task: SnapshotTask) -> AsyncIterator[CodexSession]:
        launches.append(task.id)
        async with CodexRpc((sys.executable, str(FIXTURE)), cwd=tmp_path, env={}) as rpc:
            yield CodexSession(rpc, cwd=tmp_path, model=task.model, tools=[], turn_timeout=0.15)

    dispatcher = CodexDispatcher(queue, runner)
    try:
        sid = repo.create_session(db, "fixture").id
        task = await asyncio.to_thread(
            queue.enqueue, db, chat_id="a", session_ids=(sid,), question="case:stream", model="fixture"
        )
        await asyncio.to_thread(queue.wait, task.id)
        dispatcher.wake()
        await dispatcher.idle()
        assert queue.get(task.id).status == "paused"
        assert queue.get(task.id).answer == "Final"
        dispatcher.wake()
        await dispatcher.idle()
        assert launches == [task.id]
    finally:
        await dispatcher.close()
        db.close()
    with SnapshotQueue(root) as restored:
        assert restored.get(task.id).status == "paused"
        assert restored.get(task.id).answer == "Final"
        assert restored.claim_next() is None
