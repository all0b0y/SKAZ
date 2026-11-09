"""One-off move of saved decks and tests out of the wiki (0.4.0 N4-7, plan decision 3a+).

``Wiki/Decks`` and ``Wiki/Tests`` become ``Study/Decks`` and ``Study/Tests``. It runs when a library is
opened, before the scan; the user's real library is what it runs on, so:

* **Nothing is half-moved.** Before the first move a journal (``.skaz/study-migration.json``,
  ``moving``) lists every move. Any error undoes all of them and the index rows; a process killed
  midway is undone from the journal at the next start, then the move runs again.
* **A backup stays.** ``.skaz/backups/study-migration-<time>/`` holds a copy of each file as it was and
  of ``Wiki/index.md``, with ``manifest.json`` and ``RESTORE.txt``. It is published in one rename, only
  complete, before anything moves. SKAZ never deletes a backup of a finished move; only the copy of an
  attempt whose every file was verified back in place goes.
* **Files keep their bytes.** A page moves by a rename, so its links, ids and hashes stay as they were;
  FSRS progress, attempts and marks are keyed by page and block id and don't change.
* **Only saved decks and tests move:** files with a ``deck``/``test`` frontmatter. A file SKAZ doesn't
  know stays where it is (FILESYSTEM-LIBRARY-SPEC 2), and its folder stays with it. A name taken in
  ``Study`` is never replaced: the file gets the next free name, as Finder numbers a copy.

A failure never blocks the library: the scanner still reads the old folders (``PAGE_FOLDERS``), so the
pages stay usable and out of every wiki search (those go by kind), and the next start tries again.
Errors carry the system's reason only, never a title or page text.
"""

from __future__ import annotations

import contextlib
import hashlib
import os
import shutil
import sqlite3
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, cast
from uuid import uuid4

from ..ids import utc_now
from ..library.fsio import (
    IGNORABLE_ENTRIES,
    dump_json,
    entry_kind,
    fsync_dir,
    read_json,
    rename_exclusive,
    write_atomic,
)
from ..library.layout import (
    LEGACY_STUDY_FOLDERS,
    SERVICE_DIR,
    STAGING_PATH,
    STUDY_DIR,
    STUDY_KINDS,
    STUDY_SUBDIRS,
    WIKI_DIR,
)
from ..library.library import Library
from ..library.names import numbered_name
from ..markdown.page import PageFormatError, parse_page
from ..markdown.text import name_key
from ..store.database import KnowledgeDatabase

#: The journal: ``moving`` while files move, ``done`` for good. Lives with the library it describes.
MARKER = Path(SERVICE_DIR) / "study-migration.json"
BACKUPS = Path(SERVICE_DIR) / "backups"
BACKUP_PREFIX = "study-migration-"
_FAILURES = (OSError, ValueError, UnicodeDecodeError, sqlite3.Error)

RESTORE_TEXT = """\
On {when} SKAZ moved your saved decks and tests from Wiki/Decks and Wiki/Tests to Study/Decks and
Study/Tests. This folder holds a copy of every moved file as it was, under its old path, and of
Wiki/index.md. manifest.json lists each move ("from", "to") and the file's sha256.

To put them back by hand:
1. Quit SKAZ.
2. Delete the moved files listed under "to" in manifest.json from the library's Study folder. Do this
   after looking at them: progress is kept by SKAZ separately, but changes you made to a file since
   the move are only in the Study folder.
3. Copy the Wiki/Decks and Wiki/Tests folders from here into the library's Wiki folder.
4. Keep .skaz/study-migration.json if you stay on this version of SKAZ: it still reads the old folders
   and won't move them again. Delete that file if you want SKAZ to move them again at its next start.

Earlier versions of SKAZ read only the old folders, so this is also the way back to one of them.
SKAZ never deletes this backup; delete this folder yourself when you no longer need it.
"""


@dataclass(frozen=True)
class Move:
    source: str
    target: str
    sha256: str


@dataclass(frozen=True)
class MigrationOutcome:
    status: Literal["nothing", "already", "moved", "failed"]
    moved: int = 0
    #: Library-relative path of the backup of a finished move (or of one kept after a failed undo).
    backup: str | None = None
    #: The system's words for what went wrong (no titles, no page text).
    reason: str | None = None
    #: The undo itself failed: the journal and the backup stay, the next start finishes the undo.
    stuck: bool = False


def _reason(error: BaseException) -> str:
    if isinstance(error, OSError) and error.strerror:
        return error.strerror
    return type(error).__name__


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# -- the journal ----------------------------------------------------------------------------------


def _read_journal(root: Path) -> dict[str, Any] | None:
    try:
        data = read_json(root / MARKER)
    except FileNotFoundError:
        return None
    if not isinstance(data, dict) or data.get("status") not in ("moving", "done"):
        raise ValueError("The study migration journal is damaged.")
    return cast(dict[str, Any], data)


def _write_journal(root: Path, journal: dict[str, Any]) -> None:
    write_atomic(root / MARKER, dump_json(journal))


def _moves_of(journal: dict[str, Any]) -> list[Move]:
    return [Move(item["from"], item["to"], item["sha256"]) for item in journal.get("moves") or []]


def _move_rows(moves: Sequence[Move]) -> list[dict[str, str]]:
    return [{"from": move.source, "to": move.target, "sha256": move.sha256} for move in moves]


# -- planning -------------------------------------------------------------------------------------


def _taken_names(directory: Path) -> set[str]:
    return {name_key(name) for name in os.listdir(directory)} if directory.is_dir() else set()


def _plan(root: Path) -> list[Move]:
    """What moves, read before anything changes: an unreadable page stops it here (``OSError``)."""
    moves: list[Move] = []
    taken: dict[str, set[str]] = {}
    for folder in LEGACY_STUDY_FOLDERS:
        directory = root / folder
        if entry_kind(directory) != "dir":
            continue
        for name in sorted(os.listdir(directory)):
            path = directory / name
            if name.startswith(".") or not name.endswith(".md") or entry_kind(path) != "file":
                continue
            data = path.read_bytes()
            try:
                kind = parse_page(data.decode("utf-8")).meta.kind
            except (PageFormatError, UnicodeDecodeError):
                continue  # not a SKAZ page: neither shown nor touched
            if kind not in STUDY_KINDS:
                continue
            target_folder = f"{STUDY_DIR}/{STUDY_SUBDIRS[kind]}"
            names = taken.setdefault(target_folder, _taken_names(root / target_folder))
            stem, number = name.removesuffix(".md"), 1
            while name_key(f"{numbered_name(stem, number)}.md") in names:
                number += 1
            free = f"{numbered_name(stem, number)}.md"
            names.add(name_key(free))
            moves.append(Move(f"{folder}/{name}", f"{target_folder}/{free}", _sha(data)))
    return moves


# -- the backup -----------------------------------------------------------------------------------


def _write_backup(root: Path, moves: Sequence[Move], when: str) -> str:
    """A complete copy under ``.skaz/backups``, published in one rename; its library-relative path."""
    staging = root / STAGING_PATH / f"study-backup-{uuid4().hex}"
    try:
        for move in moves:
            data = (root / move.source).read_bytes()
            if _sha(data) != move.sha256:
                raise OSError(5, "A page changed while SKAZ was copying it.")
            copy = staging / move.source
            copy.parent.mkdir(parents=True, exist_ok=True)
            write_atomic(copy, data)
            if _sha(copy.read_bytes()) != move.sha256:
                raise OSError(5, "The backup copy doesn't match the page.")
        index = root / WIKI_DIR / "index.md"
        if entry_kind(index) == "file":
            (staging / WIKI_DIR).mkdir(parents=True, exist_ok=True)
            write_atomic(staging / WIKI_DIR / "index.md", index.read_bytes())
        write_atomic(staging / "manifest.json", dump_json({"format": 1, "created_at": when,
                                                           "moves": _move_rows(moves)}))
        write_atomic(staging / "RESTORE.txt", RESTORE_TEXT.format(when=when).encode("utf-8"))
        folder = root / BACKUPS
        folder.mkdir(parents=True, exist_ok=True)
        stamp = when.replace(":", "").replace("-", "")
        target = folder / f"{BACKUP_PREFIX}{stamp}"
        if target.exists():
            target = folder / f"{BACKUP_PREFIX}{stamp}-{uuid4().hex[:6]}"
        rename_exclusive(staging, target)
        fsync_dir(folder)
        return target.relative_to(root).as_posix()
    finally:
        shutil.rmtree(staging, ignore_errors=True)


# -- moving and undoing ---------------------------------------------------------------------------


def _point_index(db: KnowledgeDatabase, moves: Sequence[Move]) -> None:
    """The index rows follow the files in one transaction (ids don't change)."""
    with db.write() as connection:
        for item in moves:
            # A row at the target has no file there (the plan chose a free name): only in this
            # direction, the undo may run before this ever did and must not drop the rows it finds.
            connection.execute("DELETE FROM pages WHERE rel_path = ?", (item.target,))
            connection.execute("UPDATE pages SET rel_path = ? WHERE rel_path = ?", (item.target, item.source))


def _unpoint_index(db: KnowledgeDatabase, moves: Sequence[Move]) -> None:
    with db.write() as connection:
        for item in moves:
            connection.execute("UPDATE pages SET rel_path = ? WHERE rel_path = ?", (item.source, item.target))


def _make_folders(root: Path, moves: Sequence[Move]) -> list[str]:
    """Create the target folders; the ones this run created, deepest first (the undo removes them)."""
    created: list[str] = []
    for folder in sorted({str(Path(move.target).parent) for move in moves}):
        path = root / folder
        for level in [*reversed(path.relative_to(root).parents), path.relative_to(root)]:
            if str(level) == "." or (root / level).exists():
                continue
            (root / level).mkdir()
            created.append(level.as_posix())
    return list(reversed(created))


def _remove_if_empty(path: Path) -> None:
    """Remove a folder holding nothing but what Finder leaves; a folder with anything else stays."""
    try:
        names = os.listdir(path)
        if set(names) <= IGNORABLE_ENTRIES:
            for name in names:
                (path / name).unlink()
            path.rmdir()
    except OSError:
        return  # an empty old folder left behind harms nothing


def _apply(root: Path, db: KnowledgeDatabase, moves: Sequence[Move],
           move: Callable[[Path, Path], None]) -> None:
    for item in moves:
        move(root / item.source, root / item.target)
    for item in moves:
        if _sha((root / item.target).read_bytes()) != item.sha256:
            raise OSError(5, "A page changed while SKAZ was moving it.")
    for folder in {str(Path(item.source).parent) for item in moves} | {str(Path(item.target).parent)
                                                                       for item in moves}:
        fsync_dir(root / folder)
    _point_index(db, moves)


def _undo_moves(root: Path, moves: Sequence[Move], backup: str | None) -> bool:
    """Every file back at its old path; ``True`` when each one is verifiably what it was."""
    intact = True
    for item in reversed(moves):
        source, target = root / item.source, root / item.target
        source.parent.mkdir(parents=True, exist_ok=True)
        if target.exists() and not source.exists():
            rename_exclusive(target, source)
        elif not source.exists():
            if backup is None:
                raise OSError(2, "A moved page and its backup copy are both missing.")
            write_atomic(source, (root / backup / item.source).read_bytes())
        if _sha(source.read_bytes()) != item.sha256:
            intact = False  # edited since the move: it is kept as it is now, and so is the backup
    for folder in {str(Path(item.source).parent) for item in moves}:
        fsync_dir(root / folder)
    return intact


def _undo(root: Path, db: KnowledgeDatabase, journal: dict[str, Any]) -> None:
    moves = _moves_of(journal)
    backup = journal.get("backup")
    intact = _undo_moves(root, moves, backup)
    _unpoint_index(db, moves)
    for folder in journal.get("created") or []:
        _remove_if_empty(root / folder)
    (root / MARKER).unlink(missing_ok=True)
    if intact and backup:
        with contextlib.suppress(OSError):
            shutil.rmtree(root / backup)


# -- the migration --------------------------------------------------------------------------------


def migrate_study(library: Library, db: KnowledgeDatabase, *,
                  move: Callable[[Path, Path], None] | None = None) -> MigrationOutcome:
    """Move saved decks and tests to ``Study/`` (see the module note). Call under the library's write lock.

    Never raises for a failure of the library or the database: ``status="failed"``, everything back.
    ``move`` is the test seam for one file's move.
    """
    root = library.root
    mover = move or rename_exclusive
    try:
        journal = _read_journal(root)
        if journal is not None and journal["status"] == "done":
            return MigrationOutcome("already", backup=journal.get("backup"))
        if journal is not None:  # a process killed midway: undo first, then the move runs from the start
            _undo(root, db, journal)
    except _FAILURES as error:
        return MigrationOutcome("failed", reason=_reason(error), stuck=True)

    backup: str | None = None
    try:
        moves = _plan(root)
        if not moves:
            return MigrationOutcome("nothing")
        when = utc_now()
        backup = _write_backup(root, moves, when)
    except _FAILURES as error:
        return MigrationOutcome("failed", reason=_reason(error))

    journal = {"format": 1, "status": "moving", "started_at": when, "backup": backup,
               "moves": _move_rows(moves), "created": []}
    try:
        _write_journal(root, journal)
        journal["created"] = _make_folders(root, moves)
        _write_journal(root, journal)
        _apply(root, db, moves, mover)
        for folder in sorted({str(Path(item.source).parent) for item in moves}):
            _remove_if_empty(root / folder)
        _write_journal(root, {**journal, "status": "done", "finished_at": utc_now(), "created": []})
    except _FAILURES as error:
        reason = _reason(error)
        try:
            _undo(root, db, journal)
        except _FAILURES:
            return MigrationOutcome("failed", backup=backup, reason=reason, stuck=True)
        return MigrationOutcome("failed", reason=reason)
    return MigrationOutcome("moved", moved=len(moves), backup=backup)

