"""Only app-owned, identity-named temporary media may be removed."""
from __future__ import annotations

import re
import shutil
from pathlib import Path


class ImportTemp:
    def __init__(self, root: Path) -> None:
        self.root = root

    def _path(self, session_id: str) -> Path:
        if not re.fullmatch(r"[a-f0-9]{32}", session_id):
            raise ValueError("Invalid import identity.")
        path = self.root / session_id
        if self.root.is_symlink() or path.is_symlink():
            raise ValueError("Temporary media directory must not be a symbolic link.")
        return path

    def directory(self, session_id: str) -> Path:
        path = self._path(session_id)
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
        return path

    def remove(self, session_id: str) -> None:
        path = self._path(session_id)
        if path.exists():
            shutil.rmtree(path)
