"""Non-destructive, explicitly requested preservation of a Markdown directory.

Caller holds the session-files writer lock. Never traverse archive contents or
remove archives, even after deletion of the original session. SQLite intent plus
inode identity allows explicit retry after process death on either side of rename.
"""
from __future__ import annotations

import json
import os
import re
import stat
from pathlib import Path
from uuid import uuid4

from .db import Database
from .session_files import _digest_at, _directory, _rename_at


def preserve_directory(db: Database, root: Path, session_id: str) -> None:
    if not re.fullmatch(r"[a-f0-9]{32}", session_id):
        raise ValueError("Unsafe session identity.")
    with db.read() as connection:
        pending = connection.execute(
            "SELECT * FROM file_preservations WHERE root=? AND session_id=? AND phase='pending'",
            (str(root), session_id),
        ).fetchone()
        statuses = connection.execute(
            "SELECT root,doc FROM session_file_status WHERE session_id=?", (session_id,),
        ).fetchall()
        roots = {r["root"] for r in statuses if json.loads(r["doc"]).get("directory")}
        roots.update(r["root"] for r in connection.execute(
            "SELECT root FROM file_projections WHERE session_id=?", (session_id,),
        ))
        manifest = {r["name"]: r["digest"] for r in connection.execute(
            "SELECT name,digest FROM file_projections WHERE root=? AND session_id=?",
            (str(root), session_id),
        )}
    if roots != {str(root)}:
        raise ValueError("Only a previously used current projection root is allowed.")
    with _directory(root / "Ungrouped", create=False) as parent:
        if pending is None:
            try:
                info = os.stat(session_id, dir_fd=parent, follow_symlinks=False)
            except FileNotFoundError:
                return  # Previously removed empty directory: explicit project repairs it.
            if not stat.S_ISDIR(info.st_mode):
                raise ValueError("Session directory is not a directory.")
            with _directory(root / "Ungrouped" / session_id, create=False) as directory:
                if not os.path.samestat(info, os.fstat(directory)):
                    raise ValueError("Directory identity changed.")
                names = os.listdir(directory)
                # A repeated successful request must not keep archiving clean files.
                clean = True
                for name in names:
                    try:
                        owned = name in manifest and _digest_at(directory, name) == manifest[name]
                    except (OSError, ValueError):
                        owned = False
                    if not owned:
                        clean = False
                        break
                if clean:
                    return
            operation = uuid4().hex
            destination = f"{session_id}.preserved-{operation}"
            device, inode = info.st_dev, info.st_ino
            with db.write() as connection:
                connection.execute(
                    "INSERT INTO file_preservations VALUES (?,?,?,?,?,?,'pending')",
                    (operation, str(root), session_id, f"Ungrouped/{destination}", device, inode),
                )
        else:
            operation = pending["id"]
            destination = Path(pending["directory"]).name
            device, inode = pending["device"], pending["inode"]
            if pending["directory"] != f"Ungrouped/{session_id}.preserved-{operation}":
                raise ValueError("Unsafe preservation identity.")
        try:
            archived = os.stat(destination, dir_fd=parent, follow_symlinks=False)
        except FileNotFoundError:
            current = os.stat(session_id, dir_fd=parent, follow_symlinks=False)
            if (current.st_dev, current.st_ino) != (device, inode):
                raise ValueError("Source identity changed; no files removed.") from None
            _rename_at(parent, session_id, destination, exchange=False)
            archived = os.stat(destination, dir_fd=parent, follow_symlinks=False)
        # Never adopt an unrelated destination, including after interrupted rename.
        if not stat.S_ISDIR(archived.st_mode) or (archived.st_dev, archived.st_ino) != (device, inode):
            raise ValueError("Archive identity changed; manual review required.")
        os.fsync(parent)
        with db.write() as connection:
            connection.execute("UPDATE file_preservations SET phase='preserved' WHERE id=?", (operation,))
            connection.execute("DELETE FROM file_projections WHERE root=? AND session_id=?",
                               (str(root), session_id))
