"""``runtime.kb``: the knowledge wiki facade used by the API and by the other areas.

The library files are the primary copy; ``knowledge.sqlite3`` is an index
rebuilt from them plus service tables. Nothing touches the Documents folder
until the user connects a library (``connect``), and the startup scan only
opens a library that was connected before. A missing, unreadable or replaced
root makes the library *unavailable* — writes are refused, the index is kept.
"""
from __future__ import annotations

import threading
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from .errors import LibraryConflict, LibraryUnavailable, NotFound
from .index import indexer
from .index.scanner import ScannedMaterial, read_page, scan_library
from .index.search import SearchResults, search
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

LibraryState = Literal["not_configured", "ready", "unavailable"]
NOT_CONNECTED = "No library is connected yet."
SANDBOX_REASON = "Development libraries must stay inside their profile Documents folder."


@dataclass(frozen=True)
class LibraryView:
    state: LibraryState
    root: str | None
    suggested_root: str
    reason: str | None
    library_id: str | None


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
        self._closed = False

    # -- library state ------------------------------------------------------

    def view(self) -> LibraryView:
        with self._state_lock:
            stored = self.library_state.get()
            library = self._library
            if stored is None:
                return LibraryView("not_configured", None, str(self.suggested_root()), None, None)
            if library is None:
                return LibraryView("unavailable", stored.root, str(self.suggested_root()),
                                   self._reason or NOT_CONNECTED, stored.library_id)
            return LibraryView("ready", str(library.root), str(self.suggested_root()), None,
                               library.library_id)

    def suggested_root(self) -> Path:
        """Where ``connect(None)`` would put the library; reads the folder, never writes."""
        try:
            return resolve_library_root(self.documents_dir)
        except OSError:
            return self.documents_dir / "SKAZ"

    def start(self) -> None:
        """Startup scan: reopen the connected library, if any. Never creates one."""
        self.rescan()

    def rescan(self) -> None:
        stored = self.library_state.get()
        if stored is not None:
            self._open_and_scan(Path(stored.root), stored.library_id)

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
        with self._state_lock:
            library = Library.create(root) if read_marker(root) is None else Library.open(root, None)
            self.library_state.set(str(root), library.library_id)
            self._open_and_scan(root, library.library_id)
        return self.view()

    def _inside_sandbox(self, root: Path) -> bool:
        if self.documents_sandbox is None:
            return True
        boundary = self.documents_sandbox.resolve()
        candidate = root.resolve()
        return candidate == boundary or boundary in candidate.parents

    def _open_and_scan(self, root: Path, library_id: str) -> None:
        with self._state_lock:
            try:
                if not self._inside_sandbox(root):
                    raise LibraryUnavailable(SANDBOX_REASON)
                library = Library.open(root, library_id)
                library.ensure_inbox()
                result = scan_library(library, indexer.known_paths(self.db))
                indexer.replace_index(self.db, result)
            except LibraryUnavailable as error:
                self._library, self._reason = None, error.message
                return
            except OSError as error:
                self._library = None
                self._reason = f"SKAZ can't use the library folder: {error.strerror or error}."
                return
            self._library, self._reason = library, None
            for listener in list(self.after_scan):
                listener()

    def require(self) -> Library:
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
        library = self.require()
        entry = library.create_folder(name)
        indexer.put_folder(self.db, entry.id, entry.name, library.relative(entry.path), entry.system,
                           entry.created_at)
        return self._folder_record(entry.id)

    def rename_folder(self, folder_id: str, name: str) -> FolderRecord:
        library = self.require()
        entry = library.rename_folder(folder_id, name)
        indexer.put_folder(self.db, entry.id, entry.name, library.relative(entry.path), entry.system,
                           entry.created_at)
        return self._folder_record(entry.id)

    def delete_folder(self, folder_id: str) -> None:
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
    ) -> MaterialFiles:
        library = self.require()
        files = library.create_material(folder_id, title, kind, fragments, status=status, origin=origin,
                                        languages=languages)
        self._index_material(library, files)
        return files

    def append_fragments(self, material_id: str, fragments: Sequence[FragmentInput]) -> list[Fragment]:
        """Live recording growth: new ``seg`` ids after the existing ones, indexed immediately."""
        library = self.require()
        record = self.material_repo.get(material_id)
        hint = record.rel_dir if record else None
        added = library.append_fragments(material_id, fragments, hint=hint)
        self._index_material(library, library.read_material(material_id, hint=hint))
        return added

    def set_material_status(self, material_id: str, status: MaterialStatus) -> None:
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
        if library is not None:
            try:
                scanned = read_page(library, library.root / record.rel_path)
            except (OSError, PageFormatError, UnicodeDecodeError):
                scanned = None  # the next full scan decides; the indexed copy is shown meanwhile
            if scanned is not None and scanned.meta.skaz_id == page_id:
                indexer.put_page(self.db, scanned)
                record = self.page_repo.get(page_id) or record
        return self._page_view(record)

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

    def close(self) -> None:
        if not self._closed:
            self._closed = True
            self.db.close()
