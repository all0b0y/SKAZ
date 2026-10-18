"""The app log carries ids, never titles, names or text (the renderer reads it; it goes into bug reports).

Each test drives a real log site with a title that must not leak and checks
the whole captured log text, tracebacks included.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

import httpx
import pytest

from skaz.knowledge.library.library import INBOX_ID
from skaz.knowledge.logsafe import error_note
from skaz.knowledge.markdown.source import FragmentInput
from skaz.knowledge.service import KnowledgeService
from skaz.knowledge.sources import material_info
from skaz.knowledge.sources.service import SourceEvent, SourceService
from skaz.knowledge.speech.service import SpeechService
from skaz.knowledge.wiki import service as wiki_service

from .wiki_support import two_sources

SECRET = "Diagnosis of Anna Petrova"


def material_dir(kb: KnowledgeService, title: str = SECRET) -> tuple[str, Any]:
    files = kb.create_material(INBOX_ID, title, "text", [FragmentInput(text="Plain text.")])
    return files.manifest.id, files.directory


def test_material_info_warnings_name_the_material_by_id(ready: KnowledgeService,
                                                        caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG)
    material_id, directory = material_dir(ready)
    service = directory / ".skaz"
    (service / "excluded.json").write_text("{broken", encoding="utf-8")
    assert material_info.excluded_count(directory) == 0
    (service / "translation.md").write_bytes(b"\xff\xfe broken utf-8 \xff")
    assert material_info.read_translation(directory) is None
    (service / "translation.md").write_text("x" * (material_info.MAX_TRANSLATION_BYTES + 1), encoding="utf-8")
    assert material_info.read_translation(directory) is None
    assert len(caplog.records) == 3
    assert SECRET not in caplog.text
    assert all(material_id in record.getMessage() for record in caplog.records)


def test_a_failing_source_listener_is_logged_without_its_message(ready: KnowledgeService,
                                                                 caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG)
    sources = SourceService(ready)

    def listener(_event: SourceEvent) -> None:
        raise ValueError(f"“{SECRET}” could not be read")

    sources.subscribe(listener)
    result = sources.add_text("A plain note about entropy and disorder.", INBOX_ID, SECRET)
    assert result.status == "ready"
    assert caplog.records and SECRET not in caplog.text
    assert "ValueError" in caplog.text


async def test_speech_work_errors_are_logged_by_type_not_path(ready: KnowledgeService,
                                                              caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG)

    class Legacy:
        def add_listeners(self, **_listeners: Any) -> None:
            return None

        def read(self) -> Any:
            raise AssertionError("not read here")

    speech = SpeechService(ready, Legacy())  # type: ignore[arg-type]

    async def work() -> None:
        raise FileNotFoundError(2, "No such file", f"/Documents/SKAZ/Materials/Inbox/{SECRET}/source.md")

    await speech._guarded("mat-123", work)
    assert "mat-123" in caplog.text and "FileNotFoundError" in caplog.text
    assert SECRET not in caplog.text


async def test_wiki_logs_after_ingest_and_moves_carry_no_titles(
    kb_app: Any, kb_client: httpx.AsyncClient, caplog: pytest.LogCaptureFixture,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    caplog.set_level(logging.DEBUG)
    assert (await kb_client.post("/kb/library", json={})).json()["state"] == "ready"
    case = await two_sources(kb_app.state.runtime.kb, conflict=True, runtime=kb_app.state.runtime)
    titles = [page.title for page in case.kb.pages()] + [item.title for item in case.kb.materials()]
    monkeypatch.setattr(wiki_service, "move_material",
                        lambda *_args, **_kwargs: ["“Энтропия (entropy)” could not be updated."])
    case.service.move_material(case.lecture, title=None, folder_id=None)
    assert any("move" in record.getMessage() for record in caplog.records)
    assert any("discrepancy" in record.getMessage() for record in caplog.records)
    leaked = [title for title in titles if title in caplog.text]
    assert leaked == []


def test_error_note_has_types_and_places_but_no_messages() -> None:
    try:
        try:
            raise OSError(f"/Materials/{SECRET}/source.md")
        except OSError as inner:
            raise RuntimeError(f"Finishing “{SECRET}” failed") from inner
    except RuntimeError as error:
        note = error_note(error)
    assert note.startswith("RuntimeError at test_log_privacy.py:") and "caused by OSError" in note
    assert SECRET not in note


class _Exploding:
    """An agent whose turn fails unexpectedly with a title in the message (as a path or a quote would)."""

    id = "codex"

    def run(self, _turn: Any) -> Any:
        raise RuntimeError(f"Reading “{SECRET}” failed at /Materials/Inbox/{SECRET}/source.md")

    async def interrupt(self, _run_id: str) -> None:
        return None


async def test_unexpected_ingest_and_wiki_job_errors_log_ids_and_types_not_titles(
    ready: KnowledgeService, caplog: pytest.LogCaptureFixture,
) -> None:
    """G6 (R1 Q-2): no traceback with a title reaches the log from ingest, its listeners or wiki jobs."""
    from skaz.knowledge.ingest.jobs import JobRepository
    from skaz.knowledge.ingest.service import IngestService
    from skaz.knowledge.wiki.jobs import WikiJobs
    from tests.knowledge.ingest_support import PatternDetector

    caplog.set_level(logging.DEBUG)
    material_id, _directory = material_dir(ready)
    ingest = IngestService(ready, engines=lambda _engine_id: _Exploding(),  # type: ignore[arg-type,return-value]
                           detector=PatternDetector())
    job = await ingest.request_ingest(material_id)
    while ingest.active_jobs():
        await asyncio.sleep(0.01)
    record = ingest.jobs.get(job.id)
    assert record is not None and record.state == "failed"
    assert job.id in caplog.text and "RuntimeError" in caplog.text

    def listener(_material_id: str, _record: Any) -> None:
        raise ValueError(f"“{SECRET}” could not be announced")

    ingest.finished_listeners.append(listener)
    ingest._tell_finished(ingest.jobs.get(job.id), material_id)
    assert "ValueError" in caplog.text

    wiki_jobs = WikiJobs(JobRepository(ready.db))

    async def work(_context: Any) -> None:
        raise KeyError(f"page “{SECRET}”")

    wiki_job = await wiki_jobs.start("refresh", material_id, "reading", work)
    await wiki_jobs.wait(wiki_job.id)
    assert wiki_job.id in caplog.text and "KeyError" in caplog.text
    assert SECRET not in caplog.text


async def test_automatic_ingest_that_does_not_start_logs_no_title(
    ready: KnowledgeService, caplog: pytest.LogCaptureFixture,
) -> None:
    from skaz.knowledge.wiring import AutoIngest

    caplog.set_level(logging.DEBUG)

    class Refusing:
        async def request_ingest(self, _material_id: str) -> None:
            raise RuntimeError(f"“{SECRET}” is already being added")

    await AutoIngest(ready, Refusing())._start("mat-77")  # type: ignore[arg-type]
    assert "mat-77" in caplog.text and "RuntimeError" in caplog.text
    assert SECRET not in caplog.text


async def test_a_service_that_fails_to_close_logs_no_title(caplog: pytest.LogCaptureFixture) -> None:
    from types import SimpleNamespace

    from skaz.knowledge.shutdown import close_knowledge

    caplog.set_level(logging.DEBUG)

    async def ok() -> None:
        return None

    async def failing() -> None:
        raise OSError(f"/Documents/SKAZ/Wiki/Concepts/{SECRET}.md")

    runtime = SimpleNamespace(
        kb_wiki=SimpleNamespace(close=failing), kb_chats=SimpleNamespace(close=ok),
        kb_ingest=SimpleNamespace(close=ok), kb_codex=SimpleNamespace(close=ok),
        kb_decisions=SimpleNamespace(aclose=ok), kb_agents=SimpleNamespace(aclose=ok),
    )
    await close_knowledge(runtime, deadline_s=2)
    assert "wiki" in caplog.text and "OSError" in caplog.text
    assert SECRET not in caplog.text
