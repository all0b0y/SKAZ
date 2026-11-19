"""Visual source preparation for V1/V4 (01-LOCAL-VISUAL-PROCESSING decisions 1, 2, 3, 1.4, 1.5, 1.6).

* **Source images:** validated through authorized paths (``given_path`` + ``resolved_file`` against
  ``kb.data_dir``) and magic-byte header checks (PNG, JPEG, WebP, GIF) within ``MAX_IMAGE_BYTES``.
* **PDF pages on demand:** selected from ``.skaz/original.pdf`` without mass rendering at import or
  permanent PNG files. Explicit page numbers/ranges take priority; otherwise non-excluded fragments
  are searched by headings, captions and visible text. Unlocatable scans ask for a page or short range.
* **Video frames:** local video files stay audio-only (``local_video_audio_only``). For permitted
  linked video sources (validated through ``media_source.video_source``), only the requested frames
  are retrieved with their actual timestamps; when unsupported, timestamp navigation or user-supplied
  images are offered instead.
* **Frame retention:** no source permits retention by default. Only frames cited in an answer or
  manually pinned by the user are persisted to ``.skaz/frames/`` and ``.skaz/frames.json``, and only
  when the source's policy permits both retrieval and retention.
"""

from __future__ import annotations

import inspect
import os
import re
import shutil
import stat
import struct
import subprocess
import tempfile
import threading
import zlib
from collections.abc import Awaitable, Callable, Collection, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from ...media_source import InvalidMediaSource, VideoPlatform, VideoSource, video_source
from ..errors import KnowledgeError, NotFound
from ..ids import utc_now
from ..library.fsio import dump_json, read_json, write_atomic
from ..library.layout import SERVICE_DIR
from ..library.library import MaterialFiles
from ..markdown.source import Fragment
from ..service import KnowledgeService
from .duplicates import content_hash
from .guard.exclusions import EXCLUDED_FILE, ExclusionFile
from .links import VIDEO_EXTENSIONS
from .material_info import read_intake
from .paths import given_path, resolved_file
from .pdf import PdfRejected, open_pdf, pdf_raster_inputs

LOCATOR_VERSION: Literal[1] = 1
IMAGE_EXTENSIONS: frozenset[str] = frozenset({".png", ".jpg", ".jpeg", ".webp", ".gif"})
MAX_IMAGE_BYTES = 32 * 1024 * 1024
MAX_SELECTED_PDF_PAGES = 6
DEFAULT_SEARCH_PDF_PAGES = 3
MAX_REQUESTED_VIDEO_FRAMES = 4
FRAMES_DIR = "frames"
FRAMES_INDEX_FILE = "frames.json"

LOCAL_VIDEO_AUDIO_ONLY_NOTICE = "SKAZ transcribes the audio only. It doesn’t save the video or its frames."
TEXT_ONLY_DISCLOSURE = "Text only · Image not analysed"
PDF_TEXT_AVAILABLE = "The PDF text is still available."
VIDEO_TRANSCRIPT_AVAILABLE = "The video transcript is still available."
NO_SOURCE_TEXT_AVAILABLE = "This attachment has no text to use instead."

VisualSourceKind = Literal["image", "pdf_page", "video_frame"]
VisualMediaType = Literal["image/png", "image/jpeg", "image/webp", "image/gif"]
FrameRetentionReason = Literal["cited", "pinned"]
VisualUnsupportedReason = Literal[
    "local_video_audio_only",
    "page_range_required",
    "page_out_of_range",
    "pdf_render_unavailable",
    "video_frames_unsupported",
    "retention_not_permitted",
    "unauthorized_path",
    "unsupported_image_format",
    "oversized_image",
    "source_not_found",
]

_MEDIA_EXTENSION: dict[VisualMediaType, str] = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
}


class VisualSourceLocator(BaseModel):
    """Versioned source locator binding a prepared visual to its origin (V1/V4 seam)."""

    model_config = ConfigDict(frozen=True, extra="forbid")
    version: Literal[1] = LOCATOR_VERSION
    kind: VisualSourceKind
    material_id: str | None = None
    source_sha256: str | None = None
    source_url: str | None = None
    navigation_url: str | None = None
    page: int | None = Field(default=None, ge=1)
    timestamp_ms: int | None = Field(default=None, ge=0)
    requested_timestamp_ms: int | None = Field(default=None, ge=0)
    file_name: str | None = None


@dataclass(frozen=True)
class ImageHeader:
    media_type: VisualMediaType
    width: int
    height: int


@dataclass(frozen=True)
class PreparedVisual:
    """Authorized image bytes and versioned locator prepared for the selected harness."""

    locator: VisualSourceLocator
    data: bytes
    media_type: VisualMediaType
    width: int
    height: int
    sha256: str
    retention_permitted: bool = False

    @property
    def page(self) -> int | None:
        return self.locator.page

    @property
    def timestamp_ms(self) -> int | None:
        return self.locator.timestamp_ms

    @property
    def requested_timestamp_ms(self) -> int | None:
        return self.locator.requested_timestamp_ms

    @property
    def navigation_url(self) -> str | None:
        return self.locator.navigation_url


@dataclass(frozen=True)
class VisualFallbackSeam:
    """Verified payload/error seam for V4 (decisions 1.5, 1.6, UI-B card above composer)."""

    ok: bool
    items: tuple[PreparedVisual, ...] = ()
    reason: VisualUnsupportedReason | None = None
    message: str | None = None
    locator: VisualSourceLocator | None = None
    navigation_url: str | None = None
    allow_user_supplied_image: bool = False
    ask_page_range: bool = False
    page_count: int | None = None
    has_source_text: bool = False
    text_fallback_detail: str = NO_SOURCE_TEXT_AVAILABLE
    text_only_disclosure: str = TEXT_ONLY_DISCLOSURE

    @classmethod
    def success(
        cls,
        items: Sequence[PreparedVisual],
        *,
        has_source_text: bool = False,
        text_fallback_detail: str = NO_SOURCE_TEXT_AVAILABLE,
    ) -> VisualFallbackSeam:
        return cls(
            ok=True,
            items=tuple(items),
            has_source_text=has_source_text,
            text_fallback_detail=text_fallback_detail,
        )


class VisualSourceUnsupported(KnowledgeError):
    """Typed refusal when a visual source cannot be prepared or persisted."""

    status_code = 422

    def __init__(
        self,
        reason: VisualUnsupportedReason,
        message: str,
        *,
        locator: VisualSourceLocator | None = None,
        navigation_url: str | None = None,
        allow_user_supplied_image: bool = False,
        ask_page_range: bool = False,
        page_count: int | None = None,
        has_source_text: bool = False,
        text_fallback_detail: str = NO_SOURCE_TEXT_AVAILABLE,
    ) -> None:
        super().__init__(message)
        self.reason = reason
        self.locator = locator
        self.navigation_url = navigation_url
        self.allow_user_supplied_image = allow_user_supplied_image
        self.ask_page_range = ask_page_range
        self.page_count = page_count
        self.has_source_text = has_source_text
        self.text_fallback_detail = text_fallback_detail

    def to_seam(self) -> VisualFallbackSeam:
        return VisualFallbackSeam(
            ok=False,
            reason=self.reason,
            message=self.message,
            locator=self.locator,
            navigation_url=self.navigation_url,
            allow_user_supplied_image=self.allow_user_supplied_image,
            ask_page_range=self.ask_page_range,
            page_count=self.page_count,
            has_source_text=self.has_source_text,
            text_fallback_detail=self.text_fallback_detail,
        )


@dataclass(frozen=True)
class LinkedFramePolicy:
    """Whether a linked video source permits on-demand frame retrieval and frame retention.

    No source permits retrieval or retention by default (01 decisions 3 and 1.4).
    """

    retrieval_permitted: bool = False
    retention_permitted: bool = False


DEFAULT_FRAME_POLICY = LinkedFramePolicy(retrieval_permitted=False, retention_permitted=False)


@dataclass(frozen=True)
class RetrievedFrame:
    """One video frame returned by a source-permitted retriever with its actual timestamp."""

    data: bytes
    actual_timestamp_ms: int
    requested_timestamp_ms: int | None = None


class RetainedFrameRecord(BaseModel):
    """Persisted metadata for one cited or manually pinned linked-video frame."""

    model_config = ConfigDict(frozen=True, extra="forbid")
    frame_id: str
    locator: VisualSourceLocator
    file_name: str
    media_type: VisualMediaType
    sha256: str
    width: int = Field(ge=1)
    height: int = Field(ge=1)
    retained_because: tuple[FrameRetentionReason, ...]
    citation_refs: tuple[str, ...] = ()
    created_at: str


class RetainedFramesFile(BaseModel):
    """``.skaz/frames.json``."""

    model_config = ConfigDict(extra="forbid")
    format: Literal[1] = 1
    frames: list[RetainedFrameRecord] = Field(default_factory=list)


PdfPageRenderer = Callable[[bytes, int], bytes]
FrameRetrieverResult = Sequence[RetrievedFrame] | Awaitable[Sequence[RetrievedFrame]]
FrameRetriever = Callable[[VideoSource, tuple[int, ...]], FrameRetrieverResult]
FramePolicyConfig = (
    LinkedFramePolicy
    | Mapping[VideoPlatform, LinkedFramePolicy]
    | Callable[[VideoSource], LinkedFramePolicy]
)


# -- Pure-Python PNG encoding and image header inspection -----------------------


def _png_chunk(tag: bytes, payload: bytes) -> bytes:
    crc = zlib.crc32(tag + payload) & 0xFFFFFFFF
    return struct.pack(">I", len(payload)) + tag + payload + struct.pack(">I", crc)


def encode_png_rgb(width: int, height: int, rgb: bytes) -> bytes:
    """Encode raw 8-bit RGB bytes (``width * height * 3``) into a valid PNG image."""
    if width <= 0 or height <= 0 or len(rgb) != width * height * 3:
        raise ValueError("Invalid RGB buffer dimensions for PNG encoding.")
    stride = width * 3
    scanlines = b"".join(b"\x00" + rgb[row * stride : (row + 1) * stride] for row in range(height))
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + _png_chunk(b"IHDR", ihdr)
        + _png_chunk(b"IDAT", zlib.compress(scanlines, level=6))
        + _png_chunk(b"IEND", b"")
    )


def _jpeg_dimensions(data: bytes) -> tuple[int, int] | None:
    if len(data) < 4 or not data.startswith(b"\xff\xd8\xff"):
        return None
    offset = 2
    sof_markers = {
        0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF,
    }
    while offset < len(data) - 1:
        if data[offset] != 0xFF:
            offset += 1
            continue
        while offset < len(data) and data[offset] == 0xFF:
            offset += 1
        if offset >= len(data):
            break
        marker = data[offset]
        offset += 1
        if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
            continue
        if offset + 2 > len(data):
            return None
        segment_len = struct.unpack(">H", data[offset : offset + 2])[0]
        if segment_len < 2 or offset + segment_len > len(data):
            return None
        if marker in sof_markers:
            if segment_len < 7:
                return None
            height, width = struct.unpack(">HH", data[offset + 3 : offset + 7])
            return (width, height) if width > 0 and height > 0 else None
        offset += segment_len
    return None


def _webp_dimensions(data: bytes) -> tuple[int, int] | None:
    if len(data) < 21 or data[:4] != b"RIFF" or data[8:12] != b"WEBP":
        return None
    chunk = data[12:16]
    if chunk == b"VP8 " and len(data) >= 30:
        if data[23:26] != b"\x9d\x01\x2a":
            return None
        raw_w, raw_h = struct.unpack("<HH", data[26:30])
        width, height = raw_w & 0x3FFF, raw_h & 0x3FFF
        return (width, height) if width > 0 and height > 0 else None
    if chunk == b"VP8L" and len(data) >= 25:
        if data[20] != 0x2F:
            return None
        bits = struct.unpack("<I", data[21:25])[0]
        width = (bits & 0x3FFF) + 1
        height = ((bits >> 14) & 0x3FFF) + 1
        return (width, height) if width > 0 and height > 0 else None
    if chunk == b"VP8X" and len(data) >= 30:
        width = int.from_bytes(data[24:27], "little") + 1
        height = int.from_bytes(data[27:30], "little") + 1
        return (width, height) if width > 0 and height > 0 else None
    return None


def inspect_image_bytes(data: bytes, *, max_bytes: int = MAX_IMAGE_BYTES) -> ImageHeader:
    """Validate image magic bytes, header dimensions and size limit."""
    if len(data) > max_bytes:
        raise VisualSourceUnsupported(
            "oversized_image",
            f"This image is larger than {max_bytes // (1024 * 1024)} MB.",
        )
    if len(data) >= 24 and data.startswith(b"\x89PNG\r\n\x1a\n") and data[12:16] == b"IHDR":
        width, height = struct.unpack(">II", data[16:24])
        if width > 0 and height > 0:
            return ImageHeader("image/png", int(width), int(height))
    if data.startswith(b"\xff\xd8\xff"):
        dims = _jpeg_dimensions(data)
        if dims is not None:
            return ImageHeader("image/jpeg", dims[0], dims[1])
    if len(data) >= 10 and data[:6] in (b"GIF87a", b"GIF89a"):
        width, height = struct.unpack("<HH", data[6:10])
        if width > 0 and height > 0:
            return ImageHeader("image/gif", int(width), int(height))
    if len(data) >= 16 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        dims = _webp_dimensions(data)
        if dims is not None:
            return ImageHeader("image/webp", dims[0], dims[1])
    raise VisualSourceUnsupported(
        "unsupported_image_format",
        "SKAZ can only prepare valid PNG, JPEG, WebP or GIF images.",
    )


# -- Query parsing for explicit PDF pages and video timestamps ------------------


_PAGE_NUMBER = r"\d{1,12}\b"
_PAGE_ITEM = rf"#?({_PAGE_NUMBER})(?:\s*(?:[-–—]|to|по)\s*#?({_PAGE_NUMBER}))?"
_FIRST_PAGE = re.compile(
    r"\b(?:pages?|pp?\.?|slides?|стр(?:аниц(?:ах|[аыеу]))?\.?|с\.|слайд(?:ах|ов|[еыу])?)\s*"
    + _PAGE_ITEM, re.IGNORECASE,
)
_PAGE_CONJUNCTION = r"(?:(?:and|и)\s+|&\s*)"
_NEXT_PAGE = re.compile(
    rf"\s*(?:,\s*{_PAGE_CONJUNCTION}?|{_PAGE_CONJUNCTION})" + _PAGE_ITEM, re.IGNORECASE,
)
_TIMESTAMP_RE = re.compile(r"\b(?:(\d{1,2}):)?([0-5]?\d):([0-5]\d)\b")
_WORD_RE = re.compile(r"[A-Za-zА-Яа-яЁё0-9]{2,}")
_STOP_WORDS = frozenset({
    "the", "and", "for", "with", "that", "this", "from", "what", "does", "show", "shows",
    "explain", "about", "into", "over", "under", "page", "pages", "slide", "slides",
    "что", "как", "где", "это", "этот", "этом", "этой", "для", "или", "при", "покажи",
    "объясни", "показывает", "странице", "страница", "стр", "слайд", "видео",
})
_CAPTION_WORDS = frozenset({
    "figure", "fig", "table", "chart", "diagram", "graph", "slide", "plot", "illustration",
    "рисунок", "рис", "таблица", "график", "диаграмма", "схема", "слайд", "табл",
})


def _explicit_page_range(start: int, end: int) -> list[int]:
    # For an over-limit range preserve both endpoints for bounds checks and enough
    # distinct pages for count rejection, regardless of its numeric span.
    step = 1 if start <= end else -1
    span = min(abs(end - start), MAX_SELECTED_PDF_PAGES)
    pages = [start + step * offset for offset in range(span + 1)]
    if pages[-1] != end:
        pages.append(end)
    return pages


def parse_explicit_pages(query: str | None) -> list[int]:
    """Extract 1-based page numbers and ranges explicitly named in ``query``, preserving order."""
    if not query:
        return []
    found: dict[int, None] = {}
    for first in _FIRST_PAGE.finditer(query):
        item: re.Match[str] | None = first
        while item is not None:
            start = int(item[1])
            end = int(item[2]) if item[2] is not None else start
            for page in _explicit_page_range(start, end):
                found[page] = None
            item = _NEXT_PAGE.match(query, item.end())
    return list(found)


def parse_timestamps_ms(query: str | None) -> list[int]:
    """Extract ``mm:ss`` and ``hh:mm:ss`` timestamps mentioned in ``query`` as milliseconds."""
    if not query:
        return []
    found: list[int] = []
    for match in _TIMESTAMP_RE.finditer(query):
        hours = int(match.group(1)) if match.group(1) is not None else 0
        minutes = int(match.group(2))
        seconds = int(match.group(3))
        ms = ((hours * 3600) + (minutes * 60) + seconds) * 1000
        if ms not in found:
            found.append(ms)
    return found


def video_timestamp_url(url: str, timestamp_ms: int | None) -> str:
    """Canonical single-video URL that opens at ``timestamp_ms`` on supported hosts."""
    source = video_source(url)
    seconds = max(0, int(timestamp_ms // 1000)) if timestamp_ms is not None else 0
    if seconds <= 0:
        return source.url
    if source.platform == "youtube":
        return f"{source.url}&t={seconds}s"
    if source.platform == "vimeo":
        return f"{source.url}#t={seconds}s"
    if source.platform == "rutube":
        return f"{source.url}?t={seconds}"
    return f"{source.url}?t={seconds}s"


def _query_terms(query: str | None) -> list[str]:
    if not query:
        return []
    terms: list[str] = []
    for word in _WORD_RE.findall(query.lower()):
        if word not in _STOP_WORDS and not word.isdigit() and word not in terms:
            terms.append(word)
    return terms


def _token_matches(query_term: str, fragment_words: set[str]) -> bool:
    if query_term in fragment_words:
        return True
    if len(query_term) >= 4:
        stem = query_term[: max(4, len(query_term) - 2)]
        return any(word.startswith(stem) or query_term.startswith(word[: max(4, len(word) - 2)])
                   for word in fragment_words if len(word) >= 4)
    return False


def select_pdf_pages_by_text(
    fragments: Sequence[Fragment],
    excluded_segs: Collection[int],
    query: str | None,
    *,
    max_pages: int = DEFAULT_SEARCH_PDF_PAGES,
) -> list[int]:
    """Rank PDF pages by matching query terms in headings, captions and visible text."""
    terms = _query_terms(query)
    if not terms:
        return []
    scores: dict[int, float] = {}
    for fragment in fragments:
        if fragment.seg in excluded_segs or fragment.page is None:
            continue
        words = set(_WORD_RE.findall(fragment.text.lower()))
        if not words:
            continue
        matched = sum(1 for term in terms if _token_matches(term, words))
        if not matched:
            continue
        weight = 1.0
        if fragment.role == "heading":
            weight = 3.0
        elif words & _CAPTION_WORDS:
            weight = 2.5
        elif fragment.role == "table":
            weight = 1.8
        scores[fragment.page] = scores.get(fragment.page, 0.0) + (matched * weight)
    ranked = sorted(scores, key=lambda page: (-scores[page], page))
    limit = max(1, min(max_pages, MAX_SELECTED_PDF_PAGES))
    return ranked[:limit]


# -- Default on-demand PDF page renderer ----------------------------------------


def _find_pdf_renderer() -> str | None:
    return shutil.which("sips") or ("/usr/bin/sips" if os.access("/usr/bin/sips", os.X_OK) else None)


def default_pdf_page_renderer(single_page_pdf_bytes: bytes, page_number: int) -> bytes:
    """Rasterize the complete selected page with macOS sips in a temporary directory."""
    message = f"SKAZ couldn't render page {page_number} of this PDF on this computer."
    sips = _find_pdf_renderer()
    if sips is None:
        raise VisualSourceUnsupported("pdf_render_unavailable", message)
    try:
        with tempfile.TemporaryDirectory(prefix="skaz-pdf-page-") as temp_dir:
            pdf_file = Path(temp_dir) / f"page-{page_number}.pdf"
            png_file = pdf_file.with_suffix(".png")
            pdf_file.write_bytes(single_page_pdf_bytes)
            subprocess.run(
                [sips, "-s", "format", "png", str(pdf_file), "--out", str(png_file)],
                capture_output=True,
                timeout=15,
                check=True,
            )
            with png_file.open("rb") as output:
                png = output.read(MAX_IMAGE_BYTES + 1)
            if inspect_image_bytes(png).media_type == "image/png" and png.endswith(_png_chunk(b"IEND", b"")):
                return png
    except (OSError, subprocess.SubprocessError, VisualSourceUnsupported) as error:
        raise VisualSourceUnsupported("pdf_render_unavailable", message) from error
    raise VisualSourceUnsupported("pdf_render_unavailable", message)


# -- VisualSourcePreparer -------------------------------------------------------


class VisualSourcePreparer:
    """Prepares source images, on-demand PDF pages and permitted linked video frames (V3)."""

    def __init__(
        self,
        kb: KnowledgeService,
        *,
        page_renderer: PdfPageRenderer | None = None,
        frame_retriever: FrameRetriever | None = None,
        frame_policy: FramePolicyConfig = DEFAULT_FRAME_POLICY,
    ) -> None:
        self.kb = kb
        self.page_renderer: PdfPageRenderer = page_renderer or default_pdf_page_renderer
        self.frame_retriever = frame_retriever
        self.frame_policy = frame_policy
        self._frame_lock = threading.RLock()

    def pdf_renderer_known_unavailable(self) -> bool:
        """Discovery only. A discovered or injected renderer may still fail during rendering."""
        return self.page_renderer is default_pdf_page_renderer and _find_pdf_renderer() is None

    def _policy_for(self, source: VideoSource) -> LinkedFramePolicy:
        if isinstance(self.frame_policy, LinkedFramePolicy):
            return self.frame_policy
        if callable(self.frame_policy):
            return self.frame_policy(source)
        return self.frame_policy.get(source.platform, DEFAULT_FRAME_POLICY)

    def _material_files(self, material_id: str) -> MaterialFiles:
        record = self.kb.material_repo.get(material_id)
        if record is None:
            raise VisualSourceUnsupported("source_not_found", "Material not found.")
        try:
            return self.kb.require().read_material(material_id, hint=record.rel_dir)
        except NotFound as error:
            raise VisualSourceUnsupported("source_not_found", error.message) from error

    @staticmethod
    def _excluded_segs(directory: Path) -> frozenset[int]:
        try:
            raw = read_json(directory / SERVICE_DIR / EXCLUDED_FILE)
            return ExclusionFile.model_validate(raw).excluded_segs()
        except (FileNotFoundError, ValueError, UnicodeDecodeError, ValidationError):
            return frozenset()

    def _visible_fragments(self, files: MaterialFiles) -> list[Fragment]:
        excluded = self._excluded_segs(files.directory)
        return [fragment for fragment in files.fragments if fragment.seg not in excluded]

    def _authorized_service_file(self, files: MaterialFiles, name: str) -> Path:
        """Verify ``.skaz/<name>`` is a regular file inside the material's service directory."""
        service_dir = (files.directory / SERVICE_DIR).resolve(strict=True)
        candidate = files.directory / SERVICE_DIR / name
        try:
            if candidate.is_symlink():
                raise VisualSourceUnsupported(
                    "unauthorized_path", "SKAZ refuses symbolic links inside a material's service folder."
                )
            resolved = candidate.resolve(strict=True)
            info = resolved.stat()
        except VisualSourceUnsupported:
            raise
        except (OSError, RuntimeError) as error:
            raise VisualSourceUnsupported(
                "pdf_render_unavailable", "The material's original file is missing or can't be opened."
            ) from error
        data_root = self.kb.data_dir.resolve()
        if resolved.parent != service_dir or resolved == data_root or data_root in resolved.parents:
            raise VisualSourceUnsupported(
                "unauthorized_path", "The material's original file points outside its authorized folder."
            )
        if not stat.S_ISREG(info.st_mode) or not os.access(resolved, os.R_OK):
            raise VisualSourceUnsupported("unauthorized_path", "Choose a readable regular file.")
        return resolved

    # -- 1. Source images -------------------------------------------------------

    def prepare_image(
        self,
        path: str | Path,
        *,
        material_id: str | None = None,
    ) -> PreparedVisual:
        """Prepare an authorized local source image (PNG, JPEG, WebP, GIF)."""
        checked = given_path(
            path,
            lambda msg: VisualSourceUnsupported("unauthorized_path", msg),
        )
        suffix = checked.suffix.lower()
        if suffix in VIDEO_EXTENSIONS or suffix == ".avi":
            raise VisualSourceUnsupported(
                "local_video_audio_only",
                f"{LOCAL_VIDEO_AUDIO_ONLY_NOTICE} Attach a screenshot or image instead.",
                allow_user_supplied_image=True,
                has_source_text=False,
                text_fallback_detail=NO_SOURCE_TEXT_AVAILABLE,
            )
        resolved, info = resolved_file(
            checked,
            self.kb.data_dir,
            lambda msg: VisualSourceUnsupported("unauthorized_path", msg),
        )
        if suffix not in IMAGE_EXTENSIONS:
            raise VisualSourceUnsupported(
                "unsupported_image_format",
                "SKAZ can only prepare PNG, JPEG, WebP or GIF images.",
            )
        if info.st_size > MAX_IMAGE_BYTES:
            raise VisualSourceUnsupported(
                "oversized_image",
                f"This image is larger than {MAX_IMAGE_BYTES // (1024 * 1024)} MB.",
            )
        data = resolved.read_bytes()
        header = inspect_image_bytes(data)
        digest = content_hash(data)
        locator = VisualSourceLocator(
            version=1,
            kind="image",
            material_id=material_id,
            source_sha256=digest,
            file_name=resolved.name,
        )
        return PreparedVisual(
            locator=locator,
            data=data,
            media_type=header.media_type,
            width=header.width,
            height=header.height,
            sha256=digest,
            retention_permitted=False,
        )

    # -- 2. On-demand selected PDF pages ----------------------------------------

    def prepare_pdf_pages(
        self,
        material_id: str,
        *,
        pages: Sequence[int] | None = None,
        page_range: tuple[int, int] | None = None,
        query: str | None = None,
        max_pages: int = DEFAULT_SEARCH_PDF_PAGES,
        read_original: Callable[[MaterialFiles, Path], bytes] | None = None,
    ) -> tuple[PreparedVisual, ...]:
        """Prepare selected PDF pages on demand from ``.skaz/original.pdf`` (decision 1.5)."""
        files = self._material_files(material_id)
        if files.manifest.kind not in ("pdf", "book"):
            raise VisualSourceUnsupported(
                "pdf_render_unavailable",
                "Only PDF and book materials have pages to render.",
            )
        visible = self._visible_fragments(files)
        has_text = bool(visible)
        detail = PDF_TEXT_AVAILABLE if has_text else NO_SOURCE_TEXT_AVAILABLE
        intake = read_intake(files.directory)
        original_name = str(intake.get("original") or "original.pdf")
        original_path = self._authorized_service_file(files, original_name)
        pdf_bytes = (
            original_path.read_bytes() if read_original is None else read_original(files, original_path)
        )
        pdf_sha256 = content_hash(pdf_bytes)
        try:
            reader = open_pdf(pdf_bytes)
        except PdfRejected as error:
            raise VisualSourceUnsupported(
                "pdf_render_unavailable",
                error.message,
                has_source_text=has_text,
                text_fallback_detail=detail,
            ) from error
        page_count = len(reader.pages)

        selected: list[int] = []
        explicit = False
        if pages is not None and len(pages) > 0:
            explicit = True
            for number in pages:
                if number not in selected:
                    selected.append(int(number))
        elif page_range is not None:
            explicit = True
            start, end = int(page_range[0]), int(page_range[1])
            selected = _explicit_page_range(start, end)
        else:
            parsed = parse_explicit_pages(query)
            if parsed:
                explicit = True
                selected = parsed

        if explicit:
            for number in selected:
                if number < 1 or number > page_count:
                    raise VisualSourceUnsupported(
                        "page_out_of_range",
                        f"Page {number} is out of range. This PDF has {page_count} "
                        f"{'page' if page_count == 1 else 'pages'} (1–{page_count}).",
                        page_count=page_count,
                        has_source_text=has_text,
                        text_fallback_detail=detail,
                    )
            if len(selected) > MAX_SELECTED_PDF_PAGES:
                raise VisualSourceUnsupported(
                    "page_range_required",
                    f"Specify at most {MAX_SELECTED_PDF_PAGES} pages at a time (1–{page_count}).",
                    ask_page_range=True,
                    page_count=page_count,
                    has_source_text=has_text,
                    text_fallback_detail=detail,
                )
        else:
            if not has_text:
                raise VisualSourceUnsupported(
                    "page_range_required",
                    "This PDF has no text layer to locate the page automatically. "
                    f"Specify a page number or a short page range (1–{page_count}).",
                    ask_page_range=True,
                    page_count=page_count,
                    has_source_text=False,
                    text_fallback_detail=NO_SOURCE_TEXT_AVAILABLE,
                )
            excluded = self._excluded_segs(files.directory)
            selected = select_pdf_pages_by_text(
                files.fragments,
                excluded,
                query,
                max_pages=max_pages,
            )
            if not selected:
                raise VisualSourceUnsupported(
                    "page_range_required",
                    "SKAZ couldn't locate a matching page from headings, captions or text. "
                    f"Specify a page number or a short page range (1–{page_count}).",
                    ask_page_range=True,
                    page_count=page_count,
                    has_source_text=True,
                    text_fallback_detail=PDF_TEXT_AVAILABLE,
                )

        prepared: list[PreparedVisual] = []
        for page_number in selected:
            locator = VisualSourceLocator(
                version=1,
                kind="pdf_page",
                material_id=material_id,
                source_sha256=pdf_sha256,
                page=page_number,
                file_name=original_name,
            )
            try:
                display, *comparisons = pdf_raster_inputs(reader, page_number)
                image_bytes = self.page_renderer(display, page_number)
                for filtered in comparisons:
                    if self.page_renderer(filtered, page_number) != image_bytes:
                        raise PdfRejected(
                            f"SKAZ can't faithfully render page {page_number} with its hidden text."
                        )
                header = inspect_image_bytes(image_bytes)
            except (PdfRejected, VisualSourceUnsupported) as error:
                raise VisualSourceUnsupported(
                    "pdf_render_unavailable",
                    error.message,
                    locator=locator,
                    page_count=page_count,
                    has_source_text=has_text,
                    text_fallback_detail=detail,
                ) from error
            prepared.append(
                PreparedVisual(
                    locator=locator,
                    data=image_bytes,
                    media_type=header.media_type,
                    width=header.width,
                    height=header.height,
                    sha256=content_hash(image_bytes),
                    retention_permitted=False,
                )
            )
        return tuple(prepared)

    # -- 3. Linked video frame preparation (local video kept audio-only) --------

    def _select_video_timestamps(
        self,
        files: MaterialFiles,
        *,
        timestamps_ms: Sequence[int] | None = None,
        query: str | None = None,
    ) -> list[int]:
        if timestamps_ms is not None and len(timestamps_ms) > 0:
            chosen: list[int] = []
            for ts in timestamps_ms:
                val = max(0, int(ts))
                if val not in chosen:
                    chosen.append(val)
            return chosen[:MAX_REQUESTED_VIDEO_FRAMES]
        parsed = parse_timestamps_ms(query)
        if parsed:
            return parsed[:MAX_REQUESTED_VIDEO_FRAMES]
        visible = self._visible_fragments(files)
        terms = _query_terms(query)
        scored: list[tuple[int, int]] = []
        for fragment in visible:
            if fragment.start_ms is None:
                continue
            if not terms:
                scored.append((1, fragment.start_ms))
                continue
            words = set(_WORD_RE.findall(fragment.text.lower()))
            matches = sum(1 for term in terms if _token_matches(term, words))
            if matches:
                scored.append((matches, fragment.start_ms))
        scored.sort(key=lambda item: (-item[0], item[1]))
        result: list[int] = []
        for _score, start_ms in scored:
            if start_ms not in result:
                result.append(start_ms)
            if len(result) >= MAX_REQUESTED_VIDEO_FRAMES:
                break
        if not result and visible and visible[0].start_ms is not None:
            result.append(visible[0].start_ms)
        return result or [0]

    async def prepare_video_frames(
        self,
        material_id: str,
        *,
        timestamps_ms: Sequence[int] | None = None,
        query: str | None = None,
    ) -> tuple[PreparedVisual, ...]:
        """Prepare requested frames for a permitted linked video; refuse local video as audio-only."""
        files = self._material_files(material_id)
        visible = self._visible_fragments(files)
        has_transcript = bool(visible)
        detail = VIDEO_TRANSCRIPT_AVAILABLE if has_transcript else NO_SOURCE_TEXT_AVAILABLE

        if files.manifest.kind == "video":
            raise VisualSourceUnsupported(
                "local_video_audio_only",
                f"{LOCAL_VIDEO_AUDIO_ONLY_NOTICE} "
                "Attach a screenshot or image if you want the agent to inspect a visual.",
                allow_user_supplied_image=True,
                has_source_text=has_transcript,
                text_fallback_detail=detail,
            )
        if files.manifest.kind != "video_link":
            raise VisualSourceUnsupported(
                "video_frames_unsupported",
                "This material is not a linked video.",
                has_source_text=has_transcript,
                text_fallback_detail=detail,
            )
        raw_url = files.manifest.origin.url if files.manifest.origin is not None else None
        if not raw_url:
            raise VisualSourceUnsupported(
                "video_frames_unsupported",
                "This linked video has no source URL.",
                allow_user_supplied_image=True,
                has_source_text=has_transcript,
                text_fallback_detail=detail,
            )
        try:
            source = video_source(raw_url)
        except InvalidMediaSource as error:
            raise VisualSourceUnsupported(
                "video_frames_unsupported",
                str(error),
                allow_user_supplied_image=True,
                has_source_text=has_transcript,
                text_fallback_detail=detail,
            ) from error

        requested = self._select_video_timestamps(files, timestamps_ms=timestamps_ms, query=query)
        primary_ts = requested[0] if requested else 0
        nav_url = video_timestamp_url(source.url, primary_ts)
        fallback_locator = VisualSourceLocator(
            version=1,
            kind="video_frame",
            material_id=material_id,
            source_url=source.url,
            navigation_url=nav_url,
            timestamp_ms=primary_ts,
            requested_timestamp_ms=primary_ts,
        )

        policy = self._policy_for(source)
        if not policy.retrieval_permitted or self.frame_retriever is None:
            raise VisualSourceUnsupported(
                "video_frames_unsupported",
                "SKAZ can't retrieve video frames from this source. Open the video at the timestamp "
                "or attach a screenshot instead.",
                locator=fallback_locator,
                navigation_url=nav_url,
                allow_user_supplied_image=True,
                has_source_text=has_transcript,
                text_fallback_detail=detail,
            )

        raw_result = self.frame_retriever(source, tuple(requested))
        retrieved = await raw_result if inspect.isawaitable(raw_result) else raw_result
        if not retrieved:
            raise VisualSourceUnsupported(
                "video_frames_unsupported",
                "No video frames could be obtained for the requested timestamp. Open the video at the "
                "timestamp or attach a screenshot instead.",
                locator=fallback_locator,
                navigation_url=nav_url,
                allow_user_supplied_image=True,
                has_source_text=has_transcript,
                text_fallback_detail=detail,
            )

        prepared: list[PreparedVisual] = []
        for idx, item in enumerate(retrieved[:MAX_REQUESTED_VIDEO_FRAMES]):
            if item.actual_timestamp_ms < 0:
                raise VisualSourceUnsupported(
                    "video_frames_unsupported",
                    "The frame retriever returned an invalid negative timestamp.",
                    locator=fallback_locator,
                    navigation_url=nav_url,
                    allow_user_supplied_image=True,
                    has_source_text=has_transcript,
                    text_fallback_detail=detail,
                )
            header = inspect_image_bytes(item.data)
            req_ts = (
                item.requested_timestamp_ms
                if item.requested_timestamp_ms is not None
                else (requested[idx] if idx < len(requested) else item.actual_timestamp_ms)
            )
            actual_nav = video_timestamp_url(source.url, item.actual_timestamp_ms)
            locator = VisualSourceLocator(
                version=1,
                kind="video_frame",
                material_id=material_id,
                source_url=source.url,
                navigation_url=actual_nav,
                timestamp_ms=item.actual_timestamp_ms,
                requested_timestamp_ms=req_ts,
            )
            prepared.append(
                PreparedVisual(
                    locator=locator,
                    data=item.data,
                    media_type=header.media_type,
                    width=header.width,
                    height=header.height,
                    sha256=content_hash(item.data),
                    retention_permitted=policy.retention_permitted,
                )
            )
        return tuple(prepared)

    # -- 4. Citation and manual pin retention for linked video frames -----------

    @staticmethod
    def _read_retained_index(directory: Path) -> RetainedFramesFile:
        path = directory / SERVICE_DIR / FRAMES_INDEX_FILE
        try:
            return RetainedFramesFile.model_validate(read_json(path))
        except FileNotFoundError:
            return RetainedFramesFile()
        except (ValueError, UnicodeDecodeError, ValidationError) as error:
            raise KnowledgeError("The material's retained frames list is damaged.") from error

    @staticmethod
    def _write_retained_index(directory: Path, index: RetainedFramesFile) -> None:
        write_atomic(
            directory / SERVICE_DIR / FRAMES_INDEX_FILE,
            dump_json(index.model_dump(mode="json")),
        )

    def _require_retainable_video_link(
        self, material_id: str
    ) -> tuple[MaterialFiles, VideoSource, LinkedFramePolicy]:
        files = self._material_files(material_id)
        if files.manifest.kind == "video":
            raise VisualSourceUnsupported(
                "local_video_audio_only",
                f"{LOCAL_VIDEO_AUDIO_ONLY_NOTICE} Local video frames are never retained.",
                allow_user_supplied_image=True,
            )
        if files.manifest.kind != "video_link":
            raise VisualSourceUnsupported(
                "retention_not_permitted",
                "Only frames of a linked video material can be retained.",
            )
        raw_url = files.manifest.origin.url if files.manifest.origin is not None else None
        if not raw_url:
            raise VisualSourceUnsupported(
                "retention_not_permitted",
                "This linked video has no source URL.",
            )
        try:
            source = video_source(raw_url)
        except InvalidMediaSource as error:
            raise VisualSourceUnsupported("retention_not_permitted", str(error)) from error
        policy = self._policy_for(source)
        if not (policy.retrieval_permitted and policy.retention_permitted):
            raise VisualSourceUnsupported(
                "retention_not_permitted",
                "This source does not permit storing video frames.",
            )
        return files, source, policy

    def retain_video_frames(
        self,
        material_id: str,
        frames: Sequence[PreparedVisual],
        *,
        cited_timestamps_ms: Collection[int] = (),
        cited_sha256s: Collection[str] = (),
        pinned_timestamps_ms: Collection[int] = (),
        pinned_sha256s: Collection[str] = (),
        citation_refs: Mapping[int, Sequence[str]] | Sequence[str] = (),
    ) -> tuple[RetainedFrameRecord, ...]:
        """Persist only cited or manually pinned frames when the source permits retention (decision 1.4)."""
        files, source, _policy = self._require_retainable_video_link(material_id)
        for frame in frames:
            if (
                frame.locator.material_id != material_id or frame.locator.source_url != source.url
                or frame.locator.kind != "video_frame" or frame.timestamp_ms is None
            ):
                raise VisualSourceUnsupported(
                    "retention_not_permitted", "This frame belongs to another source."
                )

        def resolve(selector: int | str) -> int | None:
            if isinstance(selector, int):
                matches = [i for i, frame in enumerate(frames) if frame.timestamp_ms == selector]
                if not matches:
                    matches = [
                        i for i, frame in enumerate(frames) if frame.requested_timestamp_ms == selector
                    ]
            else:
                matches = [i for i, frame in enumerate(frames) if frame.sha256 == selector]
            identities = {(frames[i].timestamp_ms, frames[i].sha256) for i in matches}
            if len(identities) > 1:
                raise VisualSourceUnsupported(
                    "retention_not_permitted", "This frame selection is ambiguous. Select a specific frame."
                )
            if not matches:
                return None
            first = frames[matches[0]]
            return next(i for i, f in enumerate(frames)
                        if f.timestamp_ms == first.timestamp_ms and f.sha256 == first.sha256)

        cited = {resolve(ts) for ts in cited_timestamps_ms} | {resolve(digest) for digest in cited_sha256s}
        pinned = {resolve(ts) for ts in pinned_timestamps_ms} | {resolve(digest) for digest in pinned_sha256s}
        refs_by_index: dict[int, list[str]] = {}
        if isinstance(citation_refs, Mapping):
            for timestamp, refs in citation_refs.items():
                frame_index = resolve(timestamp)
                if frame_index is not None and frame_index in cited:
                    refs_by_index.setdefault(frame_index, []).extend(refs)
        else:
            refs_by_index = {i: list(citation_refs) for i in cited if i is not None}

        selected: list[tuple[PreparedVisual, tuple[FrameRetentionReason, ...], tuple[str, ...]]] = []
        for i, frame in enumerate(frames):
            if i not in cited and i not in pinned:
                continue
            if not frame.retention_permitted or frame.sha256 != content_hash(frame.data):
                raise VisualSourceUnsupported(
                    "retention_not_permitted", "The prepared frame cannot be retained for this source."
                )
            reasons: list[FrameRetentionReason] = []
            if i in cited:
                reasons.append("cited")
            if i in pinned:
                reasons.append("pinned")
            selected.append((frame, tuple(reasons), tuple(dict.fromkeys(refs_by_index.get(i, [])))))

        if not selected:
            return ()

        with self._frame_lock:
            index = self._read_retained_index(files.directory)
            by_key: dict[tuple[int, str], RetainedFrameRecord] = {
                (item.locator.timestamp_ms or 0, item.sha256): item for item in index.frames
            }
            frames_dir = files.directory / SERVICE_DIR / FRAMES_DIR
            frames_dir.mkdir(parents=True, exist_ok=True)
            retained_now: list[RetainedFrameRecord] = []

            for frame, new_reasons, new_refs in selected:
                header = inspect_image_bytes(frame.data)
                actual_ts = frame.timestamp_ms if frame.timestamp_ms is not None else 0
                digest = content_hash(frame.data)
                key = (actual_ts, digest)
                existing = by_key.get(key)
                ext = _MEDIA_EXTENSION[header.media_type]
                file_name = (
                    existing.file_name
                    if existing is not None
                    else f"frame-{actual_ts}-{digest[:12]}{ext}"
                )
                target = frames_dir / file_name
                if not target.is_file():
                    write_atomic(target, frame.data)
                merged_reasons: list[FrameRetentionReason] = list(
                    existing.retained_because if existing is not None else ()
                )
                for r in new_reasons:
                    if r not in merged_reasons:
                        merged_reasons.append(r)
                merged_refs: list[str] = list(existing.citation_refs if existing is not None else ())
                for ref in new_refs:
                    if ref not in merged_refs:
                        merged_refs.append(ref)
                req_ts = (
                    frame.requested_timestamp_ms if frame.requested_timestamp_ms is not None else actual_ts
                )
                locator = VisualSourceLocator(
                    version=1,
                    kind="video_frame",
                    material_id=material_id,
                    source_url=source.url,
                    navigation_url=video_timestamp_url(source.url, actual_ts),
                    timestamp_ms=actual_ts,
                    requested_timestamp_ms=req_ts,
                    file_name=file_name,
                )
                record = RetainedFrameRecord(
                    frame_id=existing.frame_id if existing is not None else f"frm-{actual_ts}-{digest[:8]}",
                    locator=locator,
                    file_name=file_name,
                    media_type=header.media_type,
                    sha256=digest,
                    width=header.width,
                    height=header.height,
                    retained_because=tuple(merged_reasons),
                    citation_refs=tuple(merged_refs),
                    created_at=existing.created_at if existing is not None else utc_now(),
                )
                by_key[key] = record
                retained_now.append(record)

            index.frames = sorted(
                by_key.values(), key=lambda item: (item.locator.timestamp_ms or 0, item.frame_id)
            )
            self._write_retained_index(files.directory, index)
            return tuple(retained_now)

    def pin_video_frame(self, material_id: str, frame: PreparedVisual) -> RetainedFrameRecord:
        """Manually pin a prepared linked-video frame."""
        ts = frame.timestamp_ms if frame.timestamp_ms is not None else 0
        saved = self.retain_video_frames(
            material_id,
            [frame],
            pinned_timestamps_ms=[ts],
            pinned_sha256s=[frame.sha256],
        )
        return saved[0]

    def unpin_video_frame(
        self,
        material_id: str,
        frame_id_or_timestamp_ms: str | int,
    ) -> tuple[RetainedFrameRecord, ...]:
        """Remove a manual pin; delete the frame file if it is not cited by an answer."""
        files = self._material_files(material_id)
        with self._frame_lock:
            index = self._read_retained_index(files.directory)
            kept: list[RetainedFrameRecord] = []
            removed_files: list[str] = []
            for item in index.frames:
                matches = (
                    item.frame_id == frame_id_or_timestamp_ms
                    if isinstance(frame_id_or_timestamp_ms, str)
                    else item.locator.timestamp_ms == frame_id_or_timestamp_ms
                )
                if not matches or "pinned" not in item.retained_because:
                    kept.append(item)
                    continue
                remaining = tuple(r for r in item.retained_because if r != "pinned")
                if remaining:
                    kept.append(item.model_copy(update={"retained_because": remaining}))
                else:
                    removed_files.append(item.file_name)
            index.frames = kept
            self._write_retained_index(files.directory, index)
            frames_dir = files.directory / SERVICE_DIR / FRAMES_DIR
            for file_name in removed_files:
                candidate = frames_dir / file_name
                if not candidate.is_symlink():
                    candidate.unlink(missing_ok=True)
            return tuple(kept)

    def list_retained_frames(self, material_id: str) -> tuple[RetainedFrameRecord, ...]:
        files = self._material_files(material_id)
        return tuple(self._read_retained_index(files.directory).frames)

    def read_retained_frame(
        self,
        material_id: str,
        frame_id_or_timestamp_ms: str | int,
    ) -> PreparedVisual:
        """Read a persisted cited/pinned frame back with authorized path verification."""
        files = self._material_files(material_id)
        index = self._read_retained_index(files.directory)
        record = next(
            (
                item
                for item in index.frames
                if (
                    item.frame_id == frame_id_or_timestamp_ms
                    if isinstance(frame_id_or_timestamp_ms, str)
                    else item.locator.timestamp_ms == frame_id_or_timestamp_ms
                )
            ),
            None,
        )
        if record is None:
            raise NotFound("Retained video frame not found.")
        frames_dir = (files.directory / SERVICE_DIR / FRAMES_DIR).resolve(strict=True)
        candidate = files.directory / SERVICE_DIR / FRAMES_DIR / record.file_name
        if candidate.is_symlink():
            raise VisualSourceUnsupported("unauthorized_path", "Retained frame cannot be a symbolic link.")
        resolved = candidate.resolve(strict=True)
        if resolved.parent != frames_dir:
            raise VisualSourceUnsupported("unauthorized_path", "Retained frame path is outside its folder.")
        data = resolved.read_bytes()
        header = inspect_image_bytes(data)
        return PreparedVisual(
            locator=record.locator,
            data=data,
            media_type=header.media_type,
            width=header.width,
            height=header.height,
            sha256=content_hash(data),
            retention_permitted=True,
        )

    # -- 5. V4 payload / error seam --------------------------------------------

    def prepare_visual_seam(
        self,
        *,
        material_id: str | None = None,
        image_path: str | Path | None = None,
        pages: Sequence[int] | None = None,
        page_range: tuple[int, int] | None = None,
        timestamps_ms: Sequence[int] | None = None,
        query: str | None = None,
        max_pages: int = DEFAULT_SEARCH_PDF_PAGES,
    ) -> VisualFallbackSeam:
        """Synchronous V4 payload/error seam for images, PDFs and local video materials."""
        try:
            if image_path is not None:
                item = self.prepare_image(image_path, material_id=material_id)
                return VisualFallbackSeam.success(
                    (item,),
                    has_source_text=False,
                    text_fallback_detail=NO_SOURCE_TEXT_AVAILABLE,
                )
            if material_id is None:
                raise VisualSourceUnsupported("source_not_found", "Choose an image or material to prepare.")
            files = self._material_files(material_id)
            visible = self._visible_fragments(files)
            has_text = bool(visible)
            if files.manifest.kind in ("pdf", "book"):
                items = self.prepare_pdf_pages(
                    material_id,
                    pages=pages,
                    page_range=page_range,
                    query=query,
                    max_pages=max_pages,
                )
                return VisualFallbackSeam.success(
                    items,
                    has_source_text=has_text,
                    text_fallback_detail=PDF_TEXT_AVAILABLE if has_text else NO_SOURCE_TEXT_AVAILABLE,
                )
            if files.manifest.kind == "video":
                raise VisualSourceUnsupported(
                    "local_video_audio_only",
                    f"{LOCAL_VIDEO_AUDIO_ONLY_NOTICE} "
                    "Attach a screenshot or image if you want the agent to inspect a visual.",
                    allow_user_supplied_image=True,
                    has_source_text=has_text,
                    text_fallback_detail=VIDEO_TRANSCRIPT_AVAILABLE if has_text else NO_SOURCE_TEXT_AVAILABLE,
                )
            raise VisualSourceUnsupported(
                "video_frames_unsupported",
                "Use prepare_video_frames_seam for linked video materials.",
                has_source_text=has_text,
                text_fallback_detail=VIDEO_TRANSCRIPT_AVAILABLE if has_text else NO_SOURCE_TEXT_AVAILABLE,
            )
        except VisualSourceUnsupported as error:
            return error.to_seam()

    async def prepare_video_frames_seam(
        self,
        material_id: str,
        *,
        timestamps_ms: Sequence[int] | None = None,
        query: str | None = None,
    ) -> VisualFallbackSeam:
        """Async V4 payload/error seam for linked video materials."""
        try:
            files = self._material_files(material_id)
            has_text = bool(self._visible_fragments(files))
            items = await self.prepare_video_frames(
                material_id,
                timestamps_ms=timestamps_ms,
                query=query,
            )
            return VisualFallbackSeam.success(
                items,
                has_source_text=has_text,
                text_fallback_detail=VIDEO_TRANSCRIPT_AVAILABLE if has_text else NO_SOURCE_TEXT_AVAILABLE,
            )
        except VisualSourceUnsupported as error:
            return error.to_seam()
