"""The wiki watcher's background tick stays cheap on a large wiki (review Low: graph signature).

``tick()`` runs every 2 s while background connections are allowed and SKAZ is idle; it
hashed every indexed page each time to see whether the wiki changed.
"""
from __future__ import annotations

from typing import Any

import pytest

from skaz.knowledge.index import indexer
from skaz.knowledge.markdown.page import Block, PageDocument, PageMeta
from skaz.knowledge.service import KnowledgeService
from skaz.knowledge.wiki.graph import GraphIndex


def _page(kb: KnowledgeService, index: int) -> None:
    kb.create_page(PageDocument(meta=PageMeta(skaz_id=f"pg-{index}", kind="concept", title=f"Concept {index}",
                                              language="en"),
                                parts=[Block.create(f"c-{index}", "explanation", f"Statement {index}.")]))


def test_the_signature_hashes_the_pages_only_after_the_index_changed(ready: KnowledgeService) -> None:
    for index in range(3):
        _page(ready, index)
    graph = GraphIndex(ready.db)
    reads: list[str] = []
    with ready.db.read() as connection:
        connection.set_trace_callback(
            lambda sql: reads.append(sql) if "file_sha256 FROM pages" in sql else None)
    try:
        first = graph.signature()
        for _ in range(5):  # five idle ticks
            assert graph.signature() == first
        assert len(reads) == 1
        _page(ready, 3)
        changed = graph.signature()
        assert changed != first and len(reads) == 2
    finally:
        with ready.db.read() as connection:
            connection.set_trace_callback(None)


def test_opening_a_page_reindexes_it_only_after_its_file_changed(ready: KnowledgeService,
                                                                 monkeypatch: pytest.MonkeyPatch) -> None:
    """Review M6: every GET /kb/wiki/pages/{id} re-indexed the page (fsync + FTS) under the write lock."""
    _page(ready, 1)
    record = ready.page_repo.get("pg-1")
    assert record is not None
    written: list[str] = []
    real_put = indexer.put_page
    def counting(db: Any, page: Any) -> None:
        written.append(page.meta.skaz_id)
        real_put(db, page)

    monkeypatch.setattr(indexer, "put_page", counting)
    for _ in range(3):
        assert ready.page("pg-1").entries[0].text == "Statement 1."
    assert written == []
    path = ready.library_root / record.rel_path  # edited in Obsidian
    edited = path.read_text(encoding="utf-8").replace("Statement 1.", "Statement one.")
    path.write_text(edited, encoding="utf-8")
    assert ready.page("pg-1").entries[0].text == "Statement one."
    assert written == ["pg-1"]
    ready.page("pg-1")
    assert written == ["pg-1"]
