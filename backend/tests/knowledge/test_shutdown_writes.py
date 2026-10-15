"""Quitting never tears a library write and never hangs on one (review M4).

The knowledge shutdown cancelled whatever outlived its 2.5 s deadline: the ingest
close (and through ``gather`` the job saving its pages), then ``runtime.close()``
closed the database under a write still running on its worker thread. The speech
close waited for its projections without a bound.
"""
from __future__ import annotations

import asyncio
import threading
import time
from types import SimpleNamespace
from typing import Any

import pytest

from skaz.knowledge.errors import LibraryUnavailable
from skaz.knowledge.ingest.service import IngestService, _Active
from skaz.knowledge.library import library as library_module
from skaz.knowledge.library.library import INBOX_ID
from skaz.knowledge.markdown.source import FragmentInput
from skaz.knowledge.service import KnowledgeService


def test_close_lets_the_write_in_progress_finish_and_refuses_the_next(ready: KnowledgeService) -> None:
    holding = threading.Event()
    outcome: list[str] = []

    def write() -> None:
        with ready.writing():
            holding.set()
            time.sleep(0.4)
            try:
                ready.settings.set("written_during_close", True)  # the end of a write already running
                outcome.append("saved")
            except Exception as error:  # the database closed under it
                outcome.append(type(error).__name__)

    writer = threading.Thread(target=write)
    writer.start()
    assert holding.wait(2)
    ready.close()
    writer.join()
    assert outcome == ["saved"]
    with pytest.raises(LibraryUnavailable):  # a write that had not started never starts
        ready.create_folder("After the quit")


def test_close_never_waits_long_for_a_stuck_write(ready: KnowledgeService) -> None:
    holding = threading.Event()
    release = threading.Event()

    def stuck() -> None:
        with ready.writing():
            holding.set()
            release.wait(5)
            ready.settings.set("written_late", True)  # the database was left open for it

    writer = threading.Thread(target=stuck)
    writer.start()
    assert holding.wait(2)
    started = time.monotonic()
    ready.close(wait_s=0.3)
    assert time.monotonic() - started < 1.0
    release.set()
    writer.join()
    assert ready.settings.get("written_late") is True


def test_a_full_scan_stops_when_skaz_closes(ready: KnowledgeService, monkeypatch: pytest.MonkeyPatch) -> None:
    for index in range(6):
        ready.create_material(INBOX_ID, f"Lecture {index}", "text", [FragmentInput(text=f"Text {index}")])
    real_load = library_module.Library.load_material
    loading = threading.Event()

    def slow_load(self: Any, *args: Any, **kwargs: Any) -> Any:
        loading.set()
        time.sleep(0.4)
        return real_load(self, *args, **kwargs)

    monkeypatch.setattr(library_module.Library, "load_material", slow_load)
    scan = threading.Thread(target=ready.rescan)
    scan.start()
    assert loading.wait(2)
    started = time.monotonic()
    ready.close(wait_s=3.0)
    took = time.monotonic() - started
    scan.join()
    assert took < 1.0, f"close waited {took:.1f} s for a scan of 6 slow materials"


async def test_the_deadline_never_cancels_a_job_saving_its_pages(ready: KnowledgeService) -> None:
    ingest = IngestService(ready)
    events: list[str] = []

    async def saving_pages() -> None:
        events.append("writing")
        await asyncio.sleep(0.4)
        events.append("saved")

    task = asyncio.create_task(saving_pages())
    ingest._active["job-1"] = _Active("mat-1", task=task, run=SimpleNamespace(writing=True))  # type: ignore[arg-type]
    closing = asyncio.create_task(ingest.close())
    await asyncio.sleep(0.1)
    closing.cancel()  # close_knowledge's deadline
    await asyncio.gather(closing, return_exceptions=True)
    await asyncio.wait({task}, timeout=2)
    assert events == ["writing", "saved"] and not task.cancelled()


async def test_the_speech_close_is_bounded(kb_app: Any) -> None:
    speech = kb_app.state.runtime.kb_speech
    hanging = asyncio.create_task(asyncio.sleep(30))
    speech._tasks.add(hanging)
    try:
        started = time.monotonic()
        await asyncio.wait_for(speech.close(wait_s=0.3), 5)
        assert time.monotonic() - started < 1.0
    finally:
        hanging.cancel()
        await asyncio.gather(hanging, return_exceptions=True)


async def test_what_outlives_the_deadline_is_named_in_the_log(kb_app: Any,
                                                             caplog: pytest.LogCaptureFixture) -> None:
    from skaz.knowledge import shutdown

    runtime = kb_app.state.runtime

    async def hangs() -> None:
        await asyncio.sleep(30)

    runtime.kb_chats.close = hangs
    runtime.kb_chats.active_runs = lambda: {"run-7"}
    runtime.kb_ingest.active_jobs = lambda: {"job-3"}
    with caplog.at_level("WARNING", logger="skaz.knowledge.shutdown"):
        await shutdown.close_knowledge(runtime, deadline_s=0.3)
    assert "ingest jobs job-3" in caplog.text and "chat answers run-7" in caplog.text
