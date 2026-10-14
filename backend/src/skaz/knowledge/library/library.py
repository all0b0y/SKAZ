"""Folder, material and page files of one library root.

All mutations take the library lock, check the name against every entry of
the target directory (unknown files included) by ``name_key``, build the new
object in ``<root>/.skaz/tmp`` and publish it with one exclusive rename. A
refused name therefore leaves nothing behind, and a name taken by another
process between the check and the publish is refused by the kernel.
"""
from __future__ import annotations

import contextlib
import json
import os
import shutil
import threading
from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4

from pydantic import ValidationError

from ..errors import (
    FolderNotEmpty,
    LibraryConflict,
    LibraryUnavailable,
    NameTaken,
    NotFound,
    ProtectedItem,
)
from ..ids import new_id, utc_now
from ..markdown.page import PageDocument, render_page
from ..markdown.source import (
    Fragment,
    FragmentInput,
    FragmentMeta,
    MaterialKind,
    MaterialManifest,
    MaterialStatus,
    Origin,
    number_fragments,
    read_source,
    render_source,
)
from ..markdown.text import name_key
from .fsio import (
    create_exclusive,
    dump_json,
    fsync_dir,
    read_json,
    rename_exclusive,
    visible_entries,
    write_atomic,
)
from .layout import (
    FOLDER_MARKER,
    MARKER_PATH,
    MATERIAL_MANIFEST,
    MATERIALS_DIR,
    SERVICE_DIR,
    STAGING_PATH,
    WIKI_DIR,
    WIKI_SUBDIRS,
    FolderMarker,
    LibraryMarker,
    read_marker,
)
from .names import validate_name

INBOX_ID = "fld-inbox"
INBOX_NAME = "Inbox"
_RESERVED_FOLDER_NAMES = (INBOX_NAME,)


@dataclass(frozen=True)
class FolderEntry:
    id: str
    name: str
    system: bool
    created_at: str
    path: Path


@dataclass(frozen=True)
class MaterialFiles:
    manifest: MaterialManifest
    #: The directory name: a Finder rename is accepted as the new title.
    title: str
    folder_id: str
    directory: Path
    source_path: Path
    fragments: list[Fragment]


class Library:
    def __init__(self, root: Path, marker: LibraryMarker) -> None:
        self.root = root
        self.marker = marker
        self._lock = threading.RLock()

    @property
    def library_id(self) -> str:
        return self.marker.library_id

    @property
    def materials_dir(self) -> Path:
        return self.root / MATERIALS_DIR

    @property
    def wiki_dir(self) -> Path:
        return self.root / WIKI_DIR

    def relative(self, path: Path) -> str:
        return path.relative_to(self.root).as_posix()

    # -- root ---------------------------------------------------------------

    @classmethod
    def create(cls, root: Path) -> Library:
        """Create a new, empty library at ``root`` (absent or empty folder) in one rename."""
        if root.exists():
            if read_marker(root) is not None:
                raise LibraryConflict("A SKAZ library already exists here. Open it instead.")
            if visible_entries(root):
                raise LibraryConflict("This folder already has other files. Choose another folder.")
        root.parent.mkdir(parents=True, exist_ok=True)
        staging = root.parent / f".{root.name}.creating-{uuid4().hex}"
        marker = LibraryMarker(library_id=new_id("lib"), created_at=utc_now())
        try:
            staging.mkdir()
            (staging / STAGING_PATH).mkdir(parents=True)
            inbox = staging / MATERIALS_DIR / INBOX_NAME
            (inbox / SERVICE_DIR).mkdir(parents=True)
            write_atomic(inbox / FOLDER_MARKER, dump_json(
                FolderMarker(id=INBOX_ID, system=True, created_at=marker.created_at).model_dump()))
            for subdir in WIKI_SUBDIRS.values():
                (staging / WIKI_DIR / subdir).mkdir(parents=True)
            write_atomic(staging / WIKI_DIR / "index.md", b"# Index\n")
            write_atomic(staging / WIKI_DIR / "log.md", b"# Log\n")
            # The marker is written last: a staging folder without it is never a library.
            write_atomic(staging / MARKER_PATH, dump_json(marker.model_dump()))
            if root.exists():
                with contextlib.suppress(FileNotFoundError):
                    (root / ".DS_Store").unlink()
                root.rmdir()
            rename_exclusive(staging, root)
        except FileExistsError as error:
            raise LibraryConflict("Something else appeared at this place. Choose another folder.") from error
        except OSError as error:
            reason = error.strerror or str(error)
            raise LibraryConflict(f"SKAZ can't create the library here: {reason}.") from error
        finally:
            shutil.rmtree(staging, ignore_errors=True)
        fsync_dir(root.parent)
        return cls(root, marker)

    @classmethod
    def open(cls, root: Path, expected_id: str | None) -> Library:
        try:
            if not root.is_dir():
                raise LibraryUnavailable(f"The library folder is missing: {root}")
            marker = read_marker(root)
        except OSError as error:
            raise LibraryUnavailable(f"SKAZ can't read the library folder: {root}") from error
        if marker is None:
            raise LibraryUnavailable(f"The library marker is missing or damaged: {root}")
        if expected_id is not None and marker.library_id != expected_id:
            raise LibraryUnavailable(f"This folder holds a different SKAZ library: {root}")
        library = cls(root, marker)
        library._clear_staging()
        return library

    def _clear_staging(self) -> None:
        staging = self.root / STAGING_PATH
        with contextlib.suppress(OSError):
            for entry in os.listdir(staging):
                shutil.rmtree(staging / entry, ignore_errors=True)

    @contextlib.contextmanager
    def _staging(self) -> Iterator[Path]:
        area = self.root / STAGING_PATH
        area.mkdir(parents=True, exist_ok=True)
        path = area / uuid4().hex
        path.mkdir()
        try:
            yield path
        finally:
            shutil.rmtree(path, ignore_errors=True)

    @staticmethod
    def _assert_free(directory: Path, name: str, *, allow: str | None = None) -> None:
        key = name_key(name)
        for entry in os.listdir(directory):
            if entry != allow and name_key(entry) == key:
                raise NameTaken()

    @staticmethod
    def _publish(staging: Path, target: Path) -> None:
        try:
            rename_exclusive(staging, target)
        except FileExistsError as error:
            raise NameTaken() from error
        fsync_dir(target.parent)

    # -- folders ------------------------------------------------------------

    def folders(self) -> list[FolderEntry]:
        """Folders with a valid marker; anything else under Materials is not ours and is skipped.

        ``OSError`` (other than a folder vanishing mid-listing) propagates: an
        unreadable library is not an empty one.
        """
        found: list[FolderEntry] = []
        for name in sorted(os.listdir(self.materials_dir)):
            path = self.materials_dir / name
            if name.startswith(".") or not path.is_dir():
                continue
            try:
                marker = FolderMarker.model_validate(read_json(path / FOLDER_MARKER))
            except (FileNotFoundError, NotADirectoryError, ValueError, UnicodeDecodeError):
                continue
            found.append(FolderEntry(marker.id, name, marker.system, marker.created_at, path))
        return sorted(found, key=lambda entry: (entry.id != INBOX_ID, name_key(entry.name)))

    def folder(self, folder_id: str) -> FolderEntry:
        matches = [entry for entry in self.folders() if entry.id == folder_id]
        if len(matches) != 1:
            raise NotFound("Folder not found.")
        return matches[0]

    def ensure_inbox(self) -> None:
        """Inbox always exists; recreate it if it was removed outside SKAZ."""
        with self._lock:
            if any(entry.id == INBOX_ID for entry in self.folders()):
                return
            with contextlib.suppress(NameTaken):
                self._make_folder(INBOX_NAME, INBOX_ID, system=True)

    def _make_folder(self, name: str, folder_id: str, *, system: bool) -> FolderEntry:
        self._assert_free(self.materials_dir, name)
        marker = FolderMarker(id=folder_id, system=system, created_at=utc_now())
        target = self.materials_dir / name
        with self._staging() as staging:
            (staging / SERVICE_DIR).mkdir()
            write_atomic(staging / FOLDER_MARKER, dump_json(marker.model_dump()))
            self._publish(staging, target)
        return FolderEntry(marker.id, name, system, marker.created_at, target)

    def create_folder(self, name: str) -> FolderEntry:
        clean = validate_name(name, reserved=_RESERVED_FOLDER_NAMES)
        with self._lock:
            return self._make_folder(clean, new_id("fld"), system=False)

    def rename_folder(self, folder_id: str, name: str) -> FolderEntry:
        if folder_id == INBOX_ID:
            raise ProtectedItem("Inbox can't be renamed.")
        clean = validate_name(name, reserved=_RESERVED_FOLDER_NAMES)
        with self._lock:
            entry = self.folder(folder_id)
            if clean == entry.name:
                return entry
            self._assert_free(self.materials_dir, clean, allow=entry.path.name)
            target = self.materials_dir / clean
            if name_key(clean) == name_key(entry.name):
                os.rename(entry.path, target)  # same entry, only case/normalisation changes
                fsync_dir(self.materials_dir)
            else:
                self._publish(entry.path, target)
            return FolderEntry(entry.id, clean, entry.system, entry.created_at, target)

    def delete_folder(self, folder_id: str) -> None:
        if folder_id == INBOX_ID:
            raise ProtectedItem("Inbox can't be deleted.")
        with self._lock:
            entry = self.folder(folder_id)
            if [name for name in visible_entries(entry.path) if name != SERVICE_DIR]:
                raise FolderNotEmpty()
            area = self.root / STAGING_PATH
            area.mkdir(parents=True, exist_ok=True)
            doomed = area / f"delete-{uuid4().hex}"
            os.rename(entry.path, doomed)
            fsync_dir(self.materials_dir)
            shutil.rmtree(doomed, ignore_errors=True)

    # -- materials ----------------------------------------------------------

    def create_material(
        self, folder_id: str, title: str, kind: MaterialKind, fragments: Sequence[FragmentInput], *,
        status: MaterialStatus = "ready", origin: Origin | None = None, languages: Sequence[str] = (),
    ) -> MaterialFiles:
        clean = validate_name(title)
        numbered = number_fragments([], fragments)
        with self._lock:
            folder = self.folder(folder_id)
            manifest = MaterialManifest(
                id=new_id("mat"), kind=kind, status=status, title=clean, folder=folder.id, origin=origin,
                languages=list(languages), fragments=[FragmentMeta.of(item) for item in numbered],
                created_at=utc_now(),
            )
            self._assert_free(folder.path, clean)
            target = folder.path / clean
            with self._staging() as staging:
                write_atomic(staging / f"{clean}.md", render_source(manifest.id, kind, numbered).encode())
                (staging / SERVICE_DIR).mkdir()
                write_atomic(staging / MATERIAL_MANIFEST, dump_json(manifest.model_dump()))
                self._publish(staging, target)
            return MaterialFiles(manifest, clean, folder.id, target, target / f"{clean}.md", numbered)

    def material_directories(self) -> Iterator[tuple[FolderEntry, Path]]:
        for folder in self.folders():
            for name in sorted(os.listdir(folder.path)):
                path = folder.path / name
                if not name.startswith(".") and (path / MATERIAL_MANIFEST).is_file():
                    yield folder, path

    def _find_material(self, material_id: str, hint: str | None) -> tuple[str, Path]:
        if hint:
            candidate = self.root / hint
            with contextlib.suppress(OSError, ValueError):
                if read_json(candidate / MATERIAL_MANIFEST).get("id") == material_id:
                    return self._folder_of(candidate), candidate
        matches = []
        for folder, path in self.material_directories():
            with contextlib.suppress(OSError, ValueError, AttributeError):
                if read_json(path / MATERIAL_MANIFEST).get("id") == material_id:
                    matches.append((folder.id, path))
        if len(matches) != 1:
            raise NotFound("Material not found.")
        return matches[0]

    def _folder_of(self, material_dir: Path) -> str:
        marker = FolderMarker.model_validate(read_json(material_dir.parent / FOLDER_MARKER))
        return marker.id

    @staticmethod
    def source_file(directory: Path, manifest: MaterialManifest) -> Path:
        """``<dir name>.md``; after a Finder rename of the folder, the file keeps its old name."""
        for candidate in (directory / f"{directory.name}.md", directory / f"{manifest.title}.md"):
            if candidate.is_file():
                return candidate
        raise NotFound("The material's source file is missing.")

    def load_material(self, directory: Path, folder_id: str) -> MaterialFiles:
        """Read one material directory; ``ValueError`` if its manifest is not valid."""
        try:
            manifest = MaterialManifest.model_validate(read_json(directory / MATERIAL_MANIFEST))
        except (ValidationError, json.JSONDecodeError, UnicodeDecodeError) as error:
            raise ValueError("Unreadable material manifest.") from error
        source = self.source_file(directory, manifest)
        fragments = read_source(source.read_text(encoding="utf-8"), manifest.fragments)
        return MaterialFiles(manifest, directory.name, folder_id, directory, source, fragments)

    def read_material(self, material_id: str, *, hint: str | None = None) -> MaterialFiles:
        folder_id, directory = self._find_material(material_id, hint)
        return self.load_material(directory, folder_id)

    def append_fragments(self, material_id: str, fragments: Sequence[FragmentInput], *,
                         hint: str | None = None) -> list[Fragment]:
        """Add fragments after the existing ones; existing ``seg`` ids never change."""
        with self._lock:
            files = self.read_material(material_id, hint=hint)
            added = number_fragments(files.fragments, fragments, start=files.manifest.next_seg())
            text = render_source(files.manifest.id, files.manifest.kind, [*files.fragments, *added])
            # Markdown first: paragraphs not yet in the table are invisible to readers.
            write_atomic(files.source_path, text.encode())
            manifest = files.manifest.model_copy(update={
                "fragments": [*files.manifest.fragments, *(FragmentMeta.of(item) for item in added)],
                "folder": files.folder_id,
            })
            write_atomic(files.directory / MATERIAL_MANIFEST, dump_json(manifest.model_dump()))
            return added

    def set_material_status(self, material_id: str, status: MaterialStatus, *,
                            hint: str | None = None) -> None:
        with self._lock:
            _folder_id, directory = self._find_material(material_id, hint)
            manifest = MaterialManifest.model_validate(read_json(directory / MATERIAL_MANIFEST))
            updated = manifest.model_copy(update={"status": status})
            write_atomic(directory / MATERIAL_MANIFEST, dump_json(updated.model_dump()))

    # -- pages --------------------------------------------------------------

    def page_directory(self, kind: str) -> Path:
        return self.wiki_dir / WIKI_SUBDIRS[kind]

    def create_page(self, document: PageDocument) -> Path:
        """Publish a new page file named after its title; never replaces an existing file."""
        title = validate_name(document.meta.title)
        directory = self.page_directory(document.meta.kind)
        with self._lock:
            directory.mkdir(parents=True, exist_ok=True)
            self._assert_free(directory, f"{title}.md")
            path = directory / f"{title}.md"
            try:
                create_exclusive(path, render_page(document).encode("utf-8"))
            except FileExistsError as error:
                raise NameTaken() from error
            return path

    def rewrite_page(self, path: Path, expected: bytes, text: str) -> bool:
        """Replace a page only if it still holds ``expected``; a newer external edit wins."""
        with self._lock:
            if path.read_bytes() != expected:
                return False
            write_atomic(path, text.encode("utf-8"))
            return True
