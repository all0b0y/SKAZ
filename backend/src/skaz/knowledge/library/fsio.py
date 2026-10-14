"""Atomic file publication: temp file + fsync + rename (+ fsync of the directory).

``rename_exclusive`` never replaces an existing entry (macOS ``renameatx_np``
with ``RENAME_EXCL``, Linux ``renameat2`` with ``RENAME_NOREPLACE``), so a
name taken between a check and the publish is refused by the kernel, not
overwritten. On a case-insensitive volume this also catches ``A`` vs ``a``.
"""
from __future__ import annotations

import ctypes
import errno
import json
import os
import sys
from pathlib import Path
from typing import Any
from uuid import uuid4

#: Finder writes these into any folder it opens; they never make a folder "non-empty".
IGNORABLE_ENTRIES = frozenset({".DS_Store"})


def fsync_dir(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _write_temp(directory: Path, data: bytes) -> Path:
    temp = directory / f".skaz-tmp-{uuid4().hex}"
    descriptor = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
    except BaseException:
        temp.unlink(missing_ok=True)
        raise
    return temp


def write_atomic(path: Path, data: bytes) -> None:
    """Replace ``path`` with complete bytes; a crash leaves the old or the new file."""
    temp = _write_temp(path.parent, data)
    try:
        os.replace(temp, path)
    except BaseException:
        temp.unlink(missing_ok=True)
        raise
    fsync_dir(path.parent)


def create_exclusive(path: Path, data: bytes) -> None:
    """Publish a new file; raises ``FileExistsError`` instead of replacing anything."""
    temp = _write_temp(path.parent, data)
    try:
        rename_exclusive(temp, path)
    except BaseException:
        temp.unlink(missing_ok=True)
        raise
    fsync_dir(path.parent)


def rename_exclusive(source: Path, target: Path) -> None:
    library = ctypes.CDLL(None, use_errno=True)
    if sys.platform == "darwin":
        function = getattr(library, "renameatx_np", None)
        at_fdcwd, flags = -2, 0x4  # RENAME_EXCL
    elif sys.platform.startswith("linux"):
        function = getattr(library, "renameat2", None)
        at_fdcwd, flags = -100, 0x1  # RENAME_NOREPLACE
    else:
        function, at_fdcwd, flags = None, 0, 0
    if function is None:
        raise OSError(errno.ENOTSUP, "Exclusive rename is unavailable on this platform.")
    function.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    function.restype = ctypes.c_int
    if function(at_fdcwd, os.fsencode(source), at_fdcwd, os.fsencode(target), flags) != 0:
        code = ctypes.get_errno()
        if code == errno.EEXIST:
            raise FileExistsError(code, "Target already exists.", str(target))
        raise OSError(code, os.strerror(code), str(target))


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def dump_json(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def visible_entries(path: Path) -> list[str]:
    return [name for name in os.listdir(path) if name not in IGNORABLE_ENTRIES]
