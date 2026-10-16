"""Folder, material and page files of one library root.

All mutations take the library lock, check the name against every entry of
the target directory (unknown files included) by ``name_key``, build the new
object in ``<root>/.skaz/staging`` and publish it with one exclusive rename. A
refused name therefore leaves nothing behind, and a name taken by another
process between the check and the publish is refused by the kernel.
"""
from __future__ import annotations

import contextlib
import json
import os
import shutil
import threading
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any
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
from ..ids import new_id, utc_now, utc_now_ms
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
    render_appendix,
    render_source,
)
from ..markdown.text import name_key
from .fsio import (
    create_exclusive,
    dump_json,
    dump_json_rows,
    entry_kind,
    fsync_dir,
    read_json,
    rename_exclusive,
    visible_entries,
    write_atomic,
)
from .layout import (
    DEFAULT_NAME,
    FALLBACK_NAME,
    FOLDER_MARKER,
    LEGACY_STAGING_PATH,
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
#: ``material.json`` extra: byte length of the source Markdown as SKAZ last wrote it.
SOURCE_SIZE_KEY = "source_size"


def _with_extra(manifest: MaterialManifest, extra: Mapping[str, Any]) -> MaterialManifest:
    """Service keys beside the manifest fields; they can never overwrite a field."""
    clash = set(extra) & set(MaterialManifest.model_fields)
    if clash:
        raise ValueError(f"Manifest extras cannot replace fields: {sorted(clash)}")
    return manifest.model_copy(update=dict(extra))


def _append_durably(path: Path, data: bytes) -> None:
    """Append and fsync. A torn append changes the size, which the next append detects."""
    descriptor = os.open(path, os.O_WRONLY | os.O_APPEND)
    try:
        view = memoryview(data)
        while view:
            written = os.write(descriptor, view)
            view = view[written:]
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


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
                # Name what is in the way: the chosen folder itself may be fine (QA A9).
                raise LibraryConflict(
                    f"The “{root.name}” folder here already has other files. Choose another folder."
                    if root.name in (DEFAULT_NAME, FALLBACK_NAME)
                    else "This folder already has other files. Choose another folder.")
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
        shutil.rmtree(self.root / LEGACY_STAGING_PATH, ignore_errors=True)

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
        """Folders with a valid marker; anything else under Materials is not ours and is skipped."""
        return self.read_folders()[0]

    def read_folders(self) -> tuple[list[FolderEntry], list[Path]]:
        """Folders with a valid marker, and the entries of ``Materials/`` that could not be read.

        An entry that can't be read (an iCloud placeholder still downloading answers
        ``EDEADLK``, a folder without permission ``EACCES``) is left out and returned in the
        second list, so one such folder never makes the whole library unusable; the scan keeps
        what it indexed there before. ``OSError`` on ``Materials/`` itself propagates: an
        unreadable library is not an empty one.
        """
        found: list[FolderEntry] = []
        unreadable: list[Path] = []
        for name in sorted(os.listdir(self.materials_dir)):
            path = self.materials_dir / name
            if name.startswith("."):
                continue
            try:
                if entry_kind(path) != "dir":
                    continue
                marker = FolderMarker.model_validate(read_json(path / FOLDER_MARKER))
            except (FileNotFoundError, NotADirectoryError, ValueError, UnicodeDecodeError):
                continue
            except OSError:
                unreadable.append(path)
                continue
            found.append(FolderEntry(marker.id, name, marker.system, marker.created_at, path))
        found.sort(key=lambda entry: (entry.id != INBOX_ID, name_key(entry.name)))
        return found, unreadable

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
                created_at=utc_now_ms(),
            )
            source = render_source(manifest.id, kind, numbered).encode()
            manifest = _with_extra(manifest, {SOURCE_SIZE_KEY: len(source)})
            self._assert_free(folder.path, clean)
            target = folder.path / clean
            with self._staging() as staging:
                write_atomic(staging / f"{clean}.md", source)
                (staging / SERVICE_DIR).mkdir()
                write_atomic(staging / MATERIAL_MANIFEST, dump_json(manifest.model_dump()))
                self._publish(staging, target)
            return MaterialFiles(manifest, clean, folder.id, target, target / f"{clean}.md", numbered)

    def material_directories(self) -> Iterator[tuple[FolderEntry, Path]]:
        """Material directories of the readable folders; an entry that can't be read is skipped."""
        for folder in self.folders():
            try:
                names = sorted(os.listdir(folder.path))
            except OSError:
                continue
            for name in names:
                path = folder.path / name
                try:
                    is_material = not name.startswith(".") and entry_kind(path / MATERIAL_MANIFEST) == "file"
                except OSError:
                    continue
                if is_material:
                    yield folder, path

    def _find_material(self, material_id: str, hint: str | None) -> tuple[str, Path]:
        folder_id, directory, _raw = self._locate(material_id, hint)
        return folder_id, directory

    def _locate(self, material_id: str, hint: str | None) -> tuple[str, Path, dict[str, Any]]:
        """Folder id, directory and the raw manifest of a material (read once)."""
        if hint:
            candidate = self.root / hint
            with contextlib.suppress(OSError, ValueError):
                raw = read_json(candidate / MATERIAL_MANIFEST)
                if isinstance(raw, dict) and raw.get("id") == material_id:
                    return self._folder_of(candidate), candidate, raw
        matches = []
        for folder, path in self.material_directories():
            with contextlib.suppress(OSError, ValueError, AttributeError):
                raw = read_json(path / MATERIAL_MANIFEST)
                if raw.get("id") == material_id:
                    matches.append((folder.id, path, raw))
        if len(matches) != 1:
            raise NotFound("Material not found.")
        return matches[0]

    def locate_material(self, material_id: str, *, hint: str | None = None) -> Path:
        """The material's directory (its ``.skaz/`` holds the service files)."""
        return self._find_material(material_id, hint)[1]

    def material_manifest(self, material_id: str, *, hint: str | None = None) -> MaterialManifest:
        """Only ``material.json``: no Markdown is read (cheap for a long recording)."""
        _folder_id, _directory, raw = self._locate(material_id, hint)
        try:
            return MaterialManifest.model_validate(raw)
        except ValidationError as error:
            raise ValueError("Unreadable material manifest.") from error

    def manifest_value(self, material_id: str, key: str, *, hint: str | None = None) -> Any:
        """One top-level value of ``material.json`` (e.g. an area's extra), unvalidated."""
        return self._locate(material_id, hint)[2].get(key)

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
                         hint: str | None = None,
                         manifest_extra: Mapping[str, Any] | None = None) -> list[Fragment]:
        """Add fragments after the existing ones; existing ``seg`` ids never change.

        Cost is proportional to the new fragments plus one ``material.json``
        write: when the Markdown is byte-for-byte what SKAZ last wrote
        (``source_size`` in the manifest), the new paragraphs are appended;
        otherwise (an external edit, a torn append after a crash) the file is
        re-rendered from the fragment table as before. ``manifest_extra`` is
        stored in the same manifest write, so a caller's progress marker
        commits together with the fragments it describes.
        """
        with self._lock:
            folder_id, directory, raw = self._locate(material_id, hint)
            try:
                manifest = MaterialManifest.model_validate(raw)
            except ValidationError as error:
                raise ValueError("Unreadable material manifest.") from error
            source = self.source_file(directory, manifest)
            added = number_fragments((), fragments, start=manifest.next_seg())
            recorded = (manifest.model_extra or {}).get(SOURCE_SIZE_KEY)
            size = source.stat().st_size
            # Markdown first: paragraphs not yet in the table are invisible to readers.
            if isinstance(recorded, int) and recorded == size:
                appendix = render_appendix(added, after_existing=bool(manifest.fragments)).encode()
                if appendix:
                    _append_durably(source, appendix)
                new_size = size + len(appendix)
            else:
                existing = read_source(source.read_text(encoding="utf-8"), manifest.fragments)
                text = render_source(manifest.id, manifest.kind, [*existing, *added]).encode()
                write_atomic(source, text)
                new_size = len(text)
            updated = manifest.model_copy(update={
                "fragments": [*manifest.fragments, *(FragmentMeta.of(item) for item in added)],
                "folder": folder_id,
            })
            updated = _with_extra(updated, {**(manifest_extra or {}), SOURCE_SIZE_KEY: new_size})
            write_atomic(directory / MATERIAL_MANIFEST, dump_json_rows(updated.model_dump()))
            return added

    def set_material_status(self, material_id: str, status: MaterialStatus, *,
                            hint: str | None = None) -> None:
        with self._lock:
            _folder_id, directory = self._find_material(material_id, hint)
            manifest = MaterialManifest.model_validate(read_json(directory / MATERIAL_MANIFEST))
            updated = manifest.model_copy(update={"status": status})
            write_atomic(directory / MATERIAL_MANIFEST, dump_json(updated.model_dump()))

    def move_material(self, material_id: str, *, title: str | None = None, folder_id: str | None = None,
                      hint: str | None = None) -> MaterialFiles:
        """Rename and/or move a material (W2): directory, source file and manifest, or nothing at all.

        A name taken in the target folder is refused (FILESYSTEM-LIBRARY-SPEC
        14–15, 34). The directory moves with one exclusive rename; when the
        source file rename or the manifest write fails, the directory and file
        are put back, so no half-renamed material is left.
        """
        with self._lock:
            current_folder, directory, raw = self._locate(material_id, hint)
            try:
                manifest = MaterialManifest.model_validate(raw)
            except ValidationError as error:
                raise ValueError("Unreadable material manifest.") from error
            clean = validate_name(title) if title is not None else directory.name
            folder = self.folder(folder_id or current_folder)
            target = folder.path / clean
            if target == directory and clean == manifest.title:
                return self.load_material(directory, folder.id)
            same_entry = folder.path == directory.parent and name_key(clean) == name_key(directory.name)
            if not same_entry:
                self._assert_free(folder.path, clean)
            source = self.source_file(directory, manifest)
            if same_entry:
                os.rename(directory, target)  # only case/normalisation changes
            else:
                self._publish(directory, target)
            fsync_dir(directory.parent)
            moved_source = target / source.name
            new_source = target / f"{clean}.md"
            renamed = False
            try:
                if moved_source.name != new_source.name:
                    if name_key(moved_source.name) == name_key(new_source.name):
                        os.rename(moved_source, new_source)
                    else:
                        rename_exclusive(moved_source, new_source)
                    renamed = True
                updated = manifest.model_copy(update={"title": clean, "folder": folder.id})
                write_atomic(target / MATERIAL_MANIFEST, dump_json_rows(updated.model_dump()))
            except BaseException:
                if renamed:
                    os.rename(new_source, moved_source)
                os.rename(target, directory)
                fsync_dir(directory.parent)
                raise
            return self.load_material(target, folder.id)

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

    def rename_page(self, path: Path, title: str) -> Path:
        """Give a page file a new human name in its folder (W2); a taken name is refused, never replaced."""
        clean = validate_name(title)
        with self._lock:
            target = path.with_name(f"{clean}.md")
            if target.name == path.name:
                return path
            if name_key(target.name) == name_key(path.name):
                os.rename(path, target)
            else:
                self._assert_free(path.parent, target.name)
                try:
                    rename_exclusive(path, target)
                except FileExistsError as error:
                    raise NameTaken() from error
            fsync_dir(path.parent)
            return target
