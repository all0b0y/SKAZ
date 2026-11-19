"""Explicit trusted file selections and bounded disk reads for SKAZ 0.4.1."""

from __future__ import annotations

import hashlib
import os
import stat
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO, Literal

from ..intake import SourceRejected
from ..paths import given_path, resolved_file
from .formats import (
    HEADER_SNIFF_BYTES,
    FileClassification,
    classify_extension,
    verify_magic_header,
)

SelectionSource = Literal["picker", "drop", "clipboard"]
_READ_CHUNK_BYTES = 1 << 20  # 1 MiB
_HEX_CHARS = frozenset("0123456789abcdef")
FILE_CHANGED_MESSAGE = (
    "The selected file changed after it was chosen. Choose the file again to preview or add it."
)


@dataclass(frozen=True)
class TrustedFileSelection:
    """An explicit file selection handed from Electron main/picker/drop to backend intake."""

    path: Path
    display_name: str
    source: SelectionSource = "picker"
    selection_id: str | None = None
    expected_size: int | None = None
    expected_sha256: str | None = None

    @classmethod
    def from_raw(
        cls,
        path: str | Path,
        *,
        display_name: str | None = None,
        source: SelectionSource = "picker",
        selection_id: str | None = None,
        expected_size: int | None = None,
        expected_sha256: str | None = None,
    ) -> TrustedFileSelection:
        checked = given_path(path, SourceRejected)
        name = display_name.strip() if display_name else checked.name
        if not name or "/" in name or "\\" in name or "\x00" in name:
            raise SourceRejected("Invalid selected file name.")
        normalized_sha: str | None = None
        if expected_sha256 is not None:
            candidate = expected_sha256.strip().lower()
            if len(candidate) != 64 or any(ch not in _HEX_CHARS for ch in candidate):
                raise SourceRejected("Invalid expected file version.")
            normalized_sha = candidate
        return cls(
            path=checked,
            display_name=name,
            source=source,
            selection_id=selection_id,
            expected_size=expected_size,
            expected_sha256=normalized_sha,
        )


@dataclass(frozen=True)
class ValidatedTrustedFile:
    """A verified, bounded, hashed file ready for format-specific extraction without extra copies."""

    selection: TrustedFileSelection
    resolved_path: Path
    classification: FileClassification
    size_bytes: int
    sha256: str
    head: bytes


def _too_large_message(limit_bytes: int) -> str:
    mb = max(1, limit_bytes // (1024 * 1024))
    return f"This file is larger than {mb} MB."


def read_bounded_bytes(path: Path, *, max_bytes: int) -> bytes:
    """Read a regular file up to ``max_bytes`` without loading unbounded data into RAM."""
    if max_bytes <= 0:
        raise ValueError("max_bytes must be positive")
    chunks: list[bytes] = []
    total = 0
    try:
        with path.open("rb") as handle:
            info = os.fstat(handle.fileno())
            if not stat.S_ISREG(info.st_mode):
                raise SourceRejected("Choose a regular file.")
            if info.st_size > max_bytes:
                raise SourceRejected(_too_large_message(max_bytes))
            while True:
                chunk = handle.read(min(_READ_CHUNK_BYTES, max_bytes - total + 1))
                if not chunk:
                    break
                total += len(chunk)
                if total > max_bytes:
                    raise SourceRejected(_too_large_message(max_bytes))
                chunks.append(chunk)
    except OSError as error:
        raise SourceRejected("This file doesn't exist any more or can't be opened.") from error
    if total == 0:
        raise SourceRejected("This file is empty.")
    return b"".join(chunks) if len(chunks) > 1 else chunks[0]


def validate_trusted_selection(
    selection: TrustedFileSelection,
    *,
    data_dir: Path,
) -> ValidatedTrustedFile:
    """Validate path access, extension, magic header, and byte bounds for an explicit selection."""
    if not isinstance(selection, TrustedFileSelection):
        raise SourceRejected("An explicit trusted file selection is required.")
    checked_path = given_path(selection.path, SourceRejected)
    classification = classify_extension(checked_path)
    resolved_path, _info = resolved_file(checked_path, data_dir, SourceRejected)

    digest = hashlib.sha256()
    head = bytearray()
    total = 0
    limit = classification.max_bytes

    try:
        with resolved_path.open("rb") as handle:
            finfo = os.fstat(handle.fileno())
            if not stat.S_ISREG(finfo.st_mode):
                raise SourceRejected("Choose a regular file.")
            if finfo.st_size > limit:
                raise SourceRejected(_too_large_message(limit))
            if selection.expected_size is not None and finfo.st_size != selection.expected_size:
                raise SourceRejected(FILE_CHANGED_MESSAGE)
            while True:
                chunk = handle.read(_READ_CHUNK_BYTES)
                if not chunk:
                    break
                total += len(chunk)
                if total > limit:
                    raise SourceRejected(_too_large_message(limit))
                if len(head) < HEADER_SNIFF_BYTES:
                    need = HEADER_SNIFF_BYTES - len(head)
                    head.extend(chunk[:need])
                digest.update(chunk)
    except OSError as error:
        raise SourceRejected("This file doesn't exist any more or can't be opened.") from error

    if total == 0:
        raise SourceRejected("This file is empty.")
    if selection.expected_size is not None and total != selection.expected_size:
        raise SourceRejected(FILE_CHANGED_MESSAGE)
    sha256 = digest.hexdigest()
    if selection.expected_sha256 is not None and sha256 != selection.expected_sha256.lower():
        raise SourceRejected(FILE_CHANGED_MESSAGE)

    head_bytes = bytes(head)
    verify_magic_header(head_bytes, classification)

    return ValidatedTrustedFile(
        selection=selection,
        resolved_path=resolved_path,
        classification=classification,
        size_bytes=total,
        sha256=sha256,
        head=head_bytes,
    )


def verify_handle_version(
    handle: BinaryIO,
    *,
    expected_size: int,
    expected_sha256: str,
) -> None:
    """Verify an already-open binary file handle matches ``expected_size`` and ``expected_sha256``."""
    try:
        handle.seek(0)
        finfo = os.fstat(handle.fileno())
        if not stat.S_ISREG(finfo.st_mode):
            raise SourceRejected("Choose a regular file.")
        if finfo.st_size != expected_size:
            raise SourceRejected(FILE_CHANGED_MESSAGE)
        digest = hashlib.sha256()
        total = 0
        while True:
            chunk = handle.read(_READ_CHUNK_BYTES)
            if not chunk:
                break
            total += len(chunk)
            if total > expected_size:
                raise SourceRejected(FILE_CHANGED_MESSAGE)
            digest.update(chunk)
    except OSError as error:
        raise SourceRejected("This file doesn't exist any more or can't be opened.") from error
    if total != expected_size or digest.hexdigest() != expected_sha256.lower():
        raise SourceRejected(FILE_CHANGED_MESSAGE)
    handle.seek(0)
