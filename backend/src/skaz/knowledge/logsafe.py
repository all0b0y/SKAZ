"""Log lines without personal content.

The app log is read by the renderer (``readLogs``) and may be attached to bug
reports, so knowledge code logs ids only — never material or page titles,
folder names, transcript or chat text. An exception's message often carries
exactly that (a file path is ``Materials/<Folder>/<Title>/…``, conflicts name
the page), so errors are logged by type and code location, not by message.
"""
from __future__ import annotations

import traceback
from pathlib import Path

_FRAMES = 6


def error_note(error: BaseException) -> str:
    """``OSError at service.py:42 _settle < …`` (innermost first), with the causes' types; no messages."""
    parts: list[str] = []
    seen: set[int] = set()
    current: BaseException | None = error
    while current is not None and id(current) not in seen and len(parts) < 4:
        seen.add(id(current))
        frames = traceback.extract_tb(current.__traceback__)[-_FRAMES:]
        where = " < ".join(f"{Path(frame.filename).name}:{frame.lineno} {frame.name}"
                           for frame in reversed(frames))
        parts.append(type(current).__name__ + (f" at {where}" if where else ""))
        current = current.__cause__ or current.__context__
    return "; caused by ".join(parts)
