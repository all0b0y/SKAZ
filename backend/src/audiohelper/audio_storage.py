"""Atomic publication of original audio shared by file and streaming intake."""
from __future__ import annotations

import os
import sys
from contextlib import suppress
from pathlib import Path


def write_audio_file(path: Path, body: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".wav.part")
    try:
        with temporary.open("wb") as handle:
            handle.write(body)
            handle.flush()
            os.fsync(handle.fileno())
            if sys.platform == "darwin":
                import fcntl

                # macOS fsync alone need not flush the drive's volatile cache.
                fcntl.fcntl(handle.fileno(), fcntl.F_FULLFSYNC)
        temporary.replace(path)
        for directory in (path.parent, path.parent.parent):
            descriptor = os.open(directory, os.O_RDONLY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
    except OSError:
        with suppress(OSError):
            temporary.unlink(missing_ok=True)
        raise
