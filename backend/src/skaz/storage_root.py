"""Persisted Markdown root preference, separate from model/provider settings."""
from __future__ import annotations

import json
from pathlib import Path

from pydantic import BaseModel

from .db import Database


class RootChangeBlocked(Exception):
    """A root change would abandon output or overwrite a newer preference."""


class StorageRootView(BaseModel):
    root: str | None
    suggested_root: str
    managed: bool
    change_locked: bool
    mode: str = "markdown_projection"


def load_root(db: Database) -> Path | None:
    with db.read() as connection:
        row = connection.execute("SELECT root FROM storage_root WHERE id=1").fetchone()
    return Path(row["root"]) if row and row["root"] is not None else None


def has_output(db: Database) -> bool:
    with db.read() as connection:
        if connection.execute("SELECT 1 FROM file_projections LIMIT 1").fetchone():
            return True
        if connection.execute("SELECT 1 FROM file_preservations LIMIT 1").fetchone():
            return True
        return any(json.loads(row["doc"]).get("directory") for row in connection.execute(
            "SELECT doc FROM session_file_status",
        ))


def validate_root(raw: str, data_dir: Path) -> Path:
    # Do not expand, resolve or silently repair user input before validation.
    if (not raw or len(raw) > 4096 or any(ord(c) < 32 for c in raw)
            or "\\" in raw or any(p in (".", "..") for p in raw.split("/"))):
        raise ValueError("Invalid root.")
    root = Path(raw)
    if not root.is_absolute() or root == Path(root.anchor) or str(root) != raw:
        raise ValueError("Invalid root.")
    # Root publication must not mingle with private SQLite/audio/internal files.
    # The already-open private data directory may itself use an OS alias
    # (e.g. /var on macOS). Resolve that known directory, never the candidate.
    private = data_dir.resolve(strict=True)
    if root == private or root in private.parents or private in root.parents:
        raise ValueError("Root overlaps private application storage.")
    from .session_files import _directory

    candidate = root
    while True:
        try:
            with _directory(candidate, create=False):
                return root
        except FileNotFoundError:
            candidate = candidate.parent
