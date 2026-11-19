"""Local, bounded image decoding (JPEG, PNG, WebP, HEIC) with no OCR or network calls."""

from __future__ import annotations

import importlib
import importlib.util
import io
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO, Literal

from ..intake import SourceRejected
from .formats import ImageFormat, sniff_image_format

MAX_IMAGE_WIDTH = 16_384
MAX_IMAGE_HEIGHT = 16_384
MAX_IMAGE_PIXELS = 64_000_000
MAX_PREVIEW_EDGE = 512
MAX_PREVIEW_BYTES = 2 * 1024 * 1024


class ImageCodecUnavailable(SourceRejected):
    """Raised when an image operation needs the optional PyAV codec runtime and it cannot load."""

    status_code = 503


def image_codec_available() -> bool:
    """Return whether PyAV (``av``) is importable without loading it at module import time."""
    try:
        return importlib.util.find_spec("av") is not None
    except (ImportError, ModuleNotFoundError, ValueError):
        return False


def _unavailable_message(expected_format: ImageFormat) -> str:
    label = expected_format.upper()
    return (
        f"Cannot decode {label} images because the optional local image codec (PyAV) "
        "is not available in this backend. Install the 'local-asr' backend extra or use a full build."
    )


def _load_av(expected_format: ImageFormat) -> tuple[Any, type[Exception]]:
    try:
        av_module = importlib.import_module("av")
        av_error_module = importlib.import_module("av.error")
    except (ImportError, OSError) as error:
        raise ImageCodecUnavailable(_unavailable_message(expected_format)) from error
    ffmpeg_error = getattr(av_error_module, "FFmpegError", None)
    if not callable(getattr(av_module, "open", None)) or not (
        isinstance(ffmpeg_error, type) and issubclass(ffmpeg_error, Exception)
    ):
        raise ImageCodecUnavailable(_unavailable_message(expected_format))
    return av_module, ffmpeg_error


@dataclass(frozen=True)
class DecodedImageInfo:
    """Verified metadata and optional bounded PNG preview from decoding an image on disk or in memory."""

    format_id: ImageFormat
    mime_type: str
    width: int
    height: int
    pixel_format: str
    preview_png: bytes | None = None
    ocr_performed: Literal[False] = False
    text_extracted: Literal[False] = False


def _validate_dimensions(width: int, height: int) -> None:
    if width <= 0 or height <= 0:
        raise SourceRejected("This image has invalid dimensions and can't be read.")
    if width > MAX_IMAGE_WIDTH or height > MAX_IMAGE_HEIGHT or width * height > MAX_IMAGE_PIXELS:
        raise SourceRejected("This image's resolution exceeds SKAZ's safety limit.")


def _scaled_size(width: int, height: int, max_edge: int) -> tuple[int, int]:
    if max_edge <= 0:
        raise ValueError("max_edge must be positive")
    if width <= max_edge and height <= max_edge:
        return width, height
    if width >= height:
        out_w = max_edge
        out_h = max(1, round(height * max_edge / width))
    else:
        out_h = max_edge
        out_w = max(1, round(width * max_edge / height))
    return out_w, out_h


def _encode_preview_png(av_module: Any, frame: Any, *, max_edge: int) -> bytes:
    out_w, out_h = _scaled_size(frame.width, frame.height, max_edge)
    rgb = frame.reformat(width=out_w, height=out_h, format="rgb24")
    buf = io.BytesIO()
    with av_module.open(buf, mode="w", format="image2pipe") as container:
        stream = container.add_stream("png", rate=1)
        stream.width = out_w
        stream.height = out_h
        stream.pix_fmt = "rgb24"
        for packet in stream.encode(rgb):
            container.mux(packet)
        for packet in stream.encode():
            container.mux(packet)
    data = buf.getvalue()
    if not data.startswith(b"\x89PNG\r\n\x1a\n"):
        raise SourceRejected("Could not render a local preview for this image.")
    if len(data) > MAX_PREVIEW_BYTES:
        raise SourceRejected("Generated image preview exceeds SKAZ's size limit.")
    return data


def decode_image(
    source: Path | bytes | BinaryIO,
    *,
    expected_format: ImageFormat,
    mime_type: str,
    generate_preview: bool = False,
    max_preview_edge: int = MAX_PREVIEW_EDGE,
) -> DecodedImageInfo:
    """Decode an image locally via PyAV to prove integrity and extract dimensions (no OCR)."""
    if isinstance(source, (bytes, bytearray)):
        head = bytes(source[:64])
        if sniff_image_format(head) != expected_format:
            raise SourceRejected(f"This file doesn't match a valid {expected_format.upper()} image.")
        target: str | io.BytesIO | BinaryIO = io.BytesIO(source)
    elif isinstance(source, Path):
        with source.open("rb") as handle:
            head = handle.read(64)
        if sniff_image_format(head) != expected_format:
            raise SourceRejected(f"This file doesn't match a valid {expected_format.upper()} image.")
        target = str(source)
    else:
        source.seek(0)
        head = source.read(64)
        if sniff_image_format(head) != expected_format:
            raise SourceRejected(f"This file doesn't match a valid {expected_format.upper()} image.")
        source.seek(0)
        target = source

    av_module, ffmpeg_error = _load_av(expected_format)

    try:
        with av_module.open(target, mode="r") as container:
            streams = container.streams.video
            if not streams:
                raise SourceRejected("This image contains no readable picture stream.")
            stream = streams[0]
            if stream.width and stream.height:
                _validate_dimensions(stream.width, stream.height)
            frame: Any = None
            for decoded in container.decode(video=0):
                frame = decoded
                break
            if frame is None:
                raise SourceRejected("This image could not be decoded.")
            _validate_dimensions(frame.width, frame.height)
            pixel_format = frame.format.name
            preview = (
                _encode_preview_png(av_module, frame, max_edge=max_preview_edge)
                if generate_preview
                else None
            )
            return DecodedImageInfo(
                format_id=expected_format,
                mime_type=mime_type,
                width=frame.width,
                height=frame.height,
                pixel_format=pixel_format,
                preview_png=preview,
            )
    except SourceRejected:
        raise
    except (ffmpeg_error, OSError, ValueError, RuntimeError) as error:
        msg = f"This {expected_format.upper()} image is damaged and can't be decoded."
        raise SourceRejected(msg) from error
