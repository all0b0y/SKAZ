"""The app log carries ids, never titles, names or text (the renderer reads it; it goes into bug reports).

Each test drives a real log site with a title that must not leak and checks
the whole captured log text, tracebacks included.
"""
from __future__ import annotations

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
