"""Off-loop disk work whose owner cannot leave before the write has settled."""
from __future__ import annotations

import asyncio
from collections.abc import Callable, Coroutine
from typing import Any, ParamSpec, TypeVar

P = ParamSpec("P")
T = TypeVar("T")


async def drain_on_cancel(operation: Coroutine[Any, Any, T]) -> T:
    """Cancellation stops intake, not an already running filesystem transaction.

    Repeated cancellation also waits. Deletion/DB close must never race a
    detached to_thread write. A physically stuck disk cannot be safely timed out.
    """
    task = asyncio.create_task(operation)
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
    return await drain_on_cancel(asyncio.to_thread(function, *args, **kwargs))
