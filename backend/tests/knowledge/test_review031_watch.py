"""Review 0.3.1 (C-13): an Obsidian rename with "update links" is not the user deleting a connection.

Obsidian moves the linked page and rewrites the link on the page that holds the connection in one go;
one watcher tick sees both files changed, in any order.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from skaz.knowledge.service import KnowledgeService
from skaz.knowledge.wiki.watch import Snapshot
from tests.knowledge.test_wiki_connection_batches import entropy_temperature, holder_of_link, ids, lecture


async def test_a_rename_with_updated_links_keeps_the_connection_suggestable(
        ready: KnowledgeService, monkeypatch: pytest.MonkeyPatch) -> None:
    _wiki, _ingest, service, _material = await lecture(ready, entropy_temperature)
    holder, _block_id = holder_of_link(ready)
    other = next(title for title in ids(ready) if title != holder and f"[[Wiki/Concepts/{title}|" in (
        ready.library_root / f"Wiki/Concepts/{holder}.md").read_text(encoding="utf-8"))
    holder_path = f"Wiki/Concepts/{holder}.md"
    watcher = service.watcher
    take = watcher._take

    def holder_first(root: Path) -> Snapshot:  # the page with the link is re-read before the renamed one
        found = take(root)
        return {path: found[path] for path in sorted(found, key=lambda path: path != holder_path)}

    monkeypatch.setattr(watcher, "_take", holder_first)
    assert watcher.poll() == 0  # snapshot
    renamed = f"{other} (газ)"
    root = ready.library_root
    (root / f"Wiki/Concepts/{other}.md").rename(root / f"Wiki/Concepts/{renamed}.md")
    page = root / holder_path
    page.write_text(page.read_text(encoding="utf-8").replace(
        f"[[Wiki/Concepts/{other}|", f"[[Wiki/Concepts/{renamed}|"), encoding="utf-8")
    assert watcher.poll() == 2
    with ready.db.read() as connection:
        removed = connection.execute(
            "SELECT COUNT(*) FROM wiki_connection_checks WHERE outcome = 'removed'").fetchone()[0]
    assert removed == 0
