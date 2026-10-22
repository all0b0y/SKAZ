"""L8: locks by id exclude each other and are forgotten once nobody holds or waits for them."""
from __future__ import annotations

import asyncio
import threading

from skaz.knowledge.keyed_locks import KeyedLocks, KeyedThreadLocks


async def test_asyncio_locks_exclude_and_are_dropped_after_use() -> None:
    locks = KeyedLocks()
    inside = 0
    peak = 0

    async def work() -> None:
        nonlocal inside, peak
        async with locks.hold("message-1"):
            inside += 1
            peak = max(peak, inside)
            await asyncio.sleep(0.01)
            inside -= 1

    await asyncio.gather(*(work() for _ in range(5)))
    assert peak == 1
    assert len(locks) == 0
    for n in range(100):
        async with locks.hold(f"message-{n}"):
            pass
    assert len(locks) == 0


def test_thread_locks_exclude_time_out_and_are_dropped() -> None:
    locks = KeyedThreadLocks()
    with locks.hold("mat-1") as taken:
        assert taken
        result: list[bool] = []

        def try_it() -> None:
            with locks.hold("mat-1", timeout=0.05) as other:
                result.append(other)

        worker = threading.Thread(target=try_it)
        worker.start()
        worker.join()
        assert result == [False]
    assert len(locks) == 0
