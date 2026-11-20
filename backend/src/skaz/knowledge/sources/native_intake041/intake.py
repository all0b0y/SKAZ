"""Standalone trusted intake orchestration for SKAZ 0.4.1 (DOCX, images incl. HEIC, and V3 formats)."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal, cast

from ...markdown.source import FragmentInput, Origin
from ..fragments import sanitize_title, to_fragments
from ..guard import Finding
from ..intake import (
    Original,
    Prepared,
    SourceRejected,
    flag_instructions,
    prepare_pdf,
    prepare_text_file,
)
from ..presentation import presentation_pdf
from .docx import extract_docx
from .formats import MAX_IMAGE_BYTES, ImageFormat, sniff_image_format
from .images import MAX_PREVIEW_EDGE, DecodedImageInfo, material_webp
from .trusted import (
    FILE_CHANGED_MESSAGE,
    TrustedFileSelection,
    ValidatedTrustedFile,
    read_bounded_bytes,
    validate_trusted_selection,
    verify_handle_version,
)

NativeMaterialKind = Literal["text", "pdf", "book", "docx", "image"]

_MIME_TO_IMAGE_FORMAT: dict[str, ImageFormat] = {
    "image/jpeg": "jpeg",
    "image/jpg": "jpeg",
    "image/png": "png",
    "image/webp": "webp",
    "image/heic": "heic",
}
_EXT_BY_IMAGE_FORMAT: dict[ImageFormat, str] = {
    "jpeg": ".jpg",
    "png": ".png",
    "webp": ".webp",
    "heic": ".heic",
}


@dataclass(frozen=True)
class NativeIntakePrepared:
    """Local typed intake output ready for later SourceService/bridge wiring without mutating V3."""

    kind: NativeMaterialKind
    title: str | None
    fallback_title: str
    fragments: tuple[FragmentInput, ...]
    findings: tuple[Finding, ...]
    origin: Origin
    extractor: str
    original: Original
    size_bytes: int
    sha256: str
    mime_type: str
    failure: str | None = None
    to_wiki: bool = False
    image_metadata: DecodedImageInfo | None = None
    v3_prepared: Prepared | None = None
    extra: dict[str, object] = field(default_factory=dict)


def _file_origin(validated: ValidatedTrustedFile, **extra_fields: object) -> Origin:
    payload: dict[str, object] = {
        "type": "file",
        "file_name": validated.selection.display_name,
        "sha256": validated.sha256,
        "mime_type": validated.classification.mime_type,
        "format": validated.classification.format_id,
        "size_bytes": validated.size_bytes,
        "selection_source": validated.selection.source,
        **extra_fields,
    }
    return Origin.model_validate(payload)


def _fallback_title(display_name: str, default: str) -> str:
    return sanitize_title(Path(display_name).stem) or default


def prepare_docx_selection(validated: ValidatedTrustedFile) -> NativeIntakePrepared:
    """Extract and guard a validated DOCX selection without extra file copies."""
    try:
        with validated.resolved_path.open("rb") as handle:
            verify_handle_version(
                handle,
                expected_size=validated.size_bytes,
                expected_sha256=validated.sha256,
            )
            extraction = extract_docx(handle)
            verify_handle_version(
                handle,
                expected_size=validated.size_bytes,
                expected_sha256=validated.sha256,
            )
    except OSError as error:
        raise SourceRejected("This file doesn't exist any more or can't be opened.") from error
    fragments = tuple(to_fragments(extraction.paragraphs))
    findings = tuple(flag_instructions(extraction.findings))
    origin = _file_origin(validated)
    return NativeIntakePrepared(
        kind="docx",
        title=extraction.title,
        fallback_title=_fallback_title(validated.selection.display_name, "Document"),
        fragments=fragments,
        findings=findings,
        origin=origin,
        extractor="docx",
        original=Original(
            "original.docx",
            path=validated.resolved_path,
            expected_size=validated.size_bytes,
            expected_sha256=validated.sha256,
        ),
        size_bytes=validated.size_bytes,
        sha256=validated.sha256,
        mime_type=validated.classification.mime_type,
        failure=extraction.failure,
        to_wiki=False,
        extra={
            "format": "docx",
            "hidden_runs_removed": extraction.hidden_runs_removed,
            "tables": extraction.table_count,
        },
    )


def decode_verified_image(
    validated: ValidatedTrustedFile,
    *,
    generate_preview: bool = False,
    max_preview_edge: int = MAX_PREVIEW_EDGE,
) -> DecodedImageInfo:
    """Decode the same bounded bytes that passed trusted selection verification."""
    data = read_bounded_bytes(validated.resolved_path, max_bytes=validated.classification.max_bytes)
    if len(data) != validated.size_bytes or hashlib.sha256(data).hexdigest() != validated.sha256:
        raise SourceRejected(FILE_CHANGED_MESSAGE)
    _, decoded = material_webp(
        data,
        cast(ImageFormat, validated.classification.format_id),
        generate_preview=generate_preview,
        max_preview_edge=max_preview_edge,
    )
    return decoded


def prepare_image_selection(
    validated: ValidatedTrustedFile,
    *,
    generate_preview: bool = False,
) -> NativeIntakePrepared:
    """Verify and decode a validated JPEG, PNG, WebP, or HEIC file (no OCR)."""
    data = read_bounded_bytes(validated.resolved_path, max_bytes=validated.classification.max_bytes)
    if len(data) != validated.size_bytes or hashlib.sha256(data).hexdigest() != validated.sha256:
        raise SourceRejected(FILE_CHANGED_MESSAGE)
    encoded, decoded = material_webp(
        data,
        cast(ImageFormat, validated.classification.format_id),
        generate_preview=generate_preview,
    )
    origin = _file_origin(
        validated,
        width=decoded.width,
        height=decoded.height,
        stored_sha256=hashlib.sha256(encoded).hexdigest(),
        ocr_performed=False,
    )
    return NativeIntakePrepared(
        kind="image",
        title=_fallback_title(validated.selection.display_name, "Image"),
        fallback_title=_fallback_title(validated.selection.display_name, "Image"),
        fragments=(),
        findings=(),
        origin=origin,
        extractor="image",
        original=Original("image.webp", data=encoded),
        size_bytes=validated.size_bytes,
        sha256=validated.sha256,
        mime_type=decoded.mime_type,
        failure=None,
        to_wiki=False,
        image_metadata=decoded,
        extra={
            "format": decoded.format_id,
            "width": decoded.width,
            "height": decoded.height,
            "pixel_format": decoded.pixel_format,
            "ocr_performed": False,
        },
    )


def prepare_trusted_selection(
    selection: TrustedFileSelection,
    *,
    data_dir: Path,
    generate_image_preview: bool = False,
) -> NativeIntakePrepared:
    """Validate an explicit trusted file selection and run format-appropriate local intake."""
    validated = validate_trusted_selection(selection, data_dir=data_dir)
    category = validated.classification.category

    if category == "speech":
        raise SourceRejected("Audio and video files must be added through the speech import.")

    if category == "docx":
        return prepare_docx_selection(validated)

    if category == "image":
        return prepare_image_selection(validated, generate_preview=generate_image_preview)

    if category in ("pdf", "presentation"):
        data = read_bounded_bytes(validated.resolved_path, max_bytes=validated.classification.max_bytes)
        if len(data) != validated.size_bytes or hashlib.sha256(data).hexdigest() != validated.sha256:
            raise SourceRejected(FILE_CHANGED_MESSAGE)
        if category == "presentation":
            data = presentation_pdf(data, validated.classification.extension)
        origin = _file_origin(validated)
        original = Original(
            "original.pdf",
            path=validated.resolved_path,
            expected_size=validated.size_bytes,
            expected_sha256=validated.sha256,
        )
        v3 = prepare_pdf(
            data,
            origin=origin,
            fallback=_fallback_title(validated.selection.display_name, "Document"),
            original=original,
        )
        return NativeIntakePrepared(
            kind=cast(NativeMaterialKind, v3.kind),
            title=v3.title,
            fallback_title=v3.fallback_title,
            fragments=tuple(v3.fragments),
            findings=tuple(v3.findings),
            origin=v3.origin,
            extractor=v3.extractor,
            original=v3.original or original,
            size_bytes=validated.size_bytes,
            sha256=validated.sha256,
            mime_type=validated.classification.mime_type,
            failure=v3.failure,
            to_wiki=False,
            v3_prepared=v3,
            extra=dict(v3.extra),
        )

    # category == "text"
    data = read_bounded_bytes(validated.resolved_path, max_bytes=validated.classification.max_bytes)
    origin = _file_origin(validated)
    v3 = prepare_text_file(data, validated.selection.display_name, origin=origin)
    if v3.failure:
        raise SourceRejected("This file has no text.")
    original = Original(
        f"original{validated.classification.extension}",
        path=validated.resolved_path,
        expected_size=validated.size_bytes,
        expected_sha256=validated.sha256,
    )
    return NativeIntakePrepared(
        kind=cast(NativeMaterialKind, v3.kind),
        title=v3.title,
        fallback_title=v3.fallback_title,
        fragments=tuple(v3.fragments),
        findings=tuple(v3.findings),
        origin=v3.origin,
        extractor=v3.extractor,
        original=original,
        size_bytes=validated.size_bytes,
        sha256=validated.sha256,
        mime_type=validated.classification.mime_type,
        failure=v3.failure,
        to_wiki=False,
        v3_prepared=v3,
        extra=dict(v3.extra),
    )


def prepare_clipboard_image(
    data: bytes,
    *,
    mime_type: str,
    file_name: str = "Screenshot",
    generate_preview: bool = False,
) -> NativeIntakePrepared:
    """Validate and decode bounded in-memory image bytes from a clipboard paste (no OCR)."""
    if not data:
        raise SourceRejected("The pasted image is empty.")
    if len(data) > MAX_IMAGE_BYTES:
        mb = MAX_IMAGE_BYTES // (1024 * 1024)
        raise SourceRejected(f"This image is larger than {mb} MB.")

    normalized_mime = mime_type.split(";", 1)[0].strip().lower()
    expected_format = _MIME_TO_IMAGE_FORMAT.get(normalized_mime)
    if expected_format is None:
        raise SourceRejected(f"Unsupported clipboard image type ({normalized_mime or 'unknown'}).")

    sniffed = sniff_image_format(data[:64])
    if sniffed != expected_format:
        raise SourceRejected(f"The pasted data doesn't match a valid {expected_format.upper()} image.")

    encoded, decoded = material_webp(data, expected_format, generate_preview=generate_preview)
    ext = _EXT_BY_IMAGE_FORMAT[expected_format]
    safe_base = sanitize_title(Path(file_name).stem) or "Screenshot"
    safe_name = f"{safe_base}{ext}"
    sha256 = hashlib.sha256(data).hexdigest()
    origin = Origin.model_validate(
        {
            "type": "file",
            "file_name": safe_name,
            "sha256": sha256,
            "stored_sha256": hashlib.sha256(encoded).hexdigest(),
            "mime_type": decoded.mime_type,
            "format": decoded.format_id,
            "size_bytes": len(data),
            "selection_source": "clipboard",
            "width": decoded.width,
            "height": decoded.height,
            "ocr_performed": False,
        }
    )
    return NativeIntakePrepared(
        kind="image",
        title=safe_base,
        fallback_title=safe_base,
        fragments=(),
        findings=(),
        origin=origin,
        extractor="image",
        original=Original("image.webp", data=encoded),
        size_bytes=len(data),
        sha256=sha256,
        mime_type=decoded.mime_type,
        failure=None,
        to_wiki=False,
        image_metadata=decoded,
        extra={
            "format": decoded.format_id,
            "width": decoded.width,
            "height": decoded.height,
            "pixel_format": decoded.pixel_format,
            "ocr_performed": False,
        },
    )
