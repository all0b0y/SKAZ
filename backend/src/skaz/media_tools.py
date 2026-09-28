"""Bounded cancellable media tools. No shell, browser cookies or user config."""
from __future__ import annotations

import asyncio
import contextlib
import json
import math
import os
import shutil
import signal
import sys
from pathlib import Path
from typing import Any

from .media_source import youtube_source

MAX_DURATION_MS = 300 * 60 * 1000
MAX_MEDIA_BYTES = 2 * 1024 * 1024 * 1024


class MediaError(ValueError):
    """Safe user-facing error; raw tool output never leaves this module."""


def tool_path(name: str) -> str:
    root = os.environ.get("SKAZ_MEDIA_TOOLS_DIR")
    if root:
        candidate = Path(root) / name
    elif getattr(sys, "frozen", False):
        candidate = Path(sys.executable).parent.parent / "media-tools" / name
    else:
        candidate = Path(__file__).resolve().parents[2] / ".runtime" / "media-tools" / name
        if not candidate.is_file():
            found = shutil.which(name)
            if found:
                return found
    if candidate.is_file() and os.access(candidate, os.X_OK):
        return str(candidate)
    raise MediaError(f"Media tool {name} is unavailable. Install an updated SKAZ build.")


async def run_tool(argv: list[str], *, timeout: float = 120, max_output: int = 2_000_000) -> str:
    try:
        process = await asyncio.create_subprocess_exec(
            *argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            stdin=asyncio.subprocess.DEVNULL, start_new_session=True,
        )
    except OSError as error:
        raise MediaError("The media tool could not be started.") from error

    async def read(stream: asyncio.StreamReader | None) -> bytes:
        assert stream is not None
        parts: list[bytes] = []
        size = 0
        while chunk := await stream.read(65536):
            size += len(chunk)
            if size > max_output:
                raise MediaError("Media tool produced too much output.")
            parts.append(chunk)
        return b"".join(parts)

    readers = [asyncio.create_task(read(process.stdout)), asyncio.create_task(read(process.stderr))]
    try:
        async with asyncio.timeout(timeout):
            stdout, _stderr = await asyncio.gather(*readers)
            if await process.wait() != 0:
                raise MediaError(
                    "Media tool failed. The source may be unavailable, require sign-in, "
                    "or use an unsupported format. Try a local media file."
                )
            return stdout.decode("utf-8", errors="replace")
    except TimeoutError as error:
        raise MediaError("Media processing timed out. Try again or choose a local file.") from error
    finally:
        if process.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGKILL)
            await process.wait()
        for task in readers:
            task.cancel()
        await asyncio.gather(*readers, return_exceptions=True)


def _duration(value: Any) -> int:
    try:
        seconds = float(value)
    except (TypeError, ValueError) as error:
        raise MediaError("The media duration could not be determined.") from error
    if not math.isfinite(seconds) or seconds <= 0 or seconds * 1000 > MAX_DURATION_MS:
        raise MediaError("Choose a recording no longer than 300 minutes, with a readable duration.")
    return round(seconds * 1000)


def _youtube_args() -> list[str]:
    deno = tool_path("deno")
    return [tool_path("yt-dlp"), "--ignore-config", "--no-plugin-dirs", "--no-playlist",
            "--no-warnings", "--no-progress", "--no-remote-components",
            "--js-runtimes", f"deno:{deno}", "--socket-timeout", "20", "--retries", "2"]


async def youtube_metadata(url: str) -> dict[str, Any]:
    source = youtube_source(url)
    raw = await run_tool([*_youtube_args(), "--skip-download", "--dump-single-json", "--", source.url])
    try:
        info = json.loads(raw)
        if (not isinstance(info, dict) or info.get("id") != source.video_id
                or info.get("_type", "video") != "video"
                or info.get("is_live") or info.get("live_status") in ("is_live", "is_upcoming", "post_live")
                or info.get("availability") not in (None, "public", "unlisted")):
            raise MediaError("Only available, finished public videos can be imported.")
        return {"url": source.url, "video_id": source.video_id,
                "title": str(info.get("title") or "YouTube video")[:200],
                "duration_ms": _duration(info.get("duration"))}
    except (json.JSONDecodeError, AttributeError) as error:
        raise MediaError("YouTube returned unreadable video information.") from error


async def local_metadata(path: Path) -> dict[str, Any]:
    if not path.is_absolute() or not path.is_file() or path.stat().st_size > MAX_MEDIA_BYTES:
        raise MediaError("Choose an existing media file no larger than 2 GiB.")
    raw = await run_tool([tool_path("ffprobe"), "-v", "error", "-show_format", "-show_streams",
                          "-of", "json", "-protocol_whitelist", "file,pipe", str(path)])
    try:
        info = json.loads(raw)
        if not any(s.get("codec_type") == "audio" for s in info.get("streams", [])):
            raise MediaError("This file has no audio track.")
        return {"title": path.stem[:200], "duration_ms": _duration(info["format"].get("duration"))}
    except (KeyError, TypeError, json.JSONDecodeError) as error:
        raise MediaError("The media information could not be read.") from error


async def download_audio(url: str, directory: Path) -> Path:
    source = youtube_source(url)
    await youtube_metadata(source.url)
    await run_tool([
        *_youtube_args(), "--max-filesize", str(MAX_MEDIA_BYTES), "-f", "bestaudio",
        "--match-filter", "!is_live & !is_upcoming & duration <= 18000",
        "--output", str(directory / "download.%(ext)s"), "--", source.url,
    ], timeout=3600)
    files = [p for p in directory.glob("download.*") if p.suffix not in (".part", ".ytdl")]
    if len(files) != 1 or files[0].stat().st_size > MAX_MEDIA_BYTES:
        raise MediaError("No usable audio track was downloaded.")
    return files[0]


async def extract_audio(source: Path, directory: Path) -> Path:
    await local_metadata(source)
    output = directory / "audio.m4a"
    await run_tool([tool_path("ffmpeg"), "-nostdin", "-v", "error", "-y",
                    "-protocol_whitelist", "file,pipe", "-i", str(source),
                    "-map", "0:a:0", "-vn", "-c:a", "aac", "-b:a", "128k",
                    "-fs", str(MAX_MEDIA_BYTES), str(output)], timeout=3600)
    if not output.is_file() or output.stat().st_size >= MAX_MEDIA_BYTES:
        raise MediaError("The extracted audio exceeded the supported size.")
    return output


async def decode_pcm16k(source: Path, directory: Path) -> Path:
    """Decode the first audio track to raw 16 kHz mono PCM16 for on-device transcription."""
    output = directory / "audio.s16le"
    await run_tool([tool_path("ffmpeg"), "-nostdin", "-v", "error", "-y",
                    "-protocol_whitelist", "file,pipe", "-i", str(source),
                    "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-f", "s16le",
                    "-t", str(MAX_DURATION_MS // 1000), str(output)], timeout=3600)
    if not output.is_file() or output.stat().st_size < 2:
        raise MediaError("The file has no decodable audio track.")
    return output
