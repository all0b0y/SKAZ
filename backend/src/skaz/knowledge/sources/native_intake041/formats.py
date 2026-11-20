"""Standalone file-format classification and magic-header checks for SKAZ 0.4.1 native intake."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from ..intake import (
    PDF_EXTENSIONS as PDF_EXTENSIONS,
)
from ..intake import (
    PRESENTATION_EXTENSIONS,
    SourceRejected,
)
from ..intake import (
    TEXT_EXTENSIONS as TEXT_EXTENSIONS,
)

DOCX_EXTENSIONS: frozenset[str] = frozenset({".docx"})
IMAGE_EXTENSIONS: frozenset[str] = frozenset({".jpg", ".jpeg", ".png", ".webp", ".heic"})
AUDIO_EXTENSIONS: frozenset[str] = frozenset(
    {".aac", ".aiff", ".amr", ".asf", ".flac", ".m4a", ".mp3", ".mp4", ".ogg", ".wav", ".webm"}
)
VIDEO_EXTENSIONS: frozenset[str] = frozenset({".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi"})
SPEECH_EXTENSIONS: frozenset[str] = AUDIO_EXTENSIONS | VIDEO_EXTENSIONS
DOCUMENT_EXTENSIONS: frozenset[str] = (
    TEXT_EXTENSIONS | PDF_EXTENSIONS | DOCX_EXTENSIONS | PRESENTATION_EXTENSIONS
)
SUPPORTED_MATERIAL_EXTENSIONS: frozenset[str] = DOCUMENT_EXTENSIONS | IMAGE_EXTENSIONS | SPEECH_EXTENSIONS

MAX_TEXT_BYTES = 64 * 1024 * 1024
MAX_PDF_BYTES = 200 * 1024 * 1024
MAX_DOCX_BYTES = 64 * 1024 * 1024
MAX_IMAGE_BYTES = 32 * 1024 * 1024
MAX_SPEECH_BYTES = 2 * 1024 * 1024 * 1024
HEADER_SNIFF_BYTES = 64

IntakeCategory = Literal["text", "pdf", "docx", "presentation", "image", "speech"]
IntakeRoute = Literal["document", "image", "speech"]
ImageFormat = Literal["jpeg", "png", "webp", "heic"]
ContainerFormat = Literal["pdf", "zip", "jpeg", "png", "webp", "heic"]

_HEIC_BRANDS: frozenset[bytes] = frozenset({b"heic", b"heix", b"hevc", b"hevx", b"mif1", b"msf1"})

_IMAGE_META: dict[str, tuple[ImageFormat, str]] = {
    ".jpg": ("jpeg", "image/jpeg"),
    ".jpeg": ("jpeg", "image/jpeg"),
    ".png": ("png", "image/png"),
    ".webp": ("webp", "image/webp"),
    ".heic": ("heic", "image/heic"),
}

_SPEECH_MIME: dict[str, str] = {
    ".aac": "audio/aac",
    ".aiff": "audio/aiff",
    ".amr": "audio/amr",
    ".asf": "video/x-ms-asf",
    ".avi": "video/x-msvideo",
    ".flac": "audio/flac",
    ".m4a": "audio/mp4",
    ".m4v": "video/x-m4v",
    ".mkv": "video/x-matroska",
    ".mov": "video/quicktime",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
    ".ogg": "audio/ogg",
    ".wav": "audio/wav",
    ".webm": "video/webm",
}


@dataclass(frozen=True)
class FileClassification:
    """Normalized format classification for one trusted material selection."""

    category: IntakeCategory
    route: IntakeRoute
    format_id: str
    extension: str
    mime_type: str
    max_bytes: int
    is_new_041: bool


def classify_extension(path_or_name: str | Path) -> FileClassification:
    """Classify a file by its extension or raise ``SourceRejected`` if unsupported."""
    suffix = Path(path_or_name).suffix.lower()
    if suffix in TEXT_EXTENSIONS:
        is_md = suffix in (".md", ".markdown")
        return FileClassification(
            category="text",
            route="document",
            format_id="markdown" if is_md else "txt",
            extension=suffix,
            mime_type="text/markdown" if is_md else "text/plain",
            max_bytes=MAX_TEXT_BYTES,
            is_new_041=False,
        )
    if suffix in PDF_EXTENSIONS:
        return FileClassification(
            category="pdf",
            route="document",
            format_id="pdf",
            extension=suffix,
            mime_type="application/pdf",
            max_bytes=MAX_PDF_BYTES,
            is_new_041=False,
        )
    if suffix in PRESENTATION_EXTENSIONS:
        mime = ("application/vnd.openxmlformats-officedocument.presentationml.presentation"
                if suffix == ".pptx" else "application/vnd.apple.keynote")
        return FileClassification("presentation", "document", suffix[1:], suffix, mime, MAX_PDF_BYTES, True)
    if suffix in DOCX_EXTENSIONS:
        return FileClassification(
            category="docx",
            route="document",
            format_id="docx",
            extension=suffix,
            mime_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            max_bytes=MAX_DOCX_BYTES,
            is_new_041=True,
        )
    if suffix in _IMAGE_META:
        image_format, mime = _IMAGE_META[suffix]
        return FileClassification(
            category="image",
            route="image",
            format_id=image_format,
            extension=suffix,
            mime_type=mime,
            max_bytes=MAX_IMAGE_BYTES,
            is_new_041=True,
        )
    if suffix in SPEECH_EXTENSIONS:
        return FileClassification(
            category="speech",
            route="speech",
            format_id=suffix.lstrip("."),
            extension=suffix,
            mime_type=_SPEECH_MIME[suffix],
            max_bytes=MAX_SPEECH_BYTES,
            is_new_041=False,
        )
    kind = f"{suffix} files" if suffix else "files without an extension"
    raise SourceRejected(
        f"SKAZ can't read {kind}. It adds PDF, Markdown (.md), text (.txt), DOCX, "
        "images (JPEG, PNG, WebP, HEIC), and audio or video files."
    )


def sniff_image_format(head: bytes) -> ImageFormat | None:
    """Identify JPEG, PNG, WebP, or HEIC from leading header bytes without guessing from names."""
    if len(head) >= 3 and head[:3] == b"\xff\xd8\xff":
        return "jpeg"
    if len(head) >= 8 and head[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if len(head) >= 12 and head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    if len(head) >= 12 and head[4:8] == b"ftyp":
        box_size = int.from_bytes(head[:4], "big")
        if box_size == 0 or box_size >= 12:
            limit = len(head) if box_size == 0 else min(len(head), box_size)
            major = head[8:12]
            if major in _HEIC_BRANDS:
                return "heic"
            # Check compatible brands starting at byte 16 (bytes 12..16 are minor_version).
            for offset in range(16, limit - 3, 4):
                if head[offset : offset + 4] in _HEIC_BRANDS:
                    return "heic"
    return None


def sniff_container_format(head: bytes) -> ContainerFormat | None:
    """Identify PDF, ZIP (for DOCX), or supported image containers from leading bytes."""
    if head.startswith(b"%PDF-"):
        return "pdf"
    if len(head) >= 4 and head[:4] in (b"PK\x03\x04", b"PK\x05\x06"):
        return "zip"
    return sniff_image_format(head)


def verify_magic_header(head: bytes, classification: FileClassification) -> None:
    """Verify that the leading bytes match ``classification``; reject spoofed/corrupt headers."""
    if not head:
        raise SourceRejected("This file is empty.")
    if classification.category == "pdf":
        if not head.startswith(b"%PDF-"):
            raise SourceRejected("This file isn't a valid PDF document.")
        return
    if classification.category in ("docx", "presentation"):
        if len(head) < 4 or head[:4] not in (b"PK\x03\x04", b"PK\x05\x06"):
            raise SourceRejected(f"This file isn't a valid {classification.format_id.upper()} document.")
        return
    if classification.category == "image":
        detected = sniff_image_format(head)
        if detected != classification.format_id:
            label = classification.format_id.upper()
            raise SourceRejected(f"This file doesn't match a valid {label} image.")
        return
    if classification.category == "text":
        if head.startswith((b"\xff\xfe", b"\xfe\xff")):
            return
        if b"\x00" in head:
            raise SourceRejected("This isn't a text file. SKAZ reads .txt and .md files that hold text.")
