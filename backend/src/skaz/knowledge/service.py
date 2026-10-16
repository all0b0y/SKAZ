"""``runtime.kb``: the knowledge wiki facade used by the API and by the other areas.

The library files are the primary copy; ``knowledge.sqlite3`` is an index
rebuilt from them plus service tables. Nothing touches the Documents folder
until the user connects a library (``connect``), and the startup scan only
opens a library that was connected before. A missing, unreadable or replaced
root makes the library *unavailable* — writes are refused, the index is kept.
"""
from __future__ import annotations

import hashlib
import logging
import threading
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from .errors import LibraryConflict, LibraryUnavailable, NotFound
from .index import indexer
from .index.scanner import ScannedMaterial, ScanStopped, read_page, scan_library
from .index.search import SearchResults, search
from .library.fsio import os_error_reason
from .library.layout import read_marker, resolve_library_root
from .library.library import Library, MaterialFiles
from .markdown.page import PageDocument, PageFormatError
from .markdown.source import Fragment, FragmentInput, MaterialKind, MaterialStatus, Origin
from .notifications.actions import NotificationActions
from .store.database import KNOWLEDGE_DB_NAME, KnowledgeDatabase
from .store.records import FolderRecord, FragmentRecord, MaterialRecord, NotificationRecord, PageRecord
from .store.repositories import (
    FolderRepository,
    LibraryStateRepository,
    MaterialRepository,
    NotificationRepository,
    PageRepository,
    SettingsRepository,
)

logger = logging.getLogger(__name__)

LibraryState = Literal["not_configured", "ready", "unavailable"]
NOT_CONNECTED = "No library is connected yet."
CLOSING = "SKAZ is closing."
#: ``close()`` waits this long for a library write in progress before closing the database.
CLOSE_WAIT_S = 1.5
SANDBOX_REASON = "Development libraries must stay inside their profile Documents folder."
DATA_DIR_REASON = "SKAZ keeps its own data here. Choose another folder for the library."
#: A scan that had to leave out unreadable entries (iCloud still syncing them) runs again this often.
UNREADABLE_RETRY_S = 60.0
UNREADABLE_KIND = "library_unreadable"


@dataclass(frozen=True)
class LibraryView:
    state: LibraryState
    root: str | None
    suggested_root: str
    reason: str | None
    library_id: str | None
    #: A full scan (startup, retry, connect) is rebuilding the index; what is shown may be a step behind.
    indexing: bool = False


@dataclass(frozen=True)
class MaterialDetail:
    id: str
    title: str
    kind: str
    status: str
    folder_id: str
    origin: dict[str, Any] | None
    languages: tuple[str, ...]
    created_at: str
    fragments: tuple[FragmentRecord, ...]


@dataclass(frozen=True)
class CitationView:
    material_id: str
    seg: int
    #: False when the cited material/fragment is not in the library (anymore).
    available: bool
    material_title: str | None = None
    start_ms: int | None = None
    end_ms: int | None = None
    page: int | None = None
    #: The verbatim quote the claim rests on (highlight it, not the whole fragment); None if unknown.
    quote: str | None = None


@dataclass(frozen=True)
class EntryView:
    id: str
    kind: str
    owner: str
    marked: bool
    section: str | None
    text: str
    hash: str
    citations: tuple[CitationView, ...]


@dataclass(frozen=True)
class PageView:
    id: str
    kind: str
    title: str
    original: str | None
    aliases: tuple[str, ...]
    folders: tuple[str, ...]
    language: str
    sources: tuple[str, ...]
    rel_path: str
    entries: tuple[EntryView, ...]


class KnowledgeService:
    def __init__(self, data_dir: Path, *, documents_dir: Path, documents_sandbox: Path | None = None) -> None:
        self.data_dir = data_dir
        self.documents_dir = documents_dir
        self.documents_sandbox = documents_sandbox
        self.db = KnowledgeDatabase(data_dir / KNOWLEDGE_DB_NAME)
        self.library_state = LibraryStateRepository(self.db)
        self.settings = SettingsRepository(self.db)
        self.folder_repo = FolderRepository(self.db)
        self.material_repo = MaterialRepository(self.db)
        self.page_repo = PageRepository(self.db)
        self.notification_repo = NotificationRepository(self.db)
        #: Buttons and handlers of notifications that need a decision; areas register their kinds.
        self.notification_actions = NotificationActions()
        #: Called after every full library scan (W2 rebuilds the corrections index and graph edges).
        self.after_scan: list[Callable[[], None]] = []
        self._library: Library | None = None
        self._reason: str | None = None
        self._state_lock = threading.RLock()
        #: Guards the state snapshot ``view()`` reads; never held across a disk or database wait.
        self._view_lock = threading.Lock()
        stored = self.library_state.get()
        self._stored: tuple[str, str] | None = (stored.root, stored.library_id) if stored else None
        self._indexing = False
        self._closed = False
        #: Library-relative paths the last full scan could not read (QA E9), and when it ran.
        self._unreadable: tuple[str, ...] = ()
        self._unreadable_notified: frozenset[str] = frozenset()
        self._scanned_at = 0.0
        self.clock: Callable[[], float] = time.monotonic

    # -- library state ------------------------------------------------------

    def view(self) -> LibraryView:
        """The library state; never waits for a write or a scan (a snapshot under a light lock)."""
        with self._view_lock:
            stored, library, reason, indexing = self._stored, self._library, self._reason, self._indexing
        suggested = str(self.suggested_root())
        if stored is None:
            return LibraryView("not_configured", None, suggested, None, None)
        if library is None:
            return LibraryView("unavailable", stored[0], suggested, reason or NOT_CONNECTED, stored[1],
                               indexing)
        return LibraryView("ready", str(library.root), suggested, None, library.library_id, indexing)

    def _publish(self, library: Library | None, reason: str | None) -> None:
        with self._view_lock:
            self._library, self._reason = library, reason

    def _set_indexing(self, indexing: bool) -> None:
        with self._view_lock:
            self._indexing = indexing

    def suggested_root(self) -> Path:
        """Where ``connect(None)`` would put the library; reads the folder, never writes."""
        try:
            return resolve_library_root(self.documents_dir)
        except OSError:
            return self.documents_dir / "SKAZ"

    def start(self) -> None:
        """Startup scan: reopen the connected library, if any. Never creates one."""
        if self.open_connected():
            self.rescan()

    def open_connected(self) -> bool:
        """The quick half of the startup: reopen the connected library and serve the index it had.

        Returns whether a full scan should follow (``rescan``, in the background at app start);
        meanwhile ``view()`` says ``indexing``. Never creates a library, never waits for a writer.
        """
        stored = self._stored
        if stored is None or self._closed:
            return False
        root, library_id = Path(stored[0]), stored[1]
        try:
            if not self._inside_sandbox(root):
                raise LibraryUnavailable(SANDBOX_REASON)
            library = Library.open(root, library_id)
        except LibraryUnavailable as error:
            self._publish(None, error.message)
            return True  # the scan reports the same, or finds the folder back
        except OSError as error:
            self._publish(None, os_error_reason(error, root))
            return True
        with self._view_lock:
            self._library, self._reason, self._indexing = library, None, True
        return True

    def rescan(self) -> None:
        stored = self._stored
        if stored is not None:
            self._open_and_scan(Path(stored[0]), stored[1])

    def retry(self) -> LibraryView:
        self.rescan()
        return self.view()

    def connect(self, path: str | None) -> LibraryView:
        """Create or open a library after the user confirmed the place (FILESYSTEM-LIBRARY-SPEC 4, 12)."""
        base = Path(path).expanduser() if path else self.documents_dir
        if not base.is_absolute():
            raise LibraryConflict("Choose a full folder path.")
        root = resolve_library_root(base)
        if not self._inside_sandbox(root):
            raise LibraryConflict(SANDBOX_REASON)
        if self._overlaps_data_dir(root):
            raise LibraryConflict(DATA_DIR_REASON)
        with self._state_lock:
            library = Library.create(root) if read_marker(root) is None else Library.open(root, None)
            previous = self._stored
            self.library_state.set(str(root), library.library_id)
            with self._view_lock:
                self._stored = (str(root), library.library_id)
            if previous is not None and previous[1] != library.library_id:
                # Another library: nothing of the previous one is served under its name, even
                # when the new one can't be read yet (its scan fails) — QA E15.
                with self._view_lock:
                    self._library, self._reason = None, NOT_CONNECTED
                indexer.clear_index(self.db)
                self._note_unreadable(())
            self._open_and_scan(root, library.library_id)
        return self.view()

    def _overlaps_data_dir(self, root: Path) -> bool:
        """The library can't live in SKAZ's own data folder, nor hold it (QA E5)."""
        data, candidate = self.data_dir.resolve(), root.resolve()
        return candidate == data or data in candidate.parents or candidate in data.parents

    def _inside_sandbox(self, root: Path) -> bool:
        if self.documents_sandbox is None:
            return True
        boundary = self.documents_sandbox.resolve()
        candidate = root.resolve()
        return candidate == boundary or boundary in candidate.parents

    def _open_and_scan(self, root: Path, library_id: str) -> None:
        with self._state_lock:
            if self._closed:
                return
            self._set_indexing(True)
            try:
                self._scan(root, library_id)
            finally:
                self._set_indexing(False)

    def _scan(self, root: Path, library_id: str) -> None:
        self._scanned_at = self.clock()
        try:
            if not self._inside_sandbox(root):
                raise LibraryUnavailable(SANDBOX_REASON)
            library = Library.open(root, library_id)
            library.ensure_inbox()
            result = scan_library(library, indexer.known_paths(self.db), stop=self._closing)
            indexer.replace_index(self.db, result, stop=self._closing)
        except ScanStopped:
            return  # SKAZ is closing: the index stays as it was, the next start scans again
        except LibraryUnavailable as error:
            self._publish(None, error.message)
            return
        except OSError as error:
            self._publish(None, os_error_reason(error, root))
            return
        self._publish(library, None)
        self._note_unreadable(tuple(result.unreadable))
        for listener in list(self.after_scan):
            listener()

    def _note_unreadable(self, paths: tuple[str, ...]) -> None:
        """Remember what the scan left out; tell the user once per newly unreadable entry."""
        self._unreadable, self._scanned_at = paths, self.clock()
        if paths:
            logger.warning("library scan left out %d unreadable entries", len(paths))
        new = [path for path in paths if path not in self._unreadable_notified]
        self._unreadable_notified = frozenset(paths)
        if not new:
            return
        names = ", ".join(f"“{path}”" for path in new[:3])
        if len(new) > 3:
            names += f" and {len(new) - 3} more"
        it = "it" if len(new) == 1 else "them"
        self.notify(
            UNREADABLE_KIND, "iCloud is still syncing part of the library",
            body=(f"SKAZ can't read {names} yet and left {it} out; the rest of the library works. "
                  f"SKAZ tries again every minute. If this stays, look at {it} in Finder: a folder "
                  "you already deleted can come back while iCloud syncs — delete it again."),
            payload={"paths": list(new)},
        )

    @property
    def unreadable(self) -> tuple[str, ...]:
        """Paths the last full scan could not read (an iCloud placeholder still syncing, no permission)."""
        return self._unreadable

    def retry_unreadable(self) -> bool:
        """Rescan when the last scan left something out and ``UNREADABLE_RETRY_S`` has passed.

        Called by a periodic background tick; returns whether a scan ran.
        """
        if not self._unreadable or self._closed or self.clock() - self._scanned_at < UNREADABLE_RETRY_S:
            return False
        self.rescan()
        return True

    def writing(self) -> threading.RLock:
        """The one lock for every read-then-write of library files and their index rows.

        Held by: the full scan (startup, connect, retry, rescan) from its first read to the index
        replace and the ``after_scan`` rebuilds; material and folder writes; every wiki page write
        (ingest, W2 edits, recheck, delete, move — ``IngestService.write_lock`` *is* this lock);
        the ``Wiki/`` watcher's tick; re-indexing a page on open; the corrections file and its
        index. A write that landed between another party's read and its write would be undone in
        the index while the file kept it. Re-entrant (a write may call another write). Hold it only
        in worker threads (``disk_call``), never across an ``await``.
        """
        return self._state_lock

    def require(self) -> Library:
        if self._closed:
            raise LibraryUnavailable(CLOSING)  # a write that had not started by shutdown never starts
        library = self._library
        if library is None:
            raise LibraryUnavailable(self._reason or NOT_CONNECTED)
        return library

    @property
    def library_root(self) -> Path:
        return self.require().root

    # -- folders ------------------------------------------------------------

    def folders(self) -> list[FolderRecord]:
        return self.folder_repo.list_all()

    def _folder_record(self, folder_id: str) -> FolderRecord:
        record = self.folder_repo.get(folder_id)
        if record is None:
            raise NotFound("Folder not found.")
        return record

    def create_folder(self, name: str) -> FolderRecord:
        with self.writing():
            library = self.require()
            entry = library.create_folder(name)
            indexer.put_folder(self.db, entry.id, entry.name, library.relative(entry.path), entry.system,
                               entry.created_at)
        return self._folder_record(entry.id)

    def rename_folder(self, folder_id: str, name: str) -> FolderRecord:
        with self.writing():
            library = self.require()
            entry = library.rename_folder(folder_id, name)
            indexer.put_folder(self.db, entry.id, entry.name, library.relative(entry.path), entry.system,
                               entry.created_at)
        return self._folder_record(entry.id)

    def delete_folder(self, folder_id: str) -> None:
        with self.writing():
            library = self.require()
            library.delete_folder(folder_id)
            indexer.delete_folder(self.db, folder_id)

    # -- materials ----------------------------------------------------------

    def _index_material(self, library: Library, files: MaterialFiles) -> None:
        indexer.put_material(self.db, ScannedMaterial(
            files, library.relative(files.directory), library.relative(files.source_path),
        ))

    def create_material(
        self, folder_id: str, title: str, kind: MaterialKind, fragments: Sequence[FragmentInput], *,
        status: MaterialStatus = "ready", origin: Origin | None = None, languages: Sequence[str] = (),
        unique: bool = False,
    ) -> MaterialFiles:
        with self.writing():
            library = self.require()
            files = library.create_material(folder_id, title, kind, fragments, status=status, origin=origin,
                                            languages=languages, unique=unique)
            self._index_material(library, files)
        return files

    def append_fragments(self, material_id: str, fragments: Sequence[FragmentInput]) -> list[Fragment]:
        """Live recording growth: new ``seg`` ids after the existing ones, indexed immediately."""
        with self.writing():
            library = self.require()
            record = self.material_repo.get(material_id)
            hint = record.rel_dir if record else None
            added = library.append_fragments(material_id, fragments, hint=hint)
            self._index_material(library, library.read_material(material_id, hint=hint))
        return added

    def set_material_status(self, material_id: str, status: MaterialStatus) -> None:
        with self.writing():
            library = self.require()
            record = self.material_repo.get(material_id)
            hint = record.rel_dir if record else None
            library.set_material_status(material_id, status, hint=hint)
            self._index_material(library, library.read_material(material_id, hint=hint))

    def materials(self, *, folder_id: str | None = None, kind: str | None = None) -> list[MaterialRecord]:
        return self.material_repo.list_all(folder_id=folder_id, kind=kind)

    def material(self, material_id: str) -> MaterialDetail:
        record = self.material_repo.get(material_id)
        if record is None:
            raise NotFound("Material not found.")
        return MaterialDetail(
            id=record.id, title=record.title, kind=record.kind, status=record.status,
            folder_id=record.folder_id, origin=record.origin, languages=record.languages,
            created_at=record.created_at, fragments=tuple(self.material_repo.fragments(material_id)),
        )

    # -- wiki pages ---------------------------------------------------------

    def create_page(self, document: PageDocument) -> Path:
        with self.writing():
            library = self.require()
            path = library.create_page(document)
            indexer.put_page(self.db, read_page(library, path))
        return path

    def pages(self, *, kind: str | None = None, folder_id: str | None = None) -> list[PageRecord]:
        return self.page_repo.list_all(kind=kind, folder_id=folder_id)

    def page(self, page_id: str) -> PageView:
        """The page as indexed after re-reading its file (external edits are detected on open)."""
        record = self.page_repo.get(page_id)
        if record is None:
            raise NotFound("Page not found.")
        library = self._library
        if library is not None and self._file_changed(library, record):
            with self.writing():  # a SKAZ write between this read and put_page would be undone
                try:
                    scanned = read_page(library, library.root / record.rel_path)
                except (OSError, PageFormatError, UnicodeDecodeError):
                    scanned = None  # the next full scan decides; the indexed copy is shown meanwhile
                if scanned is not None and scanned.meta.skaz_id == page_id:
                    indexer.put_page(self.db, scanned)
                    record = self.page_repo.get(page_id) or record
        return self._page_view(record)

    @staticmethod
    def _file_changed(library: Library, record: PageRecord) -> bool:
        """Whether the page file differs from the indexed copy (an outside edit since): opening a page
        re-reads and re-indexes it only then, not on every open (no fsync and FTS pass per open)."""
        try:
            data = (library.root / record.rel_path).read_bytes()
        except OSError:
            return True  # gone or unreadable: the locked path below decides, as before
        return hashlib.sha256(data).hexdigest() != record.file_sha256

    def _page_view(self, record: PageRecord) -> PageView:
        blocks = self.page_repo.blocks(record.id)
        keys = {(cite.material_id, cite.seg) for block in blocks for cite in block.citations}
        fragments = self.material_repo.fragment_map(keys)

        def citation(material_id: str, seg: int, quote: str | None) -> CitationView:
            found = fragments.get((material_id, seg))
            if found is None:
                return CitationView(material_id, seg, available=False, quote=quote)
            fragment, title = found
            return CitationView(material_id, seg, True, title, fragment.start_ms, fragment.end_ms,
                                fragment.page, quote)

        return PageView(
            id=record.id, kind=record.kind, title=record.title, original=record.original,
            aliases=record.aliases, folders=record.folders, language=record.language, sources=record.sources,
            rel_path=record.rel_path,
            entries=tuple(
                EntryView(block.block_id, block.kind, block.owner, block.marked, block.section, block.text,
                          block.hash,
                          tuple(citation(cite.material_id, cite.seg, cite.quote) for cite in block.citations))
                for block in blocks
            ),
        )

    # -- search and notifications -------------------------------------------

    def search(self, query: str, *, limit: int = 20) -> SearchResults:
        return search(self.db, query, limit=limit)

    def notify(self, kind: str, title: str, *, body: str = "", payload: dict[str, Any] | None = None,
               requires_action: bool = False, subject: dict[str, Any] | None = None) -> NotificationRecord:
        return self.notification_repo.add(kind, title, body=body, payload=payload,
                                          requires_action=requires_action, subject=subject)

    def notifications(self, *, include_dismissed: bool = False) -> list[NotificationRecord]:
        return self.notification_repo.list_all(include_dismissed=include_dismissed)

    def dismiss_notification(self, notification_id: str) -> NotificationRecord:
        record = self.notification_repo.dismiss(notification_id)
        if record is None:
            raise NotFound("Notification not found.")
        return record

    def _closing(self) -> bool:
        return self._closed

    def close(self, *, wait_s: float = CLOSE_WAIT_S) -> None:
        """Refuse new library writes, let the one in progress finish (up to ``wait_s``), close the database.

        A write still running after ``wait_s`` (a stuck disk) keeps the database open: it is left
        to the OS at exit (SQLite's journal makes that safe) rather than closed under the writer.
        A running full scan stops between objects and rolls back.
        """
        if self._closed:
            return
        self._closed = True
        if not self._state_lock.acquire(timeout=wait_s):
            logger.warning("knowledge close: a library write still ran after %.1f s; database left open",
                           wait_s)
            return
        try:
            if not self.db.close(timeout=wait_s):
                logger.warning("knowledge close: the database stayed busy for %.1f s; left open", wait_s)
        finally:
            self._state_lock.release()
