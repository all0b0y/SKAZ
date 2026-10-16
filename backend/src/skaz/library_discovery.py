"""Read-only root/group discovery for the mandatory filesystem library.

This is deliberately not the session importer. A successful topology scan says
nothing about session validity and must never authorize clearing a session index.
All traversal is descriptor-relative and no-follow. Malformed group markers are
foreign; filesystem failures abort the entire scan instead of returning a prefix.
"""
from __future__ import annotations

import json
import os
import stat
from dataclasses import dataclass
from pathlib import Path
from typing import Literal
from uuid import UUID

from .session_files import _directory

_MAX_MARKER_BYTES = 16 * 1024


class LibraryUnavailable(ValueError):
    """The complete, identified library could not be read safely."""


@dataclass(frozen=True)
class RootIdentity:
    library_id: str
    device: int
    inode: int


@dataclass(frozen=True)
class LibraryGroup:
    id: str
    name: str
    relative_path: str


@dataclass(frozen=True)
class LibraryTopology:
    identity: RootIdentity
    groups: tuple[LibraryGroup, ...]
    ungrouped_path: str | None
    foreign_directories: int


@dataclass(frozen=True)
class LibraryPreview:
    root: Path
    action: Literal["create", "connect"]
    topology: LibraryTopology | None


def _stamp(info: os.stat_result) -> tuple[int, int, int, int, int]:
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns


def _object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate marker key.")
        result[key] = value
    return result


def _marker(directory: int, name: str, kind: Literal["library", "group"]) -> str | None:
    try:
        info = os.stat(name, dir_fd=directory, follow_symlinks=False)
    except FileNotFoundError:
        return None
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        return None
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    with os.fdopen(fd, "rb") as source:
        opened = os.fstat(source.fileno())
        if _stamp(info) != _stamp(opened) or not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1:
            raise LibraryUnavailable("Library changed while being read. Retry.")
        body = source.read(_MAX_MARKER_BYTES + 1)
        if _stamp(opened) != _stamp(os.fstat(source.fileno())):
            raise LibraryUnavailable("Library changed while being read. Retry.")
    if _stamp(info) != _stamp(os.stat(name, dir_fd=directory, follow_symlinks=False)):
        raise LibraryUnavailable("Library changed while being read. Retry.")
    if len(body) > _MAX_MARKER_BYTES:
        return None
    try:
        doc = json.loads(body.decode("utf-8"), object_pairs_hook=_object)
        if not isinstance(doc, dict) or set(doc) != {"format", "version", "id"}:
            return None
        if doc["format"] != f"skaz.{kind}" or type(doc["version"]) is not int or doc["version"] != 1:
            return None
        identity = doc["id"]
        if not isinstance(identity, str) or str(UUID(identity)) != identity:
            return None
        return identity
    except (UnicodeError, ValueError, RecursionError):
        return None


class LibraryDiscovery:
    """Produce an immutable topology only after a complete successful scan."""

    def preview(self, selected: Path) -> LibraryPreview:
        """Resolve a picker candidate without creating or repairing anything.

        This is for explicit selection only, NOT startup availability checking.
        Confirmation must revalidate; a preview is not a write capability.
        """
        try:
            return self._preview(selected)
        except OSError as error:
            raise LibraryUnavailable("Selected storage cannot be inspected safely.") from error

    def _preview(self, selected: Path) -> LibraryPreview:
        if not selected.is_absolute() or ".." in selected.parts:
            raise LibraryUnavailable("An absolute, non-traversing path is required.")
        try:
            with _directory(selected, create=False) as fd:
                # A present but invalid marker must not redirect into a new SKAZ.
                marker_present = "root.json" in os.listdir(fd)
        except FileNotFoundError:
            # Only a missing final component is a creation candidate. Failure to
            # traverse a parent (e.g. an unmounted drive) is not an empty library.
            with _directory(selected.parent, create=False):
                pass
            marker_present = False
        root = selected if selected.name.casefold() == "skaz" or marker_present else selected / "SKAZ"
        try:
            with _directory(root, create=False) as fd:
                marker_present = "root.json" in os.listdir(fd)
        except FileNotFoundError:
            return LibraryPreview(root, "create", None)
        if marker_present:
            return LibraryPreview(root, "connect", self.scan(root))
        return LibraryPreview(root, "create", None)

    def scan(self, root: Path, *, expected: RootIdentity | None = None) -> LibraryTopology:
        if not root.is_absolute() or ".." in root.parts:
            raise LibraryUnavailable("An absolute, non-traversing path is required.")
        try:
            return self._scan(root, expected)
        except OSError as error:
            raise LibraryUnavailable("Library is unavailable or changed while being read. Retry.") from error

    def _scan(self, root: Path, expected: RootIdentity | None) -> LibraryTopology:
        with _directory(root, create=False) as fd:
            before = os.fstat(fd)
            library_id = _marker(fd, "root.json", "library")
            if library_id is None:
                raise LibraryUnavailable("A valid root.json is required. No library was created.")
            identity = RootIdentity(library_id, before.st_dev, before.st_ino)
            if expected is not None and expected != identity:
                raise LibraryUnavailable("Library identity changed. Explicitly open the library again.")
            groups: list[LibraryGroup] = []
            observed: list[tuple[str, os.stat_result, str | None]] = []
            ids: set[str] = set()
            foreign = 0
            ungrouped: str | None = None
            for name in sorted(os.listdir(fd)):
                info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                if not stat.S_ISDIR(info.st_mode):
                    continue
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                try:
                    if _stamp(info) != _stamp(os.fstat(child)):
                        raise LibraryUnavailable("Library directory changed. Retry.")
                    group_id = None
                    if name == "Ungrouped":
                        ungrouped = name
                    else:
                        group_id = _marker(child, "group.json", "group")
                        if group_id is None:
                            foreign += 1
                        elif group_id in ids:
                            raise LibraryUnavailable("Duplicate group identity. No partial scan accepted.")
                        else:
                            ids.add(group_id)
                            groups.append(LibraryGroup(group_id, name, name))
                    observed.append((name, info, group_id))
                    if (_stamp(info) != _stamp(os.fstat(child))
                            or _stamp(info) != _stamp(os.stat(name, dir_fd=fd, follow_symlinks=False))):
                        raise LibraryUnavailable("Library directory changed. Retry.")
                finally:
                    os.close(child)
            # An in-place marker edit does not change its parent's directory
            # timestamps. Recheck previously visited children before returning.
            for name, info, group_id in observed:
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                try:
                    if _stamp(info) != _stamp(os.fstat(child)):
                        raise LibraryUnavailable("Library directory changed. Retry.")
                    if name != "Ungrouped" and _marker(child, "group.json", "group") != group_id:
                        raise LibraryUnavailable("Library group changed. Retry.")
                finally:
                    os.close(child)
            if _marker(fd, "root.json", "library") != library_id or _stamp(before) != _stamp(os.fstat(fd)):
                raise LibraryUnavailable("Library root changed. Retry.")
            # Detect root replacement even though our held descriptor stayed valid.
            with _directory(root, create=False) as current:
                if _stamp(before) != _stamp(os.fstat(current)):
                    raise LibraryUnavailable("Library root changed. Retry.")
            return LibraryTopology(identity, tuple(groups), ungrouped, foreign)
