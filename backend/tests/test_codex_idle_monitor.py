"""An idle Codex runtime must not keep reading the application database.

The monitor used to re-read every finished task's metadata ten times a second
forever, which kept an idle backend at several percent CPU. Real temporary
SQLite; no model or network calls.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from tests.test_codex_runtime_safety import prepared, service_at


@pytest.mark.asyncio
async def test_idle_monitor_stops_reading_finalized_tasks(tmp_path: Path) -> None:
    db, service, sid, cid = service_at(tmp_path)
    try:
        task_id = await prepared(service, sid, cid)
        service.queue.finish(task_id, "completed", "Итог [P1].")
        service.start()
        for _ in range(100):
            if service._meta(task_id)["finalized"]:
                break
            await asyncio.sleep(0.02)
        assert service._meta(task_id)["finalized"]

        statements: list[str] = []
        db._connection.set_trace_callback(statements.append)
        await asyncio.sleep(1.0)
        db._connection.set_trace_callback(None)
        assert statements == []
    finally:
        await service.close()
        db.close()


@pytest.mark.asyncio
async def test_monitor_still_finalizes_work_submitted_after_idle(tmp_path: Path) -> None:
    db, service, sid, cid = service_at(tmp_path)
    try:
        service.start()
        await asyncio.sleep(0.3)  # the monitor has nothing to do and settles
        task_id = await prepared(service, sid, cid)
        service.queue.finish(task_id, "completed", "Итог [P1].")
        service.wake_monitor()
        for _ in range(100):
            if service._meta(task_id)["finalized"]:
                break
            await asyncio.sleep(0.02)
        assert service._meta(task_id)["finalized"]
    finally:
        await service.close()
        db.close()
