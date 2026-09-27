"""Atomic publication of original audio shared by file and streaming intake."""
from __future__ import annotations

import os
import sys
from contextlib import suppress
from pathlib import Path
from uuid import uuid4

from .session_files import _digest_at, _directory, _rename_at


def write_audio_file(path: Path, body: bytes) -> None:
    import hashlib

    with _directory(path.absolute().parent) as directory:
        expected = hashlib.sha256(body).hexdigest()
        current = _digest_at(directory, path.name)
        if current is not None:
            if current == expected:
                return
            raise OSError("Audio destination already contains different bytes.")
        temporary = f".{path.name}.{uuid4().hex}.part"
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600, dir_fd=directory)
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(body)
                handle.flush()
                os.fsync(handle.fileno())
                if sys.platform == "darwin":
                    import fcntl
                    fcntl.fcntl(handle.fileno(), fcntl.F_FULLFSYNC)
            _rename_at(directory, temporary, path.name, exchange=False)
            os.fsync(directory)
        finally:
            with suppress(FileNotFoundError):
                os.unlink(temporary, dir_fd=directory)
                os.fsync(directory)
