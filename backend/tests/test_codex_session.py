"""Session lifecycle over an authored child process, not a model evaluation."""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from typing import Any

import pytest

from skaz import repository as repo
from skaz.agent.snapshot_queue import SnapshotQueue
from skaz.db import Database
from skaz.gateways.codex_rpc import CodexRpc, CodexRpcError
from skaz.gateways.codex_session import CodexSession, ToolDefinition

FIXTURE = Path(__file__).parent / "fixtures" / "codex_session_server.py"


async def test_turn_binds_tools_before_immediate_call_and_returns_only_answer(tmp_path: Path) -> None:
    calls = []

    async def read(arguments: dict[str, Any]) -> str:
        calls.append(arguments)
        return "Authored evidence"

    definition = ToolDefinition("skaz_read_range", "Read fixture", {"type": "object"}, read)
    async with CodexRpc((sys.executable, str(FIXTURE)), cwd=tmp_path, env={}) as rpc:
        session = CodexSession(rpc, cwd=tmp_path, model="fixture-model", tools=[definition])
        result = await session.ask("Explain the fixture")
        assert result.status == "completed"
        assert result.text == "Fixture answer"
        assert result.thread_id == "thread-fixture"
        assert result.turn_id == "turn-1"
        assert calls == [{}]
        second = await session.ask("Explain again")
        assert second.thread_id == result.thread_id
        assert second.turn_id == "turn-2"
        assert calls == [{}, {}]


async def test_failed_turn_preserves_partial_without_exposing_error(tmp_path: Path) -> None:
    async with CodexRpc((sys.executable, str(FIXTURE)), cwd=tmp_path, env={}) as rpc:
        session = CodexSession(rpc, cwd=tmp_path, model="fixture-model", tools=[])
        result = await session.ask("case:failed")
        assert result.status == "failed"
        assert result.text == "Partial"
        assert "PRIVATE" not in repr(result)


async def test_turn_deadline_closes_process_without_retry(tmp_path: Path) -> None:
    async with CodexRpc((sys.executable, str(FIXTURE)), cwd=tmp_path, env={}) as rpc:
        session = CodexSession(rpc, cwd=tmp_path, model="fixture-model", tools=[], turn_timeout=0.1)
        with pytest.raises(CodexRpcError, match="timed out; not retried"):
            await session.ask("case:timeout")
        assert rpc.closed


async def test_interrupt_revokes_and_cancels_handler_and_rejects_parallel_ask(tmp_path: Path) -> None:
    started, cancelled = asyncio.Event(), asyncio.Event()

    async def blocked(arguments: dict[str, Any]) -> str:
        started.set()
        try:
            await asyncio.Event().wait()
            return "unreachable"
        finally:
            cancelled.set()

    definition = ToolDefinition("skaz_read_range", "Fixture", {"type": "object"}, blocked)
    async with CodexRpc((sys.executable, str(FIXTURE)), cwd=tmp_path, env={}) as rpc:
        session = CodexSession(rpc, cwd=tmp_path, model="fixture-model", tools=[definition])
        active = asyncio.create_task(session.ask("Interrupt this"))
        try:
            await asyncio.wait_for(started.wait(), 1)
            with pytest.raises(CodexRpcError, match="already active"):
                await session.ask("Do not start another turn")
            await session.interrupt()
            result = await asyncio.wait_for(active, 1)
            assert result.status == "interrupted"
            await asyncio.wait_for(cancelled.wait(), 0.2)
            assert not rpc.closed
        finally:
            await rpc.close()
            await asyncio.gather(active, return_exceptions=True)


async def test_answer_checkpoints_arrive_before_completion_without_private_events(tmp_path: Path) -> None:
    updates: list[str] = []
    async with CodexRpc((sys.executable, str(FIXTURE)), cwd=tmp_path, env={}) as rpc:
        session = CodexSession(rpc, cwd=tmp_path, model="fixture-model", tools=[])

        async def checkpoint(text: str) -> None:
            updates.append(text)
            if text == "Final":
                # A callback can await RPC: it must not run on the stdio reader.
                await session.interrupt()

        result = await session.ask("case:stream", on_answer=checkpoint)
        assert updates == ["First", "First draft", "Final"]
        assert result.status == "interrupted"
        assert result.text == "Final"


@pytest.mark.parametrize("failure", ["disconnect", "timeout", "cancel"])
async def test_checkpoint_survives_failed_execution_and_queue_reopen(tmp_path: Path, failure: str) -> None:
    db = Database(tmp_path / "source.sqlite")
    root = tmp_path / "queue"
    try:
        sid = repo.create_session(db, "Authored fixture").id
        with SnapshotQueue(root) as queue:
            task = await asyncio.to_thread(
                queue.enqueue, db, chat_id="chat", session_ids=(sid,),
                question="case:stream", model="fixture-model",
            )
            await asyncio.to_thread(queue.wait, task.id)
            assert await asyncio.to_thread(queue.claim_next) is not None
            async with CodexRpc((sys.executable, str(FIXTURE)), cwd=tmp_path, env={}) as rpc:
                session = CodexSession(
                    rpc, cwd=tmp_path, model=task.model, tools=[], turn_timeout=1,
                )

                async def checkpoint(text: str) -> None:
                    await asyncio.to_thread(queue.checkpoint, task.id, text)
                    if failure == "disconnect":
                        await rpc.request("fixture/disconnect", {})
                    elif failure == "cancel":
                        raise asyncio.CancelledError
                    # Block the consumer after persistence; the deadline must still apply.
                    await asyncio.Event().wait()

                expected = asyncio.CancelledError if failure == "cancel" else CodexRpcError
                with pytest.raises(expected):
                    await session.ask(task.question, on_answer=checkpoint)
                assert rpc.closed
                assert queue.get(task.id).answer == "First"
        with SnapshotQueue(root) as restored:
            assert restored.get(task.id).answer == "First"
            assert restored.get(task.id).status == "paused"
            assert restored.claim_next() is None
    finally:
        db.close()


async def test_checkpoint_failure_aborts_without_exposing_storage_error(tmp_path: Path) -> None:
    updates = []

    async def checkpoint(text: str) -> None:
        updates.append(text)
        raise OSError("PRIVATE storage error")

    async with CodexRpc((sys.executable, str(FIXTURE)), cwd=tmp_path, env={}) as rpc:
        session = CodexSession(rpc, cwd=tmp_path, model="fixture-model", tools=[])
        with pytest.raises(CodexRpcError, match="session failed; not retried") as error:
            await session.ask("case:stream", on_answer=checkpoint)
        assert "PRIVATE" not in str(error.value)
        assert rpc.closed
        assert updates == ["First"]


async def test_oversized_answer_is_not_sent_to_checkpoint(tmp_path: Path) -> None:
    updates: list[str] = []

    async def checkpoint(text: str) -> None:
        updates.append(text)

    async with CodexRpc((sys.executable, str(FIXTURE)), cwd=tmp_path, env={}) as rpc:
        session = CodexSession(rpc, cwd=tmp_path, model="fixture-model", tools=[], max_answer_bytes=4)
        with pytest.raises(CodexRpcError):
            await session.ask("case:stream", on_answer=checkpoint)
        assert updates == []
        assert rpc.closed


async def test_answer_limit_is_enforced(tmp_path: Path) -> None:
    async with CodexRpc((sys.executable, str(FIXTURE)), cwd=tmp_path, env={}) as rpc:
        session = CodexSession(rpc, cwd=tmp_path, model="fixture-model", tools=[], max_answer_bytes=2)
        with pytest.raises(CodexRpcError):
            await session.ask("case:failed")
        assert rpc.closed

