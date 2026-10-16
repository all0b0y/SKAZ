"""Runtime-owned local tail processing, independent of the capture WebSocket."""
from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING

from .native_io import disk_call, drain_on_cancel

if TYPE_CHECKING:
    from .native_stream import NativeStream
    from .runtime import Runtime

logger = logging.getLogger(__name__)
# Separate from the interactive cloud Stop grace. This is a safety ceiling,
# not a promise that all local models run at real-time speed.
LOCAL_FINISH_TIMEOUT_S = 120.0


def start_finalization(runtime: Runtime, session_id: str, stream: NativeStream) -> None:
    """Atomically transfer ownership; deletion/shutdown still cancel and await it."""
    if runtime.native_shutdown or session_id in runtime.native_closing:
        raise asyncio.CancelledError
    previous = runtime.native_tasks[session_id]
    done = asyncio.Event()
    started = False
    stream.processing = True

    async def cleanup() -> None:
        try:
            if not stream.finalized:
                await stream.abort()
            await disk_call(runtime.session_files.project, session_id)
        finally:
            stream.processing = False
            runtime.native_tasks.pop(session_id, None)
            runtime.native_streams.pop(session_id, None)
            done.set()

    async def run() -> None:
        nonlocal started
        started = True
        try:
            await stream.finish(timeout_s=LOCAL_FINISH_TIMEOUT_S, wait_for_open=True)
        except asyncio.CancelledError:
            pass
        except Exception:
            # Never print provider output, transcript, paths or credentials.
            logger.error("Background transcription failed; preserving confirmed text.")
        finally:
            await drain_on_cancel(cleanup())

    task = asyncio.create_task(run(), name="local-transcription-tail")
    runtime.native_tasks[session_id] = (task, done)
    previous[1].set()

    def completed(finished: asyncio.Task[None]) -> None:
        if not started:
            # Cancellation before the task's first instruction still owns cleanup.
            replacement = asyncio.create_task(cleanup())
            runtime.native_tasks[session_id] = (replacement, done)
            replacement.add_done_callback(consume_error)
        else:
            consume_error(finished)

    def consume_error(finished: asyncio.Task[None]) -> None:
        if not finished.cancelled() and finished.exception() is not None:
            logger.error("Background transcription cleanup failed.")

    task.add_done_callback(completed)
