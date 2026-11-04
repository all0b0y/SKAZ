"""Private temporary web text, indexed by characters without retaining the document in RAM."""
from __future__ import annotations

import codecs
import re
import shutil
import tempfile
import threading
from collections.abc import Callable, Iterator
from contextlib import ExitStack
from pathlib import Path
from typing import BinaryIO

from ..agents.tools import ToolInputError

IO_BYTES = 64 * 1024
INDEX_CHARS = 8_192
DISK_RESERVE_BYTES = 256 * 1024 * 1024


def check_space(directory: Path) -> None:
    if shutil.disk_usage(directory).free < DISK_RESERVE_BYTES:
        raise ToolInputError("Not enough temporary disk space to read this page. Free some space and retry.")


def page_file(directory: Path, owner: ExitStack) -> BinaryIO:
    """Register ownership before returning, including cancellation of an off-loop creation."""
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    check_space(directory)
    return owner.enter_context(tempfile.TemporaryFile(mode="w+b", dir=directory))


def write_bytes(file: BinaryIO, directory: Path, data: bytes) -> int:
    check_space(directory)
    return file.write(data)


def _encoding(source: BinaryIO, charset: str | None,
              check: Callable[[], None] | None = None) -> tuple[str, str]:
    source.seek(0)
    head = source.read(4096).decode("ascii", errors="ignore")
    declared = re.search(r"<meta[^>]+charset=[\"']?([\w-]+)", head, re.IGNORECASE)
    candidates = [charset] if charset else []
    if declared:
        candidates.append(declared.group(1))
    candidates += ["utf-8", "cp1251"]
    for encoding in candidates:
        try:
            decoder = codecs.getincrementaldecoder(encoding)(errors="strict")
            source.seek(0)
            while data := source.read(IO_BYTES):
                if check is not None:
                    check()
                decoder.decode(data)
            decoder.decode(b"", final=True)
        except (LookupError, UnicodeDecodeError):
            continue
        return encoding, "strict"
    return "utf-8", "replace"


def decoded_chunks(source: BinaryIO, charset: str | None, *,
                   check: Callable[[], None] | None = None) -> Iterator[str]:
    """The same declared/meta/UTF-8/cp1251 preference as decode_html, in bounded buffers."""
    encoding, errors = _encoding(source, charset, check)
    decoder = codecs.getincrementaldecoder(encoding)(errors=errors)
    source.seek(0)
    while data := source.read(IO_BYTES):
        if check is not None:
            check()
        yield decoder.decode(data)
    tail = decoder.decode(b"", final=True)
    if tail:
        yield tail


class CheckedPageFile:
    """libxml reads through this callback so cancellation/deadline checks run between buffers."""

    def __init__(self, source: BinaryIO, check: Callable[[], None]) -> None:
        self.source, self.check = source, check

    def read(self, size: int = -1) -> bytes:
        self.check()
        return self.source.read(IO_BYTES if size < 0 else min(size, IO_BYTES))


class WebText:
    """Immutable after preparation; file operations are serialized with eviction's close."""

    def __init__(self, file: BinaryIO, directory: Path) -> None:
        self._file = file
        self._directory = directory
        self._lock = threading.Lock()
        self._index = [0]
        self._written = 0
        self.length = 0

    def add(self, text: str) -> None:
        if not self._written:
            text = text.lstrip()
        start = 0
        while start < len(text):
            end = min(len(text), start + INDEX_CHARS - self._written % INDEX_CHARS)
            piece = text[start:end]
            write_bytes(self._file, self._directory, piece.encode("utf-8"))
            self._written += len(piece)
            if visible := piece.rstrip():
                self.length = self._written - len(piece) + len(visible)
            if self._written % INDEX_CHARS == 0:
                self._index.append(self._file.tell())
            start = end

    def finish(self) -> None:
        self._file.flush()

    def read(self, offset: int, count: int) -> str:
        with self._lock:
            if self._file.closed:
                raise ToolInputError("That page snapshot is no longer available. Start again at offset zero.")
            if offset >= self.length:
                return ""
            block, within = divmod(offset, INDEX_CHARS)
            self._file.seek(self._index[block])
            count = min(count, self.length - offset)
            # Starting at a complete UTF-8 character, four bytes per requested character suffice.
            # Ignore only an incomplete character AFTER the requested range.
            text = self._file.read((within + count) * 4).decode("utf-8", errors="ignore")
            return text[within:within + count]

    def close(self) -> None:
        with self._lock:
            self._file.close()
