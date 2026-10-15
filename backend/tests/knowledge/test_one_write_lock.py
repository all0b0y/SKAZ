"""One write discipline for the library (review B2 #3).

Wiki page writes, the full library scan, the ``Wiki/`` watcher and the
corrections index rebuild all read files and then write index rows. Each of
them must hold the same lock, or a write that lands between another's read
and its write is undone in the index (the file keeps it, the index does not;
the watcher never notices because its snapshot already has the new mtime).

Every test below starts the competing write from inside the first party's
read-then-write window and gives it 0.3 s: without the shared lock it lands
inside the window (the lost write the test detects); with it, it waits.
"""
from __future__ import annotations

import threading
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest

from skaz.knowledge import service as service_module
from skaz.knowledge.corrections import store as store_module
from skaz.knowledge.corrections.model import CorrectionEntry, CorrectionsFile
from skaz.knowledge.ingest.service import IngestService
from skaz.knowledge.library.library import INBOX_ID
from skaz.knowledge.markdown.page import Block, PageDocument, PageMeta
from skaz.knowledge.markdown.source import FragmentInput
from skaz.knowledge.service import KnowledgeService
from skaz.knowledge.wiki import watch as watch_module
from skaz.knowledge.wiki.service import WikiService

PAGE_ID = "pg-entropy"
WINDOW_S = 0.3


@pytest.fixture
def wiki(ready: KnowledgeService) -> Iterator[WikiService]:
    ingest = IngestService(ready)
    service = WikiService(ready, ingest)
    service.connect()
    ready.create_page(PageDocument(
        meta=PageMeta(skaz_id=PAGE_ID, kind="concept", title="Entropy", language="en"),
        parts=[Block.create("c-e1", "explanation", "Entropy measures disorder.")],
    ))
    yield service


def _block_texts(kb: KnowledgeService, page_id: str = PAGE_ID) -> list[str]:
    return [block.text for block in kb.page_repo.blocks(page_id)]


class _Meanwhile:
    """Runs ``write`` in another thread from inside a read-then-write window, at most once."""

    def __init__(self, write: Callable[[], object]) -> None:
        self.write = write
        self.threads: list[threading.Thread] = []

    def once(self) -> None:
        if self.threads:
            return
        thread = threading.Thread(target=self.write, daemon=True)
        thread.start()
        self.threads.append(thread)
        thread.join(timeout=WINDOW_S)  # without the shared lock the write lands here, inside the window

    def finish(self) -> None:
        assert self.threads, "the competing write never started"
        self.threads[0].join(timeout=5)
        assert not self.threads[0].is_alive(), "the competing write never finished (deadlock?)"


def test_a_wiki_edit_made_during_a_rescan_survives_the_index_replace(
    ready: KnowledgeService, wiki: WikiService, monkeypatch: pytest.MonkeyPatch,
) -> None:
    meanwhile = _Meanwhile(lambda: wiki.add_note(PAGE_ID, "My note while the scan runs.",
                                                 after_block_id=None, section=None))
    real_scan = service_module.scan_library  # type: ignore[attr-defined]

    def scan_then_edit_meanwhile(*args: Any, **kwargs: Any) -> Any:
        result = real_scan(*args, **kwargs)  # the page is read without the note
        meanwhile.once()
        return result

    monkeypatch.setattr(service_module, "scan_library", scan_then_edit_meanwhile)
    assert wiki.rescan() >= 0  # POST /kb/library/rescan; retry/connect take the same path
    meanwhile.finish()
    assert "My note while the scan runs." in _block_texts(ready)


def test_a_page_created_during_a_rescan_stays_in_the_index(
    ready: KnowledgeService, monkeypatch: pytest.MonkeyPatch,
) -> None:
    analysis = PageDocument(
        meta=PageMeta(skaz_id="pg-analysis", kind="analysis", title="Saved answer", language="en"),
        parts=[Block.create("c-a1", "explanation", "An answer saved from a chat.")],
    )
    meanwhile = _Meanwhile(lambda: ready.create_page(analysis))
    real_scan = service_module.scan_library  # type: ignore[attr-defined]

    def scan_then_create_meanwhile(*args: Any, **kwargs: Any) -> Any:
        result = real_scan(*args, **kwargs)
        meanwhile.once()
        return result

    monkeypatch.setattr(service_module, "scan_library", scan_then_create_meanwhile)
    ready.retry()
    meanwhile.finish()
    assert ready.page_repo.get("pg-analysis") is not None


def test_the_watcher_never_indexes_a_page_older_than_a_skaz_write(
    ready: KnowledgeService, wiki: WikiService, monkeypatch: pytest.MonkeyPatch,
) -> None:
    watcher = wiki.watcher
    assert watcher.poll() == 0  # snapshot
    path = ready.library_root / ready.page_repo.get(PAGE_ID).rel_path  # type: ignore[union-attr]
    path.write_text(path.read_text(encoding="utf-8") + "\nA paragraph typed in Obsidian.\n", encoding="utf-8")
    meanwhile = _Meanwhile(lambda: wiki.add_note(PAGE_ID, "A note SKAZ saves meanwhile.",
                                                 after_block_id=None, section=None))
    real_read = watch_module.read_page  # type: ignore[attr-defined]

    def read_then_write_meanwhile(*args: Any, **kwargs: Any) -> Any:
        page = real_read(*args, **kwargs)  # the outside edit, without SKAZ's note
        meanwhile.once()
        return page

    monkeypatch.setattr(watch_module, "read_page", read_then_write_meanwhile)
    watcher.poll()
    meanwhile.finish()
    monkeypatch.setattr(watch_module, "read_page", real_read)
    watcher.poll()  # a later tick must not be needed, but must not hide the loss either
    texts = _block_texts(ready)
    assert "A note SKAZ saves meanwhile." in texts
    assert "A paragraph typed in Obsidian." in texts


def test_opening_a_page_never_indexes_a_copy_older_than_a_skaz_write(
    ready: KnowledgeService, wiki: WikiService, monkeypatch: pytest.MonkeyPatch,
) -> None:
    meanwhile = _Meanwhile(lambda: wiki.add_note(PAGE_ID, "Saved while the page opens.",
                                                 after_block_id=None, section=None))
    real_read = service_module.read_page  # type: ignore[attr-defined]

    def read_then_write_meanwhile(*args: Any, **kwargs: Any) -> Any:
        page = real_read(*args, **kwargs)
        meanwhile.once()
        return page

    monkeypatch.setattr(service_module, "read_page", read_then_write_meanwhile)
    ready.page(PAGE_ID)
    meanwhile.finish()
    assert "Saved while the page opens." in _block_texts(ready)


def test_a_correction_saved_during_a_rescan_stays_in_the_corrections_index(
    ready: KnowledgeService, wiki: WikiService, monkeypatch: pytest.MonkeyPatch,
) -> None:
    files = ready.create_material(INBOX_ID, "Talk", "audio", [FragmentInput(text="The entropy grows.")])
    material_id = files.manifest.id
    entry = CorrectionEntry(id="cor-1", seg=1, before="entropy", after="enthalpy", reason="misheard",
                            confidence=0.9, state="applied", auto=True, created_at="2026-10-15T10:00:00Z",
                            start=4)
    meanwhile = _Meanwhile(lambda: wiki.store.write(
        material_id, CorrectionsFile(material_id=material_id, corrections=[entry])))
    real_read_json = store_module.read_json  # type: ignore[attr-defined]

    def read_then_write_meanwhile(path: Path) -> Any:
        try:
            return real_read_json(path)  # the rebuild reads "no corrections yet"
        finally:
            meanwhile.once()

    monkeypatch.setattr(store_module, "read_json", read_then_write_meanwhile)
    ready.rescan()
    meanwhile.finish()
    assert wiki.store.counts(material_id) == {"applied": 1}
