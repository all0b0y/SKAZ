"""Only app-owned, identity-named temporary media may be removed."""
from __future__ import annotations

import os
import re
import shutil
from pathlib import Path

_IDENTITY = re.compile(r"[a-f0-9]{32}")


class ImportTemp:
    def __init__(self, root: Path) -> None:
        self.root = root

    def _path(self, session_id: str) -> Path:
        if not _IDENTITY.fullmatch(session_id):
            raise ValueError("Invalid import identity.")
        path = self.root / session_id
        if self.root.is_symlink() or path.is_symlink():
            raise ValueError("Temporary media directory must not be a symbolic link.")
        return path

    def directory(self, session_id: str) -> Path:
        path = self._path(session_id)
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
        return path

    def sessions(self) -> list[str]:
        """Identity-named directories under the root; anything else there is not ours to touch."""
        try:
            names = os.listdir(self.root)
        except FileNotFoundError:
            return []
        return sorted(name for name in names if _IDENTITY.fullmatch(name))

    def remove(self, session_id: str) -> None:
        path = self._path(session_id)
        if path.exists():
            shutil.rmtree(path)
