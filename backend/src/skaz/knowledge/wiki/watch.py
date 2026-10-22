"""External edits of the wiki (Obsidian, Finder): polling ``Wiki/`` every 2 s (API-B2 §2.4).

No new dependency (no FSEvents/watchfiles): one ``scandir`` of the four page
folders per tick, comparing ``(mtime_ns, size)``. A new or changed page is
re-read (an edited agent block becomes ``user_edited`` — the scanner's rule)
and re-indexed — an edit of a known page is a manual edit for connections (a
connection it deleted is remembered, the page waits for a connection run); a
page that disappeared leaves the index. The first tick only
takes the snapshot.
"""

from __future__ import annotations

import os
from pathlib import Path

from ..errors import LibraryUnavailable
from ..index import indexer
from ..index.scanner import ScannedPage, read_page
from ..library.layout import WIKI_SUBDIRS
from ..markdown.page import PageFormatError
from ..service import KnowledgeService
from .connections import PairIds, after_user_edit, linked_pages
from .pages_io import forget_page

INTERVAL_S = 2.0
Snapshot = dict[str, tuple[int, int]]


class WikiWatcher:
    def __init__(self, kb: KnowledgeService) -> None:
        self.kb = kb
        self._snapshot: Snapshot | None = None
        self._root: Path | None = None

    def _take(self, root: Path) -> Snapshot:
        found: Snapshot = {}
        for subdir in WIKI_SUBDIRS.values():
            directory = root / "Wiki" / subdir
            try:
                entries = list(os.scandir(directory))
            except FileNotFoundError:
                continue
            for entry in entries:
                if entry.name.startswith(".") or not entry.name.endswith(".md") or not entry.is_file():
                    continue
                stat = entry.stat()
                found[f"Wiki/{subdir}/{entry.name}"] = (stat.st_mtime_ns, stat.st_size)
        return found

    def poll(self) -> int:
        """One tick: re-index what changed since the last tick; returns how many pages changed.

        The whole tick holds the library's write lock: a SKAZ write between reading a page here
        and indexing it would otherwise be replaced by the older copy, and the next snapshot (which
        already has the new mtime) would never bring it back.
        """
        with self.kb.writing():
            return self._poll()

    def _poll(self) -> int:
        try:
            library = self.kb.require()
        except LibraryUnavailable:
            self._snapshot, self._root = None, None
            return 0
        current = self._take(library.root)
        previous, self._snapshot = self._snapshot, current
        if previous is None or self._root != library.root:
            self._root = library.root
            return 0
        pages: list[ScannedPage] = []
        edited: list[tuple[str, set[PairIds]]] = []
        for rel_path, stamp in current.items():
            if previous.get(rel_path) == stamp:
                continue
            try:
                page = read_page(library, library.root / rel_path)
            except (OSError, PageFormatError, UnicodeDecodeError):
                continue  # not a SKAZ page (or mid-write): neither shown nor touched
            known = self.kb.page_repo.get(page.meta.skaz_id)
            if known is not None and known.file_sha256 == page.file_sha256 and known.rel_path == rel_path:
                continue  # SKAZ wrote it itself and indexed it already
            pages.append(page)
            if known is not None:
                # Before this tick indexes anything: a rename moves a linked page in the same tick.
                edited.append((known.id, linked_pages(self.kb.db, known.id)))
        for page in pages:
            indexer.put_page(self.kb.db, page)
        changed = len(pages)
        for page_id, before in edited:
            # A manual edit outside SKAZ: a connection it deleted is never suggested again, and the
            # page waits for the next connection run (C1-a, user decisions 2026-10-21, 4–5). Compared
            # once every changed page is indexed, so a link to a page renamed (Obsidian "update
            # links") resolves to its new path rather than reading as a deleted connection.
            after_user_edit(self.kb.db, page_id, before)
        for rel_path in previous.keys() - current.keys():
            for record in self.kb.pages():
                if record.rel_path == rel_path:
                    forget_page(self.kb.db, record.id)
                    changed += 1
        if changed:
            # A rewrite by read_page changed the file again; take that state as the new baseline.
            self._snapshot = self._take(library.root)
        return changed
