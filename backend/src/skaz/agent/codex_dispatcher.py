"""One process/turn at a time; disk work and process teardown precede slot release."""
from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from contextlib import AbstractAsyncContextManager, suppress

from ..gateways.codex_session import CodexSession, TurnResult
from ..native_io import disk_call, drain_on_cancel
from .codex_note_completion import ask_note
from .snapshot_queue import SnapshotQueue, SnapshotTask

Runner = Callable[[SnapshotTask], AbstractAsyncContextManager[CodexSession]]
#: Looks at a finished answer. ``None`` accepts it; a string is the correction to send
#: back to the same thread for exactly one more attempt.
Check = Callable[[SnapshotTask, str], Awaitable[str | None]]


class CodexDispatcher:
    def __init__(
        self, queue: SnapshotQueue, runner: Runner, check: Check | None = None,
        *, multipart: Callable[[SnapshotTask], bool] | None = None,
        on_interrupted: Callable[[], None] | None = None,
    ) -> None:
        self.queue = queue
        self._runner = runner
        self._check = check
        self._multipart = multipart
        #: Called when a run ends in an error (not a user stop), e.g. an expired sign-in.
        self._on_interrupted = on_interrupted
        self._pump: asyncio.Task[None] | None = None
        self._execution: asyncio.Task[None] | None = None
        self._active: str | None = None
        self._session: CodexSession | None = None
        self._closing = False
        self._wake_requested = False
        self._controls = asyncio.Lock()

    def wake(self) -> None:
        if self._closing:
            raise ValueError("Dispatcher is closing")
        self._wake_requested = True
        if self._pump is None or self._pump.done():
            self._pump = asyncio.create_task(self._run())

    async def idle(self) -> None:
        if self._pump is not None:
            await asyncio.shield(self._pump)

    async def _run(self) -> None:
        while not self._closing:
            self._wake_requested = False
            task = await disk_call(self.queue.claim_next)
            if task is None:
                pending = await disk_call(self.queue.list)
                # Snapshot publication can occur between these two disk calls;
                # wake() can also arrive while either empty result is in flight.
                if self._wake_requested or any(t.status in {"preparing", "queued"} for t in pending):
                    await asyncio.sleep(0.02)
                    continue
                return
            if self._closing:
                await disk_call(self.queue.pause, task.id)
                return
            if (await disk_call(self.queue.get, task.id)).status != "running":
                if (await disk_call(self.queue.get, task.id)).status == "stopping":
                    await disk_call(self.queue.acknowledge_cancel, task.id)
                continue
            self._active = task.id
            self._execution = asyncio.create_task(self._execute(task))
            try:
                await self._execution
            finally:
                self._active = None
                self._execution = None

    async def _execute(self, task: SnapshotTask) -> None:
        completed = False
        rejected = False
        try:
            if task.answer:
                # An interrupted run is never continued: a resumed turn starts its
                # answer over, and gluing it onto the old partial text produced a
                # truncated copy followed by a full second one.
                await disk_call(self.queue.checkpoint, task.id, "")
            async with self._runner(task) as session:
                self._session = session

                async def checkpoint(text: str) -> None:
                    # Cumulative replacement from the session, never appended.
                    await disk_call(self.queue.checkpoint, task.id, text)

                multipart = self._multipart is not None and await disk_call(self._multipart, task)

                async def ask(question: str) -> TurnResult:
                    if multipart:
                        return await ask_note(session, question, on_answer=checkpoint)
                    return await session.ask(question, on_answer=checkpoint)

                result = await ask(task.question)
                completed = result.status == "completed"
                if completed and self._check is not None:
                    problem = await self._check(task, (await disk_call(self.queue.get, task.id)).answer)
                    if problem is not None:
                        # Exactly one correction, in the same thread: the model has
                        # already read the sources and only has to rewrite.
                        result = await ask(problem)
                        completed = result.status == "completed"
                        if completed:
                            answer = (await disk_call(self.queue.get, task.id)).answer
                            rejected = await self._check(task, answer) is not None
                # Only classified callback text is persisted. Never the raw TurnResult tail.
        except (Exception, asyncio.CancelledError):
            # Sanitized, no retry; the runner context must already have reaped its process.
            completed = False
        finally:
            self._session = None
            current = await disk_call(self.queue.get, task.id)
            if current.status == "stopping":
                await disk_call(self.queue.acknowledge_cancel, task.id)
            elif current.status == "running":
                if rejected:
                    await disk_call(self.queue.finish, task.id, "failed", "", error="answer_rejected")
                elif completed:
                    await disk_call(self.queue.finish, task.id, "completed", current.answer)
                else:
                    await disk_call(self.queue.pause, task.id)
                    if self._on_interrupted is not None and not self._closing:
                        self._on_interrupted()

    async def stop(self, task_id: str) -> None:
        async with self._controls:
            await disk_call(self.queue.cancel, task_id)
            if self._active != task_id or self._execution is None:
                return
            execution = self._execution
            if self._session is not None:
                with suppress(Exception):
                    async with asyncio.timeout(2):
                        await self._session.interrupt()
            try:
                async with asyncio.timeout(2):
                    await asyncio.shield(execution)
            except TimeoutError:
                execution.cancel()
                await drain_on_cancel(self._join(execution))

    async def steer(self, task_id: str, text: str) -> None:
        if self._active != task_id or self._session is None:
            raise ValueError("Task is not accepting steering yet")
        await self._session.steer(text)

    @staticmethod
    async def _join(task: asyncio.Task[None]) -> None:
        await asyncio.gather(task, return_exceptions=True)

    async def close(self) -> None:
        async with self._controls:
            if self._closing:
                return
            self._closing = True
            if self._execution is not None:
                self._execution.cancel()
            if self._pump is not None:
                await drain_on_cancel(self._join(self._pump))
            await disk_call(self.queue.close)
