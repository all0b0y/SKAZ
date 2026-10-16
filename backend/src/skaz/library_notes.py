"""Read registered notes without trusting paths, Markdown instructions or copies.

This component does not write session.json or SQLite. The caller must invalidate
stored note links when content_changed is true; no text matching is performed.
A result is not a complete library scan and cannot authorize index deletion.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import re
import stat
from dataclasses import dataclass
from pathlib import Path
from uuid import UUID

from .library_discovery import LibraryUnavailable, _object, _stamp
from .session_files import _directory

_MAX_NOTE_BYTES = 32 * 1024 * 1024
_MAX_HEADER_BYTES = 16 * 1024


def _identity(value: object) -> bool:
    if not isinstance(value, str):
        return False
    try:
        parsed = UUID(value)
        # Existing notes use uuid4().hex. Preserve it; never renumber on import.
        return value in (parsed.hex, str(parsed))
    except ValueError:
        return False


def _note_name(name: str) -> bool:
    return (bool(name) and name not in {".", ".."} and "/" not in name
            and "\\" not in name and "\0" not in name and name.casefold().endswith(".md")
            and name.casefold() != "transcript.md" and bool(name[:-3].strip()))


@dataclass(frozen=True)
class NoteRegistration:
    """Validated note registry entry, eventually owned by session.json."""

    id: str
    relative_path: str
    content_sha256: str

    def __post_init__(self) -> None:
        if not _identity(self.id):
            raise ValueError("Invalid registered note identity.")
        if not _note_name(self.relative_path):
            raise ValueError("A direct Markdown filename is required.")
        if re.fullmatch(r"[0-9a-f]{64}", self.content_sha256) is None:
            raise ValueError("Invalid registered note content digest.")


@dataclass(frozen=True)
class DiscoveredNote:
    id: str
    relative_path: str
    title: str
    content: str
    content_sha256: str
    file_sha256: str
    content_changed: bool


@dataclass(frozen=True)
class NotesSnapshot:
    notes: tuple[DiscoveredNote, ...]
    # Missing, invalid or ambiguous. Not an instruction to delete any files.
    unconnected_ids: tuple[str, ...]


def _decode(raw: bytes, registered_ids: set[str]) -> tuple[str, str] | None:
    # JSON is a strict YAML subset. No YAML tags, aliases, implicit scalar types
    # or executable deserializers are accepted in the version-1 frontmatter.
    source = io.BytesIO(raw)
    if source.readline(6).rstrip(b"\r\n") != b"---":
        return None
    header = bytearray()
    while line := source.readline(_MAX_HEADER_BYTES + 1):
        if line.rstrip(b"\r\n") == b"---":
            break
        header.extend(line)
        if len(header) > _MAX_HEADER_BYTES:
            return None
    else:
        return None
    offset = source.tell()
    try:
        doc = json.loads(header.decode("utf-8"), object_pairs_hook=_object)
        if (not isinstance(doc, dict) or set(doc) != {"format", "version", "id"}
                or doc["format"] != "skaz.note" or type(doc["version"]) is not int
                or doc["version"] != 1 or not _identity(doc["id"])):
            return None
    except (ValueError, UnicodeError, RecursionError):
        return None
    if doc["id"] not in registered_ids:
        return None
    try:
        return doc["id"], raw[offset:].decode("utf-8")
    except UnicodeError as error:
        raise LibraryUnavailable("Registered note is not valid UTF-8. No partial scan accepted.") from error


def _read(directory: int, name: str, info: os.stat_result) -> bytes:
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    with os.fdopen(fd, "rb") as source:
        opened = os.fstat(source.fileno())
        if (_stamp(opened) != _stamp(info) or not stat.S_ISREG(opened.st_mode)
                or opened.st_nlink != 1):
            raise LibraryUnavailable("Note changed while being read. Retry.")
        raw = source.read(_MAX_NOTE_BYTES + 1)
        if len(raw) > _MAX_NOTE_BYTES:
            raise LibraryUnavailable("Markdown exceeds the safe read limit. No partial scan accepted.")
        if _stamp(opened) != _stamp(os.fstat(source.fileno())):
            raise LibraryUnavailable("Note changed while being read. Retry.")
    return raw


class RegisteredNotes:
    """All-or-error, read-only note resolution in one existing session directory."""

    def scan(self, directory: Path, registrations: tuple[NoteRegistration, ...]) -> NotesSnapshot:
        if not directory.is_absolute() or ".." in directory.parts:
            raise LibraryUnavailable("An absolute, non-traversing session path is required.")
        if len({r.id for r in registrations}) != len(registrations):
            raise ValueError("Duplicate note registration identity.")
        if len({r.relative_path for r in registrations}) != len(registrations):
            raise ValueError("Duplicate registered note path.")
        try:
            return self._scan(directory, registrations)
        except OSError as error:
            raise LibraryUnavailable("Session notes are unavailable or changed. Retry.") from error

    def _scan(self, directory: Path, registrations: tuple[NoteRegistration, ...]) -> NotesSnapshot:
        registry = {r.id: r for r in registrations}
        registered_ids = set(registry)
        candidates: dict[str, list[DiscoveredNote]] = {r.id: [] for r in registrations}
        with _directory(directory, create=False) as fd:
            before = os.fstat(fd)
            observed: list[tuple[str, os.stat_result]] = []
            for name in sorted(os.listdir(fd)):
                if not _note_name(name):
                    continue
                info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                observed.append((name, info))
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                    continue
                raw = _read(fd, name, info)
                decoded = _decode(raw, registered_ids)
                if decoded is None:
                    continue
                identity, content = decoded
                digest = hashlib.sha256(content.encode("utf-8")).hexdigest()
                candidates[identity].append(DiscoveredNote(
                    identity, name, name[:-3], content, digest, hashlib.sha256(raw).hexdigest(),
                    digest != registry[identity].content_sha256,
                ))
            # File edits need their own stamps: an in-place write does not change
            # directory timestamps. Include ignored duplicates and malformed MD.
            for name, info in observed:
                current = os.stat(name, dir_fd=fd, follow_symlinks=False)
                if _stamp(info) != _stamp(current):
                    raise LibraryUnavailable("Session notes changed during scan. Retry.")
            if _stamp(before) != _stamp(os.fstat(fd)):
                raise LibraryUnavailable("Session directory changed during scan. Retry.")
            with _directory(directory, create=False) as current_fd:
                if _stamp(before) != _stamp(os.fstat(current_fd)):
                    raise LibraryUnavailable("Session directory was replaced. Retry.")
        notes: list[DiscoveredNote] = []
        missing: list[str] = []
        for registration in registrations:
            matches = candidates[registration.id]
            preferred = next((n for n in matches if n.relative_path == registration.relative_path), None)
            chosen = preferred or (matches[0] if len(matches) == 1 else None)
            if chosen is None:
                missing.append(registration.id)
            else:
                notes.append(chosen)
        return NotesSnapshot(tuple(notes), tuple(missing))
