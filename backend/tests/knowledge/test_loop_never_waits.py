"""The event loop never waits for a library write, a scan or the database (review High 1/High 2).

``view()`` used to take the write lock and read the database, and health, privacy
and the watcher's ``tick()`` called it (or read settings) right on the event loop:
during a rescan of a large library the whole backend froze (live WebSocket,
every request). The startup scan ran before the app answered ``/health``.
"""
from __future__ import annotations

import asyncio
import threading
import time
from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest

from skaz.app import create_app
from skaz.config import AppConfig
from skaz.knowledge import service as service_module
from skaz.knowledge.index import scanner
from skaz.knowledge.service import KnowledgeService
from skaz.secrets import MemorySecretStore
from tests.conftest import TOKEN


@pytest.fixture
def connected(kb_config: AppConfig) -> None:
    """A library connected by an earlier run of the app."""
    kb = KnowledgeService(kb_config.data_dir, documents_dir=kb_config.documents_dir,
                          documents_sandbox=kb_config.documents_sandbox)
    assert kb.connect(None).state == "ready"
    kb.close()


@pytest.fixture
def app(kb_config: AppConfig, connected: None) -> Iterator[Any]:
    application = create_app(kb_config, secret_store=MemorySecretStore(),
                             http_client=httpx.AsyncClient(transport=httpx.MockTransport(
                                 lambda request: httpx.Response(599))))
    yield application
    application.state.runtime.close()


@pytest.fixture
async def api(app: Any) -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8765",
                                 headers={"Authorization": f"Bearer {TOKEN}"}) as client:
        yield client


class Holder:
    """Holds a lock in another thread, as a long library write or scan does."""

    def __init__(self, lock: Any, seconds: float) -> None:
        self.taken = threading.Event()
        self._thread = threading.Thread(target=self._hold, args=(lock, seconds), daemon=True)

    def _hold(self, lock: Any, seconds: float) -> None:
        with lock:
            self.taken.set()
            time.sleep(seconds)

    def __enter__(self) -> Holder:
        self._thread.start()
        assert self.taken.wait(2)
        return self

    def __exit__(self, *_exc: object) -> None:
        self._thread.join()


async def _timed(call: Any) -> tuple[float, Any]:
    started = time.monotonic()
    result = await call
    return time.monotonic() - started, result


async def test_health_answers_while_a_writer_holds_the_library(app: Any, api: httpx.AsyncClient) -> None:
    runtime = app.state.runtime
    runtime.kb.open_connected()
    with Holder(runtime.kb.writing(), 3.0):
        elapsed, response = await _timed(api.get("/kb/settings/health"))
    assert response.status_code == 200, response.text
    assert elapsed < 1.0, f"health waited {elapsed:.2f} s for the writer"


async def test_privacy_and_library_answer_while_a_writer_holds_the_library(app: Any,
                                                                           api: httpx.AsyncClient) -> None:
    runtime = app.state.runtime
    runtime.kb.open_connected()
    with Holder(runtime.kb.writing(), 3.0):
        privacy_s, privacy = await _timed(api.get("/kb/settings/privacy"))
        library_s, library = await _timed(api.get("/kb/library"))
    assert privacy.status_code == 200 and library.status_code == 200
    assert privacy_s < 1.0 and library_s < 1.0, (privacy_s, library_s)


async def test_the_watcher_tick_never_reads_the_database_on_the_loop(app: Any) -> None:
    runtime = app.state.runtime
    gaps: list[float] = []

    async def heartbeat() -> None:
        last = time.monotonic()
        for _ in range(30):
            await asyncio.sleep(0.05)
            now = time.monotonic()
            gaps.append(now - last)
            last = now

    with Holder(runtime.kb.db._lock, 1.2):  # the database is busy (a long index write)
        beat = asyncio.create_task(heartbeat())
        await asyncio.sleep(0.1)  # the heartbeat is running
        await runtime.kb_wiki.tick()
        await beat
    assert max(gaps) < 0.5, f"the loop stalled {max(gaps):.2f} s"


def test_view_says_indexing_during_a_scan_and_never_waits_for_it(service: KnowledgeService,
                                                                  monkeypatch: pytest.MonkeyPatch) -> None:
    service.connect(None)
    release = threading.Event()
    scanning = threading.Event()
    real_scan = scanner.scan_library

    def slow_scan(*args: Any, **kwargs: Any) -> Any:
        scanning.set()
        assert release.wait(5)
        return real_scan(*args, **kwargs)

    monkeypatch.setattr(service_module, "scan_library", slow_scan)
    thread = threading.Thread(target=service.rescan)
    thread.start()
    try:
        assert scanning.wait(2)
        started = time.monotonic()
        view = service.view()
        assert time.monotonic() - started < 0.5
        assert (view.state, view.indexing) == ("ready", True)
    finally:
        release.set()
        thread.join()
    assert service.view().indexing is False


async def test_startup_scan_runs_in_the_background_and_the_library_says_indexing(
        app: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    release = threading.Event()
    real_scan = scanner.scan_library

    def slow_scan(*args: Any, **kwargs: Any) -> Any:
        release.wait(10)
        return real_scan(*args, **kwargs)

    monkeypatch.setattr(service_module, "scan_library", slow_scan)
    started = time.monotonic()
    async with app.router.lifespan_context(app):
        assert time.monotonic() - started < 3.0  # a large library would take minutes
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8765",
                                     headers={"Authorization": f"Bearer {TOKEN}"}) as client:
            assert (await client.get("/health")).status_code == 200
            library = (await client.get("/kb/library")).json()
            assert (library["state"], library["indexing"]) == ("ready", True)
            sections = (await client.get("/kb/settings/health")).json()["sections"]
            storage = next(section for section in sections if section["id"] == "storage")
            assert [problem["id"] for problem in storage["problems"]] == ["library-indexing"]
            release.set()
            await asyncio.wait_for(app.state.kb_startup_scan, 5)
            library = (await client.get("/kb/library")).json()
            assert (library["state"], library["indexing"]) == ("ready", False)


def test_a_library_folder_gone_at_startup_is_unavailable_not_indexing(kb_config: AppConfig, connected: None,
                                                                      documents: Path) -> None:
    (documents / "SKAZ").rename(documents / "Moved")
    kb = KnowledgeService(kb_config.data_dir, documents_dir=kb_config.documents_dir,
                          documents_sandbox=kb_config.documents_sandbox)
    try:
        assert kb.open_connected() is True
        kb.rescan()
        view = kb.view()
        assert (view.state, view.indexing) == ("unavailable", False)
    finally:
        kb.close()
