"""Opt-in physical storage with durable, explicitly resumed filesystem operations.

An installation switches only with an empty session database. Existing recordings
are never silently migrated or deleted. All paths are ID-based; external entries
are never recursively removed. The caller's projection lock precedes the DB lock.
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
from collections.abc import Callable
from functools import wraps
from pathlib import Path
from typing import Any, ParamSpec, TypeVar
from uuid import uuid4

from . import repository as repo
from .db import Database
from .schemas import Session, SessionMode
from .session_files import SessionFiles, _digest_at, _directory, _rename_at
from .storage_root import validate_root


class StorageConflict(ValueError):
    """Storage requires explicit reconciliation; no implicit fallback is allowed."""


P = ParamSpec("P")
R = TypeVar("R")


def storage_boundary(function: Callable[P, R]) -> Callable[P, R]:
    @wraps(function)
    def wrapped(*args: P.args, **kwargs: P.kwargs) -> R:
        try:
            return function(*args, **kwargs)
        except (OSError, ValueError, sqlite3.Error) as error:
            raise StorageConflict("Storage operation needs attention.") from error
    return wrapped


def _identity(value: str) -> str:
    if not re.fullmatch(r"[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", value):
        raise StorageConflict("Invalid storage identity.")
    return value


def _folder(group: str | None) -> str:
    return "Ungrouped" if group is None else f"Group-{_identity(group)}"


def _same(path: Path, device: int, inode: int) -> bool:
    with _directory(path, create=False) as fd:
        info = os.fstat(fd)
        return (info.st_dev, info.st_ino) == (device, inode)


def _rename(source: Path, target: Path) -> None:
    # _rename_at accepts descriptor-relative paths; hold BOTH parent descriptors
    # and use /dev/fd only is not safe/portable. Call the same native primitive
    # directly with distinct descriptors instead.
    from .session_files import rename_between
    with _directory(source.parent, create=False) as src, _directory(target.parent, create=False) as dst:
        rename_between(src, source.name, dst, target.name)
        os.fsync(src)
        os.fsync(dst)


def _entry(path: Path) -> tuple[int, int]:
    with _directory(path.parent, create=False) as parent:
        info = os.stat(path.name, dir_fd=parent, follow_symlinks=False)
    return info.st_dev, info.st_ino


class ManagedStorage:
    def __init__(self, db: Database, files: SessionFiles, audio_dir: Path) -> None:
        self.db, self.files, self.audio_dir = db, files, audio_dir

    def enabled(self) -> bool:
        with self.db.read() as c:
            return c.execute("SELECT 1 FROM physical_storage WHERE id=1").fetchone() is not None

    def pending(self) -> dict[str, Any] | None:
        with self.db.read() as c:
            row = c.execute("SELECT doc FROM storage_operations WHERE id=1").fetchone()
        return json.loads(row[0]) if row else None

    def guard(self) -> None:
        if self.pending() is not None:
            raise StorageConflict("A storage operation is pending. Retry recovery before writing.")

    def view(self) -> dict[str, Any]:
        with self.files._lock, self.db.read() as c:
            row = c.execute("SELECT revision,doc FROM physical_storage WHERE id=1").fetchone()
            pending = self.pending()
            return {"enabled": row is not None, "revision": row[0] if row else 0,
                    "data": json.loads(row[1]) if row else {"version": 1, "groups": [], "membership": {}},
                    "pending": ({"kind": pending["kind"], "phase": pending["phase"]} if pending else None)}

    @storage_boundary
    def enable(self) -> dict[str, Any]:
        with self.files._lock, self.db.read() as c:
            if self.enabled():
                return self.view()
            if self.files.root is None or c.execute("SELECT 1 FROM sessions LIMIT 1").fetchone():
                raise StorageConflict("Choose a root and explicitly delete old sessions before switching.")
            self._group(self.files.root / "Ungrouped")
            with self.db.write() as write:
                write.execute("INSERT INTO physical_storage VALUES (1,0,?)", (json.dumps(
                    {"version": 1, "groups": [], "membership": {}}),))
            return self.view()

    def _group(self, path: Path) -> None:
        with self.db.read() as c:
            owned = c.execute("SELECT device,inode FROM storage_directories WHERE path=?",
                              (str(path),)).fetchone()
        if owned:
            if not _same(path, owned[0], owned[1]):
                raise StorageConflict("Group directory changed.")
            return
        with _directory(path.parent) as parent:
            os.mkdir(path.name, mode=0o700, dir_fd=parent)
            os.fsync(parent)
            with _directory(path, create=False) as fd:
                info = os.fstat(fd)
            with self.db.write() as c:
                c.execute("INSERT INTO storage_directories VALUES (?,?,?)",
                          (str(path), info.st_dev, info.st_ino))

    def _remove_group(self, path: Path) -> None:
        with self.db.read() as c:
            row = c.execute("SELECT device,inode FROM storage_directories WHERE path=?", (str(path),)).fetchone()
        if row and os.path.lexists(path):
            if not _same(path, row[0], row[1]):
                raise StorageConflict("Group directory changed.")
            with _directory(path, create=False) as fd:
                if os.listdir(fd):
                    return
            with _directory(path.parent, create=False) as fd:
                os.rmdir(path.name, dir_fd=fd)
                os.fsync(fd)
        with self.db.write() as c:
            c.execute("DELETE FROM storage_directories WHERE path=?", (str(path),))

    def directory(self, sid: str) -> Path:
        _identity(sid)
        with self.db.read() as c:
            row = c.execute("SELECT path FROM session_locations WHERE session_id=?", (sid,)).fetchone()
        if row is None:
            raise StorageConflict("Session directory is not initialized.")
        return Path(row[0])

    @storage_boundary
    def create(self, title: str, mode: SessionMode) -> Session:
        with self.files._lock, self.db.read():
            self.guard()
            session = repo.create_session(self.db, title, mode)
            if self.enabled():
                assert self.files.root is not None
                path = self.files.root / "Ungrouped" / session.id
                # Intent recorded before mkdir; creation never adopts an existing
                # directory. Failed allocation remains visible as a recoverable session.
                with self.db.write() as c:
                    c.execute("INSERT INTO session_locations VALUES (?,?,NULL,NULL)", (session.id, str(path)))
                self._allocate(session.id)
            return session

    def _allocate(self, sid: str) -> None:
        path = self.directory(sid)
        with self.db.read() as c:
            row = c.execute("SELECT device,inode FROM session_locations WHERE session_id=?", (sid,)).fetchone()
        if row[0] is not None:
            if not _same(path, row[0], row[1]):
                raise StorageConflict("Session directory identity changed.")
            return
        with _directory(path.parent) as parent:
            os.mkdir(path.name, mode=0o700, dir_fd=parent)
            os.fsync(parent)
            with _directory(path, create=False) as fd:
                info = os.fstat(fd)
            with self.db.write() as c:
                c.execute("UPDATE session_locations SET device=?,inode=? WHERE session_id=?",
                          (info.st_dev, info.st_ino, sid))

    def audio_path(self, sid: str, sequence: int) -> Path:
        self.guard()
        if not self.enabled():
            return self.audio_dir / sid / f"{sequence:06d}.wav"
        self._location(sid)
        return self.directory(sid) / "audio" / f"{sequence:06d}.wav"

    def _save_operation(self, doc: dict[str, Any]) -> None:
        with self.db.write() as c:
            c.execute("INSERT OR REPLACE INTO storage_operations VALUES (1,?)", (json.dumps(doc),))

    def _idle(self, sid: str) -> None:
        with self.db.read() as c:
            if c.execute("SELECT 1 FROM asr_connections WHERE session_id=? AND status='active'", (sid,)).fetchone():
                raise StorageConflict("Pause recording before moving files.")
            if c.execute("SELECT 1 FROM chunks WHERE session_id=? AND status='processing'", (sid,)).fetchone():
                raise StorageConflict("Wait for audio processing before moving files.")

    def _location(self, sid: str) -> sqlite3.Row:
        with self.db.read() as c:
            row = c.execute("SELECT * FROM session_locations WHERE session_id=?", (sid,)).fetchone()
        if not isinstance(row, sqlite3.Row) or row["device"] is None:
            raise StorageConflict("Session allocation needs attention.")
        if not _same(Path(row["path"]), row["device"], row["inode"]):
            raise StorageConflict("Session directory identity changed.")
        return row

    @storage_boundary
    def update_groups(self, data: dict[str, Any], revision: int) -> dict[str, Any]:
        with self.files._lock, self.db.read() as c:
            self.guard()
            current = self.view()
            if not current["enabled"] or current["revision"] != revision:
                raise StorageConflict("Groups changed; reload before saving.")
            ids = {g["id"] for g in data["groups"]}
            if len(ids) != len(data["groups"]):
                raise StorageConflict("Duplicate groups.")
            for gid in ids:
                _identity(gid)
            sessions = {r[0] for r in c.execute("SELECT id FROM sessions")}
            if any(s not in sessions or (g is not None and g not in ids)
                   for s, g in data["membership"].items()):
                raise StorageConflict("Unknown session or group.")
            assert self.files.root is not None
            moves = []
            for sid in sessions:
                location = self._location(sid)
                target = self.files.root / _folder(data["membership"].get(sid)) / sid
                if str(target) != location["path"]:
                    self._idle(sid)
                    self._group(target.parent)
                    with _directory(target.parent, create=False) as parent:
                        if os.fstat(parent).st_dev != location["device"]:
                            raise StorageConflict("Cross-device moves are not supported.")
                        if os.path.lexists(target):
                            raise StorageConflict("Move destination already exists.")
                    moves.append({"sid": sid, "source": location["path"], "target": str(target),
                                  "device": location["device"], "inode": location["inode"]})
            for gid in ids:
                self._group(self.files.root / _folder(gid))
            self._save_operation({"kind": "groups", "phase": "prepared", "moves": moves,
                                  "data": data, "revision": revision + 1,
                                  "remove_groups": [str(self.files.root / _folder(g["id"]))
                                                    for g in current["data"]["groups"] if g["id"] not in ids]})
            self._recover()
            return self.view()

    @storage_boundary
    def move_root(self, value: str, expected: str) -> dict[str, Any]:
        with self.files._lock, self.db.read() as c:
            self.guard()
            old = self.files.root
            if (not self.enabled() or old is None or str(old) != expected
                    or self.files._managed_root or self.files._data_dir is None):
                raise StorageConflict("Root changed or is managed.")
            root = validate_root(value, self.files._data_dir)
            if root == old or root.is_relative_to(old) or old.is_relative_to(root):
                raise StorageConflict("Choose a separate root.")
            view = self.view()
            folders = ["Ungrouped", *[_folder(g["id"]) for g in view["data"]["groups"]]]
            for folder in folders:
                self._group(root / folder)
            moves = []
            for row in c.execute("SELECT session_id FROM session_locations").fetchall():
                sid = row[0]
                self._idle(sid)
                location = self._location(sid)
                target = root / Path(location["path"]).relative_to(old)
                with _directory(target.parent, create=False) as parent:
                    if os.fstat(parent).st_dev != location["device"] or os.path.lexists(target):
                        raise StorageConflict("Destination is occupied or on another device.")
                moves.append({"sid": sid, "source": location["path"], "target": str(target),
                              "device": location["device"], "inode": location["inode"],
                              "old_root": str(old), "new_root": str(root)})
            self._save_operation({"kind": "root", "phase": "prepared", "moves": moves,
                                  "new_root": str(root), "old_root": str(old),
                                  "remove_groups": [str(old / f) for f in folders]})
            self._recover()
            return self.view()

    def _commit_move(self, move: dict[str, Any]) -> None:
        source, target = Path(move["source"]), Path(move["target"])
        if not os.path.lexists(target):
            if not _same(source, move["device"], move["inode"]):
                raise StorageConflict("Move source changed.")
            _rename(source, target)
        if not _same(target, move["device"], move["inode"]) or os.path.lexists(source):
            raise StorageConflict("Move requires manual identity reconciliation.")
        for parent in (source.parent, target.parent):
            if os.path.lexists(parent):
                with _directory(parent, create=False) as fd:
                    os.fsync(fd)
        with self.db.write() as c:
            chunks = c.execute("SELECT sequence,path FROM chunks WHERE session_id=?", (move["sid"],)).fetchall()
            for chunk in chunks:
                old = Path(chunk["path"])
                if old.parent not in (source / "audio", target / "audio"):
                    raise StorageConflict("Audio path is outside its session.")
                c.execute("UPDATE chunks SET path=? WHERE session_id=? AND sequence=?",
                          (str(target / "audio" / old.name), move["sid"], chunk["sequence"]))
            c.execute("UPDATE session_locations SET path=? WHERE session_id=?", (str(target), move["sid"]))
            # Projection content/source IDs are unchanged, but the displayed path is stale.
            c.execute("DELETE FROM session_file_status WHERE session_id=?", (move["sid"],))
            if "new_root" in move:
                c.execute("UPDATE file_projections SET root=? WHERE session_id=? AND root=?",
                          (move["new_root"], move["sid"], move["old_root"]))

    def _manifest(self, sid: str, path: Path) -> dict[str, str]:
        with self.db.read() as c:
            result = {r["name"]: r["digest"] for r in c.execute(
                "SELECT name,digest FROM file_projections WHERE root=? AND session_id=?",
                (str(self.files.root), sid))}
            for row in c.execute("SELECT path,sha256 FROM chunks WHERE session_id=?", (sid,)):
                audio = Path(row["path"])
                if audio.parent != path / "audio":
                    raise StorageConflict("Audio path is outside its session.")
                result[f"audio/{audio.name}"] = row["sha256"]
        return result

    def _audit(self, path: Path, manifest: dict[str, str], *, missing: bool = False) -> None:
        with _directory(path, create=False) as fd:
            actual: set[str] = set()
            for name in os.listdir(fd):
                if name == "audio" and path.parent != self.audio_dir:
                    with _directory(path / "audio", create=False) as audio:
                        for filename in os.listdir(audio):
                            key = f"audio/{filename}"
                            owned_key = key.removesuffix(".deleting") if missing else key
                            if (owned_key not in manifest or _digest_at(audio, filename) != manifest[owned_key]
                                    or owned_key in actual):
                                raise StorageConflict("Unowned or changed audio; nothing deleted.")
                            actual.add(owned_key)
                else:
                    owned_name = name.removesuffix(".deleting") if missing else name
                    if (owned_name not in manifest or _digest_at(fd, name) != manifest[owned_name]
                            or owned_name in actual):
                        raise StorageConflict("Unowned or changed files; preserve them before deleting.")
                    actual.add(owned_name)
            if not missing and actual != set(manifest):
                raise StorageConflict("Owned files are missing; deletion requires reconciliation.")

    @storage_boundary
    def preserve(self, sid: str) -> None:
        with self.files._lock, self.db.read():
            self.guard()
            self._idle(sid)
            location = self._location(sid)
            path = Path(location["path"])
            operation = uuid4().hex
            try:
                self._audit(path, self._manifest(sid, path))
                return
            except (OSError, ValueError):
                pass
            archive = path.with_name(f"{sid}.preserved-{operation}")
            with _directory(path, create=False) as fd:
                names = [name for name in os.listdir(fd) if name != "audio"]
            if not names:
                return
            moves = [{"source": str(path / name), "target": str(archive / name),
                      "identity": list(_entry(path / name))} for name in names]
            self._group(archive)
            self._save_operation({"kind": "preserve", "phase": "prepared", "sid": sid,
                                  "id": operation, "root": str(self.files.root),
                                  "archive": str(archive), "moves": moves})
            self._recover()

    @storage_boundary
    def read_audio(self, sid: str, sequence: int) -> bytes:
        with self.db.read():
            self.guard()
            self._location(sid)
            chunk = repo.get_chunk(self.db, sid, sequence)
            if chunk is None:
                raise StorageConflict("Audio block is missing.")
            path = self.directory(sid) / "audio" / f"{sequence:06d}.wav"
            if str(path) != chunk.path:
                raise StorageConflict("Audio path is outside the session.")
            with _directory(path.parent, create=False) as fd:
                descriptor = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                with os.fdopen(descriptor, "rb") as source:
                    import hashlib
                    import stat
                    info = os.fstat(source.fileno())
                    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 32 * 1024 * 1024:
                        raise StorageConflict("Unsafe audio block.")
                    body = source.read()
                    if hashlib.sha256(body).hexdigest() != chunk.sha256:
                        raise StorageConflict("Audio block changed.")
                    return body

    @storage_boundary
    def delete(self, sid: str) -> None:
        with self.files._lock, self.db.read():
            self.guard()
            self._idle(sid)
            location = self._location(sid)
            path = Path(location["path"])
            manifest = self._manifest(sid, path)
            self._audit(path, manifest)
            target = path.with_name(f"{sid}.deleting-{uuid4().hex}")
            self._save_operation({"kind": "delete", "phase": "prepared", "sid": sid,
                                  "source": str(path), "target": str(target), "manifest": manifest,
                                  "device": location["device"], "inode": location["inode"]})
            self._recover()

    @storage_boundary
    def recover(self) -> dict[str, Any]:
        with self.files._lock, self.db.read():
            self._recover()
            return self.view()

    def legacy_preflight(self, sid: str) -> dict[str, str]:
        self.guard()
        _identity(sid)
        path = self.audio_dir / sid
        with self.db.read() as c:
            manifest = {}
            for row in c.execute("SELECT path,sha256 FROM chunks WHERE session_id=?", (sid,)):
                audio = Path(row["path"])
                if audio.parent != path:
                    raise StorageConflict("Legacy audio path is outside its session.")
                manifest[audio.name] = row["sha256"]
        if os.path.lexists(path):
            self._audit(path, manifest)
        elif manifest:
            raise StorageConflict("Original audio is missing.")
        return manifest

    @storage_boundary
    def delete_legacy(self, sid: str) -> None:
        # Called under the projection lock, after Markdown cleanup succeeded.
        with self.db.read():
            manifest = self.legacy_preflight(sid)
            path = self.audio_dir / sid
            if not os.path.lexists(path):
                repo.delete_session(self.db, sid)
                return
            with _directory(path, create=False) as fd:
                info = os.fstat(fd)
            target = path.with_name(f"{sid}.deleting-{uuid4().hex}")
            self._save_operation({"kind": "delete", "phase": "prepared", "sid": sid,
                                  "source": str(path), "target": str(target),
                                  "manifest": manifest, "device": info.st_dev, "inode": info.st_ino})
            self._recover()

    def _recover(self) -> None:
        op = self.pending()
        if op is None:
            return
        if op["kind"] == "preserve":
            for move in op["moves"]:
                source, target = Path(move["source"]), Path(move["target"])
                identity = tuple(move["identity"])
                if not os.path.lexists(target):
                    if _entry(source) != identity:
                        raise StorageConflict("Preservation source changed.")
                    _rename(source, target)
                if _entry(target) != identity or os.path.lexists(source):
                    raise StorageConflict("Preservation requires identity reconciliation.")
            archive = Path(op["archive"])
            with _directory(archive, create=False) as fd:
                info = os.fstat(fd)
                os.fsync(fd)
            with self.db.write() as c:
                c.execute("INSERT INTO file_preservations VALUES (?,?,?,?,?,?,'preserved')",
                          (op["id"], op["root"], op["sid"], str(archive.relative_to(op["root"])),
                           info.st_dev, info.st_ino))
                c.execute("DELETE FROM file_projections WHERE session_id=?", (op["sid"],))
                c.execute("DELETE FROM session_file_status WHERE session_id=?", (op["sid"],))
                c.execute("DELETE FROM storage_operations WHERE id=1")
            return
        if op["kind"] in ("groups", "root"):
            for move in op["moves"]:
                self._commit_move(move)
            for path in op["remove_groups"]:
                self._remove_group(Path(path))
            with self.db.write() as c:
                if op["kind"] == "groups":
                    c.execute("UPDATE physical_storage SET revision=?,doc=? WHERE id=1",
                              (op["revision"], json.dumps(op["data"])))
                else:
                    c.execute("INSERT OR REPLACE INTO storage_root VALUES (1,?)", (op["new_root"],))
                c.execute("DELETE FROM storage_operations WHERE id=1")
            if op["kind"] == "root":
                self.files.root = Path(op["new_root"])
            return
        source, target = Path(op["source"]), Path(op["target"])
        if op["phase"] == "prepared":
            if not os.path.lexists(target):
                if not _same(source, op["device"], op["inode"]):
                    raise StorageConflict("Delete source changed.")
                _rename(source, target)
            if not _same(target, op["device"], op["inode"]) or os.path.lexists(source):
                raise StorageConflict("Delete directory changed.")
            with _directory(target.parent, create=False) as fd:
                os.fsync(fd)
            self._audit(target, op["manifest"])
            # Primary DB rows and transition to cleanup commit together. The
            # journal has no session FK, so a crash cannot lose audio ownership.
            op["phase"] = "cleanup"
            with self.db.write() as c:
                c.execute("DELETE FROM segments_fts WHERE session_id=?", (op["sid"],))
                c.execute("DELETE FROM sessions WHERE id=?", (op["sid"],))
                groups = c.execute("SELECT doc FROM physical_storage WHERE id=1").fetchone()
                if groups:
                    data = json.loads(groups[0])
                    data["membership"].pop(op["sid"], None)
                    c.execute("UPDATE physical_storage SET revision=revision+1,doc=? WHERE id=1",
                              (json.dumps(data),))
                c.execute("UPDATE storage_operations SET doc=? WHERE id=1", (json.dumps(op),))
        if os.path.lexists(target):
            if not _same(target, op["device"], op["inode"]):
                raise StorageConflict("Cleanup directory changed.")
            self._audit(target, op["manifest"], missing=True)
            for relative, digest in op["manifest"].items():
                file = target / relative
                capture = file.name + ".deleting"
                captured = file.with_name(capture)
                if not os.path.lexists(file) and not os.path.lexists(captured):
                    continue
                with _directory(file.parent, create=False) as fd:
                    # Persistent deterministic capture name makes process death
                    # after rename resumable without granting ownership by name.
                    if not os.path.lexists(captured):
                        _rename_at(fd, file.name, capture, exchange=False)
                    os.fsync(fd)
                    if _digest_at(fd, capture) != digest:
                        raise StorageConflict("File changed during cleanup; preserved.")
                    os.unlink(capture, dir_fd=fd)
                    os.fsync(fd)
            audio = target / "audio"
            if os.path.lexists(audio):
                with _directory(target, create=False) as fd:
                    os.rmdir("audio", dir_fd=fd)
                    os.fsync(fd)
            with _directory(target.parent, create=False) as fd:
                os.rmdir(target.name, dir_fd=fd)
                os.fsync(fd)
        with _directory(target.parent, create=False) as fd:
            os.fsync(fd)
        with self.db.write() as c:
            c.execute("DELETE FROM storage_operations WHERE id=1")
