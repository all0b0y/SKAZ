"""Off-loop disk work whose owner cannot leave before the write has settled."""
from __future__ import annotations

import asyncio
import contextvars
import functools
from collections.abc import Awaitable, Callable
from typing import ParamSpec, TypeVar

P = ParamSpec("P")
T = TypeVar("T")


def in_thread(function: Callable[P, T], /, *args: P.args, **kwargs: P.kwargs) -> asyncio.Future[T]:
    """``asyncio.to_thread`` without its coroutine: the call is handed to the default executor now.

    ``to_thread``'s coroutine only reaches the executor when its task first runs; a loop torn down
    before that turn dropped the call silently and left ``coroutine 'to_thread' was never awaited``
    (FIX-2). Submitted here, the call runs — or fails loudly once the executor has been shut down.
    Context variables reach the thread, as with ``to_thread``.
    """
    loop = asyncio.get_running_loop()
    context = contextvars.copy_context()
    return loop.run_in_executor(None, functools.partial(context.run, function, *args, **kwargs))


async def drain_on_cancel(operation: Awaitable[T]) -> T:
    """Cancellation stops intake, not an already running filesystem transaction.

    Repeated cancellation also waits. Deletion/DB close must never race a
    detached to_thread write. A physically stuck disk cannot be safely timed out.
    """
    task = asyncio.ensure_future(operation)
    cancelled = False
    while not task.done():
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            cancelled = True
    result = task.result()
    if cancelled:
        raise asyncio.CancelledError
    return result


async def disk_call(function: Callable[P, T], *args: P.args, **kwargs: P.kwargs) -> T:
    return await drain_on_cancel(in_thread(function, *args, **kwargs))
