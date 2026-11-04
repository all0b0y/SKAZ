"""Off-loop disk work (``native_io``): a call is handed to its worker thread at once.

FIX-2: ``RuntimeWarning: coroutine 'to_thread' was never awaited`` came from ``disk_call``. It wrapped
``asyncio.to_thread(...)`` in a task that starts on the loop's next turn; when the loop was torn down
first (pytest-asyncio's runner closing a test's loop, where an ingest job's done-callback had just
restarted the queue: ``ingest/service.py`` ``_start_queued`` → ``disk_call(self.jobs.claim_next)``),
that task never ran — the call was silently dropped and its coroutine was never awaited. Now the
call is submitted to the executor when ``disk_call`` is called: it runs, or fails loudly when the
executor is already shut down; no un-awaited coroutine is left either way.
"""
from __future__ import annotations

import asyncio
import contextvars
import gc
import threading
import warnings
from collections.abc import Coroutine
from typing import Any

import pytest

from skaz.gateways import asr as asr_gateway
from skaz.native_io import disk_call


def _one_turn_then_close(start: Coroutine[Any, Any, None]) -> list[str]:
    """Runs ``start`` for exactly one loop turn, closes the loop and collects; returns the warnings."""
    loop = asyncio.new_event_loop()
    caught: list[str] = []
    with warnings.catch_warnings(record=True) as seen:
        warnings.simplefilter("always")
        loop.set_exception_handler(lambda *_: None)  # "Task was destroyed but it is pending" is expected
        task = loop.create_task(start)
        loop.call_soon(loop.stop)
        loop.run_forever()
        loop.close()
        del loop, task
        gc.collect()
        caught = [str(w.message) for w in seen if issubclass(w.category, RuntimeWarning)]
    return caught


def test_a_disk_call_whose_loop_closes_at_once_still_runs_and_leaves_no_unawaited_coroutine() -> None:
    ran = threading.Event()

    async def caller() -> None:
        await disk_call(ran.set)

    assert _one_turn_then_close(caller()) == []
    assert ran.wait(5), "the call was handed to its thread when disk_call was called"


def test_an_asr_worker_whose_loop_closes_at_once_still_runs_and_leaves_no_unawaited_coroutine() -> None:
    ran = threading.Event()

    async def caller() -> None:
        await asr_gateway._to_thread_until_finished(ran.set)

    assert _one_turn_then_close(caller()) == []
    assert ran.wait(5)


async def test_disk_call_keeps_the_callers_context_and_waits_for_the_write_through_a_cancel() -> None:
    """The same contract as ``asyncio.to_thread``: context variables reach the thread; a cancel waits
    for the write to settle, then is raised."""
    marker: contextvars.ContextVar[str] = contextvars.ContextVar("marker")
    marker.set("caller")
    entered = threading.Event()
    release = threading.Event()
    seen: list[str] = []

    def write() -> str:
        seen.append(marker.get())
        entered.set()
        release.wait(5)
        return "written"

    assert await disk_call(lambda: marker.get()) == "caller"
    task = asyncio.create_task(disk_call(write))
    await asyncio.to_thread(entered.wait, 5)
    task.cancel()
    await asyncio.sleep(0.05)
    assert not task.done()  # the write is still running: the caller waits for it
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert seen == ["caller"]
