"""Checks for a file path the user picked in the open dialog (documents, audio, video).

The backend can't prove the path came from the dialog (the renderer forwards
it); it refuses what a dialog would never return: relative paths, hidden
folders, SKAZ's own data folder, devices and folders. The hidden-folder and
data-folder checks run on the path as given **and** on where it really is
after links are followed, so a link in an ordinary folder can't reach a
hidden folder or SKAZ's data. Any ordinary file the user chose keeps working.
"""

from __future__ import annotations

import os
import stat
from collections.abc import Callable
from pathlib import Path

CHOOSE_FILE = "Choose a file to add."
NOT_ABSOLUTE = "The file path must be absolute."
HIDDEN = "Files inside hidden folders can't be added."
MISSING = "This file doesn't exist any more or can't be opened."
APP_DATA = "Files from SKAZ's own data folder can't be added."
NOT_REGULAR = "Choose a regular file."
NOT_READABLE = "SKAZ isn't allowed to read this file."


def _hidden(path: Path) -> bool:
    return any(part.startswith(".") for part in path.parts[1:])


def given_path(raw: str | Path, rejected: Callable[[str], Exception]) -> Path:
    """The path as given: not empty, absolute, not in a hidden folder (before any disk access)."""
    text = str(raw)
    if "\x00" in text or not text:
        raise rejected(CHOOSE_FILE)
    path = Path(text)
    if not path.is_absolute():
        raise rejected(NOT_ABSOLUTE)
    if _hidden(path):
        raise rejected(HIDDEN)
    return path


def resolved_file(path: Path, data_dir: Path,
                  rejected: Callable[[str], Exception]) -> tuple[Path, os.stat_result]:
    """Where ``path`` really is (links followed) and its stat, after the same checks on that place."""
    try:
        resolved = path.resolve(strict=True)
        info = resolved.stat()
    except (OSError, RuntimeError) as error:
        raise rejected(MISSING) from error
    if _hidden(resolved):
        raise rejected(HIDDEN)
    data = data_dir.resolve()
    if resolved == data or data in resolved.parents:
        raise rejected(APP_DATA)
    if not stat.S_ISREG(info.st_mode):
        raise rejected(NOT_REGULAR)
    if not os.access(resolved, os.R_OK):
        raise rejected(NOT_READABLE)
    return resolved, info
