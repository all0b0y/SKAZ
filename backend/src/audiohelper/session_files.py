"""One-way Markdown projection. Failure never discards primary session data.

This slice is explicitly enabled with a root; navigation groups and audio layout
are not yet connected. Paths use application IDs, never transcript
text or titles. Directory descriptors prevent following replaced parent links.
"""
from __future__ import annotations

import ctypes
import hashlib
import html
import json
import os
import re
import stat
import sys
import threading
from collections.abc import Iterator
from contextlib import contextmanager, suppress
from pathlib import Path
from typing import TYPE_CHECKING, Any
from uuid import uuid4

from . import note_store
from . import repository as repo
from .db import Database
from .schemas import Note
from .storage_root import RootChangeBlocked, StorageRootView, has_output, load_root, validate_root

if TYPE_CHECKING:
    from .managed_storage import ManagedStorage


@contextmanager
def _directory(path: Path, *, create: bool = True) -> Iterator[int]:
    if not path.is_absolute() or ".." in path.parts:
        raise ValueError("An absolute, non-traversing root is required.")
    descriptor = os.open(path.anchor, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in path.parts[1:]:
            if create:
                try:
                    os.mkdir(part, mode=0o700, dir_fd=descriptor)
                    os.fsync(descriptor)
                except FileExistsError:
                    pass
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        yield descriptor
    finally:
        os.close(descriptor)


def _digest_at(directory: int, name: str) -> str | None:
    try:
        descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    except FileNotFoundError:
        return None
    with os.fdopen(descriptor, "rb") as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise ValueError("Only regular, non-linked files can be projected.")
        # A large external replacement is a conflict, not unbounded read work.
        if info.st_size > 32 * 1024 * 1024:
            return "external-oversized-file"
        digest = hashlib.sha256()
        while block := source.read(64 * 1024):
            digest.update(block)
        return digest.hexdigest()


def _conflict_name(directory: int, name: str, digest: str) -> str:
    candidate = f"{Path(name).stem}.conflict-{digest}.md"
    existing = _digest_at(directory, candidate)
    if existing is not None and existing != digest:
        return f"{Path(name).stem}.conflict-{uuid4().hex}.md"
    return candidate


def _rename_at(directory: int, source: str, destination: str, *, exchange: bool) -> None:
    rename_between(directory, source, directory, destination, exchange=exchange)


def rename_between(source_fd: int, source: str, target_fd: int, destination: str,
                   *, exchange: bool = False) -> None:
    # There is no portable compare-and-swap rename. Exchange keeps a last-instant
    # external replacement alive so it can be checked AFTER atomic publication.
    library = ctypes.CDLL(None, use_errno=True)
    if sys.platform == "darwin":
        function = getattr(library, "renameatx_np", None)
        flags = 2 if exchange else 4  # RENAME_SWAP / RENAME_EXCL
    elif sys.platform == "linux":
        function = getattr(library, "renameat2", None)
        flags = 2 if exchange else 1  # RENAME_EXCHANGE / RENAME_NOREPLACE
    else:
        function = None
        flags = 0
    if function is None:
        raise OSError("Atomic exchange is unavailable on this platform.")
    function.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    function.restype = ctypes.c_int
    if function(source_fd, os.fsencode(source), target_fd, os.fsencode(destination), flags) != 0:
        raise OSError(ctypes.get_errno(), "Atomic file publication failed.")


def _publish(directory: int, name: str, body: bytes, expected: str | None) -> tuple[str, str]:
    """Publish complete bytes; changed/unknown files remain at their original name."""
    digest = hashlib.sha256(body).hexdigest()
    current = _digest_at(directory, name)
    if current == digest and expected == digest:
        return name, "unchanged"
    conflict = current is not None and current != expected
    destination = _conflict_name(directory, name, digest) if conflict else name
    if conflict and _digest_at(directory, destination) == digest:
        return destination, "conflict"
    temporary = f"{Path(name).stem}.recovery-{uuid4().hex}.md"
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                         0o600, dir_fd=directory)
    owns_temporary = True
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(body)
            output.flush()
            os.fsync(output.fileno())
            if sys.platform == "darwin":
                import fcntl
                fcntl.fcntl(output.fileno(), fcntl.F_FULLFSYNC)
        # Recheck after slow I/O, including symlinks inserted while writing.
        if not conflict and _digest_at(directory, name) != current:
            conflict = True
            destination = _conflict_name(directory, name, digest)
            if _digest_at(directory, destination) == digest:
                return destination, "conflict"
        if conflict or current is None:
            # No clobber even if another process creates the destination now.
            try:
                _rename_at(directory, temporary, destination, exchange=False)
            except FileExistsError:
                conflict = True
                destination = f"{Path(name).stem}.conflict-{uuid4().hex}.md"
                _rename_at(directory, temporary, destination, exchange=False)
        else:
            _rename_at(directory, temporary, destination, exchange=True)
            # From here this name contains displaced bytes, not our temporary.
            # Never remove it on an error or when its provenance is unknown.
            owns_temporary = False
            os.fsync(directory)
            try:
                displaced = _digest_at(directory, temporary)
            except (OSError, ValueError):
                displaced = None
            if displaced != expected:
                recovery = f"{Path(name).stem}.conflict-{uuid4().hex}.md"
                _rename_at(directory, temporary, recovery, exchange=False)
                os.fsync(directory)
                return recovery, "conflict_recovered"
            owns_temporary = True
        os.fsync(directory)
        return destination, "conflict" if conflict else "written"
    finally:
        if owns_temporary:
            with suppress(FileNotFoundError):
                os.unlink(temporary, dir_fd=directory)
                os.fsync(directory)


def _text(text: str) -> str:
    escaped = html.escape(text, quote=False)
    return re.sub(r"([\\`*_{}\[\]()#+.!|>~-])", r"\\\1", escaped)


def _time(milliseconds: int) -> str:
    seconds, millis = divmod(milliseconds, 1000)
    minutes, seconds = divmod(seconds, 60)
    hours, minutes = divmod(minutes, 60)
    return f"{hours:02}:{minutes:02}:{seconds:02}.{millis:03}"


def _note_markdown(note: Note, transcript_path: str) -> str:
    sources = "\n".join(
        f"- [{_time(c.start_ms)}–{_time(c.end_ms)}]({transcript_path}#segment-{c.segment_id}) "
        f"— `{c.segment_id}`" for c in note.citations
    )
    freshness = "Stale or unknown source revision" if note.stale else "Source revision recorded"
    # The note's name leads the file. The filename stays Note-{id}.md so the
    # ownership manifest and conflict detection keep one stable identity.
    heading = _text(note.title) if note.title else "Note"
    return (f"# {heading}\n\n{note.content}\n\n---\n\n"
            f"{freshness}; revision {note.revision}.\n\n## Sources\n\n{sources}\n")


class FileDeletionBlocked(Exception):
    """Primary data must remain available until file ownership is resolved."""


class SessionFiles:
    def __init__(self, db: Database, root: Path | None, *, data_dir: Path | None = None,
                 suggested_root: Path | None = None) -> None:
        self.db = db
        self.root = root if root is not None else load_root(db)
        self._managed_root = root is not None
        self._data_dir = data_dir
        self._suggested_root = suggested_root or Path.home() / "Documents" / "SKAZ"
        self._lock = threading.RLock()
        self.storage: ManagedStorage | None = None

    def directory(self, session_id: str) -> Path:
        if self.storage is not None and self.storage.enabled():
            self.storage.guard()
            return self.storage.directory(session_id)
        assert self.root is not None
        return self.root / "Ungrouped" / session_id

    def _allowed_directories(self) -> set[str]:
        return {"audio"} if self.storage is not None and self.storage.enabled() else set()

    def root_settings(self) -> StorageRootView:
        with self._lock:
            return StorageRootView(
                root=str(self.root) if self.root is not None else None,
                suggested_root=str(self._suggested_root), managed=self._managed_root,
                change_locked=(self._managed_root or has_output(self.db)
                               or (self.storage is not None and self.storage.enabled())),
            )

    def configure_root(self, root: str | None, expected_root: str | None) -> StorageRootView:
        # The publication/preservation/deletion lock also protects preference
        # changes: no request can publish between ownership preflight and commit.
        with self._lock:
            current = str(self.root) if self.root is not None else None
            if self._managed_root or current != expected_root:
                raise RootChangeBlocked
            if root == current:
                return self.root_settings()
            if has_output(self.db) or (self.storage is not None and self.storage.enabled()):
                raise RootChangeBlocked
            if root is not None:
                if self._data_dir is None:
                    raise RootChangeBlocked
                selected = validate_root(root, self._data_dir)
            else:
                selected = None
            with self.db.write() as connection:
                connection.execute("INSERT OR REPLACE INTO storage_root VALUES (1,?)", (root,))
            self.root = selected
            return self.root_settings()

    def status(self, session_id: str) -> dict[str, Any]:
        with self._lock:
            return self._status(session_id)

    def _status(self, session_id: str) -> dict[str, Any]:
        if self.root is None:
            return {"state": "disabled", "files": []}
        with self.db.read() as connection:
            row = connection.execute(
                "SELECT doc FROM session_file_status WHERE root=? AND session_id=?",
                (str(self.root), session_id),
            ).fetchone()
        result = json.loads(row["doc"]) if row else {"state": "pending", "files": []}
        with self.db.read() as connection:
            archives = connection.execute(
                "SELECT directory,phase FROM file_preservations WHERE root=? AND session_id=? "
                "ORDER BY directory", (str(self.root), session_id),
            ).fetchall()
        if archives:
            result["preserved_directories"] = [a["directory"] for a in archives]
            result["preservation_pending"] = any(a["phase"] == "pending" for a in archives)
            if result["preservation_pending"]:
                result.update(state="error", error="file_preservation_incomplete")
        return result

    def preserve(self, session_id: str) -> dict[str, Any]:
        """Explicitly retain the whole old directory, then rebuild from primary data."""
        from .file_preservation import preserve_directory

        with self._lock:
            if self.storage is not None and self.storage.enabled():
                self.storage.preserve(session_id)
                self._project(session_id)
                return self.status(session_id)
            if self.root is None:
                raise FileDeletionBlocked
            if repo.get_session(self.db, session_id) is None:
                return {"state": "missing", "files": []}
            try:
                preserve_directory(self.db, self.root, session_id)
            except (OSError, ValueError) as error:
                self._reconcile(session_id)
                raise FileDeletionBlocked from error
            self._project(session_id)
            return self.status(session_id)

    def project(self, session_id: str) -> dict[str, Any]:
        with self._lock:
            if self.storage is not None and self.storage.pending():
                return {"state": "error", "files": [], "error": "storage_recovery_required"}
            if self.root is None:
                return self.status(session_id)
            return self._project(session_id)

    def delete_session(self, session_id: str) -> None:
        # Only this lock is held across file I/O. Holding the database lock here
        # would stall every other request, including the existence check of a
        # concurrent DELETE, until this deletion commits.
        with self._lock:
            # Another DELETE may have passed the route's existence check before
            # waiting for this lock. Do not recreate status after its DB commit.
            if repo.get_session(self.db, session_id) is None:
                return
            try:
                if self.status(session_id).get("preservation_pending"):
                    raise ValueError("Directory preservation needs attention.")
                if self.storage is not None:
                    self.storage.legacy_preflight(session_id)
                self._remove_owned_files(session_id)
            except (OSError, ValueError) as error:
                if self.root is not None:
                    self._reconcile(session_id)
                raise FileDeletionBlocked from error
            if self.storage is not None:
                self.storage.delete_legacy(session_id)
            else:
                repo.delete_session(self.db, session_id)

    def _remove_owned_files(self, session_id: str) -> None:
        if not re.fullmatch(r"[a-f0-9]{32}", session_id):
            raise ValueError("Unsafe session identity.")
        with self.db.read() as connection:
            roots = {row["root"] for row in connection.execute(
                "SELECT root FROM file_projections WHERE session_id=?", (session_id,),
            )}
            # A read-only startup audit may record pending for a never-used
            # root. Only a publication intent carries a directory identity.
            roots.update(row["root"] for row in connection.execute(
                "SELECT root,doc FROM session_file_status WHERE session_id=?", (session_id,),
            ) if json.loads(row["doc"]).get("directory"))
            manifest = {row["name"]: row["digest"] for row in connection.execute(
                "SELECT name,digest FROM file_projections WHERE root=? AND session_id=?",
                (str(self.root), session_id),
            )}
        # Disabling/changing the root is not permission to orphan its manifest,
        # nor to traverse an old/offline root behind the user's back.
        if roots - {str(self.root)}:
            raise ValueError("A previous projection root needs attention.")
        if self.root is None:
            return
        opened = False
        try:
            with (
                _directory(self.root / "Ungrouped", create=False) as parent,
                _directory(self.root / "Ungrouped" / session_id, create=False) as directory,
            ):
                opened = True
                names = os.listdir(directory)
                # Preflight everything before removing anything. Unknown files,
                # including conflict/recovery versions, are never owned by name.
                for name in names:
                    if (not re.fullmatch(r"Transcript\.md|Note-[a-f0-9]{32}\.md", name)
                            or name not in manifest
                            or _digest_at(directory, name) != manifest[name]):
                        raise ValueError("Unresolved file ownership.")
                self._save_status(session_id, {"state": "pending", "files": []})
                for name in names:
                    recovery = f"{Path(name).stem}.recovery-{uuid4().hex}.md"
                    # Capture the actual inode before checking ownership again:
                    # a check followed by unlink(name) loses boundary replacements.
                    _rename_at(directory, name, recovery, exchange=False)
                    os.fsync(directory)
                    if _digest_at(directory, recovery) != manifest[name]:
                        # Restore only if no new external canonical has appeared.
                        # Otherwise preserve both names for explicit resolution.
                        _rename_at(directory, recovery, name, exchange=False)
                        os.fsync(directory)
                        raise ValueError("File changed during deletion.")
                    os.unlink(recovery, dir_fd=directory)
                    os.fsync(directory)
                if os.listdir(directory):
                    raise ValueError("Files appeared during deletion.")
                if roots:
                    # Anchor cleanup to the opened parent, never recurse. Check
                    # identity before rmdir; the OS atomically refuses nonempty
                    # directories (including a file arriving after this check).
                    # This is not an inode-CAS against hostile directory renames.
                    current = os.stat(session_id, dir_fd=parent, follow_symlinks=False)
                    if not os.path.samestat(current, os.fstat(directory)):
                        raise ValueError("Session directory changed during deletion.")
                    os.rmdir(session_id, dir_fd=parent)
                    os.fsync(parent)
        except FileNotFoundError:
            if opened or roots:
                raise
            # A never-projected session requires no new directory on deletion.
            return

    def _save_status(self, session_id: str, result: dict[str, Any]) -> None:
        with self.db.write() as connection:
            connection.execute("INSERT OR REPLACE INTO session_file_status VALUES (?,?,?)",
                               (str(self.root), session_id, json.dumps(result)))

    def _source_version(self, session_id: str) -> str:
        with self.db.read() as connection:
            session = connection.execute(
                "SELECT title,source_revision FROM sessions WHERE id=?", (session_id,),
            ).fetchone()
            notes = connection.execute(
                "SELECT id,revision,source_revision FROM notes WHERE session_id=? ORDER BY id",
                (session_id,),
            ).fetchall()
        snapshot = [tuple(session), [tuple(note) for note in notes]]
        return hashlib.sha256(json.dumps(snapshot).encode("utf-8")).hexdigest()

    def _conflicts(self, directory: int, previous: list[dict[str, str]]) -> list[dict[str, str]]:
        # Names alone never prove ownership. Discover but do not read, rename or
        # remove leftovers: a recovery inode can still be open in another editor.
        known = {item["path"]: item for item in previous}
        found = []
        with os.scandir(directory) as entries:
            for entry in entries:
                match = re.fullmatch(
                    r"(Transcript|Note-[a-f0-9]{32})\.(recovery|conflict)-([a-f0-9]{32}|[a-f0-9]{64})\.md",
                    entry.name,
                )
                if match is None:
                    continue
                info = entry.stat(follow_symlinks=False)
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                    raise ValueError("Unsafe recovery artifact.")
                found.append(known.get(entry.name, {
                    "name": f"{match[1]}.md", "path": entry.name, "state": "recovery_required",
                }))
        return sorted(found, key=lambda item: item["path"])

    def reconcile(self) -> None:
        """Startup audit only: preserve disk bytes, never infer missing ownership."""
        with self._lock:
            if self.root is None:
                return
            with self.db.read() as connection:
                sessions = [row["id"] for row in connection.execute("SELECT id FROM sessions")]
            for session_id in sessions:
                self._reconcile(session_id)

    def _reconcile(self, session_id: str) -> None:
        assert self.root is not None
        if not re.fullmatch(r"[a-f0-9]{32}", session_id):
            self._save_status(session_id, {"state": "error", "files": [], "error": "unsafe_session_id"})
            return
        result = self.status(session_id)
        if result.get("source_version") != self._source_version(session_id):
            result.update(state="pending", files=[])
        try:
            with _directory(self.directory(session_id), create=False) as directory:
                result["conflicts"] = self._conflicts(directory, result.get("conflicts", []))
                with self.db.read() as connection:
                    manifest = {row["name"]: row["digest"] for row in connection.execute(
                        "SELECT name,digest FROM file_projections WHERE root=? AND session_id=?",
                        (str(self.root), session_id),
                    )}
                    names = {"Transcript.md"}
                    names.update(f"Note-{row['id']}.md" for row in connection.execute(
                        "SELECT id FROM notes WHERE session_id=?", (session_id,),
                    ))
                for name in names | manifest.keys():
                    if not re.fullmatch(r"Transcript\.md|Note-[a-f0-9]{32}\.md", name):
                        raise ValueError("Unsafe manifest identity.")
                    current = _digest_at(directory, name)
                    if current is None or current != manifest.get(name):
                        result.update(state="pending", files=[])
                if (result["conflicts"] or set(os.listdir(directory))
                        - names - manifest.keys() - self._allowed_directories()):
                    result["state"] = "conflict"
        except FileNotFoundError:
            # Retain prior publication intent even when its root is offline.
            result.update(state="pending", files=[], conflicts=[])
        except (OSError, ValueError):
            result.update(state="error", files=[], error="file_projection_failed")
        self._save_status(session_id, result)

    def _project(self, session_id: str) -> dict[str, Any]:
        assert self.root is not None
        if self.status(session_id).get("preservation_pending"):
            return self.status(session_id)
        # Snapshot after acquiring the writer lock: a queued older HTTP request
        # cannot replace a newer projection with an earlier captured revision.
        with self.db.read():
            session = repo.get_session(self.db, session_id)
            if session is None:
                return {"state": "missing", "files": []}
            if not re.fullmatch(r"[a-f0-9]{32}", session_id):
                return {"state": "error", "files": [], "error": "unsafe_session_id"}
            segments = repo.list_segments(self.db, session_id)
            notes = note_store.list_notes(self.db, session_id)
            source_version = self._source_version(session_id)
        transcript = f"# {_text(session.title)}\n\n"
        transcript += "\n\n".join(
            f'<a id="segment-{s.id}"></a>\n\n'
            f"[{_time(s.start_ms)}–{_time(s.end_ms)}] `{s.id}`\n\n{_text(s.text)}"
            for s in segments
        ) or "No stable transcript yet."
        documents: list[tuple[str, Note | None]] = [("Transcript.md", None)]
        documents.extend((f"Note-{note.id}.md", note) for note in notes)
        transcript_path = "Transcript.md"
        result: dict[str, Any] = {
            "state": "ready", "directory": str(self.directory(session_id).relative_to(self.root)), "files": [],
            "conflicts": self.status(session_id).get("conflicts", []),
            "source_version": source_version,
        }
        # Durable intent precedes any filesystem mutation. A crash after the
        # manifest commit but before final status cannot leave a false 'ready'.
        self._save_status(session_id, {**result, "state": "pending"})
        try:
            with _directory(self.directory(session_id)) as directory:
                result["conflicts"] = self._conflicts(directory, result["conflicts"])
                for name, note in documents:
                    text = transcript + "\n" if note is None else _note_markdown(note, transcript_path)
                    if not re.fullmatch(r"Transcript\.md|Note-[a-f0-9]{32}\.md", name):
                        raise ValueError("Unsafe document identity.")
                    with self.db.read() as connection:
                        row = connection.execute(
                            "SELECT digest FROM file_projections WHERE root=? AND session_id=? AND name=?",
                            (str(self.root), session_id, name),
                        ).fetchone()
                    body = text.encode("utf-8")
                    path, state = _publish(directory, name, body, row["digest"] if row else None)
                    if name == "Transcript.md" and state == "conflict":
                        transcript_path = path
                    result["files"].append({"name": name, "path": path, "state": state})
                    if state in ("conflict", "conflict_recovered"):
                        result["state"] = "conflict"
                        if not any(c["path"] == path for c in result["conflicts"]):
                            result["conflicts"].append({"name": name, "path": path, "state": state})
                    if state != "conflict":
                        with self.db.write() as connection:
                            connection.execute(
                                "INSERT OR REPLACE INTO file_projections VALUES (?,?,?,?)",
                                (str(self.root), session_id, name, hashlib.sha256(body).hexdigest()),
                            )
                if (result["conflicts"] or set(os.listdir(directory))
                        - {name for name, _ in documents} - self._allowed_directories()):
                    result["state"] = "conflict"
                result["conflicts"].sort(key=lambda item: item["path"])
        except (OSError, ValueError):
            result.update(state="error", error="file_projection_failed")
        self._save_status(session_id, result)
        return self.status(session_id)
