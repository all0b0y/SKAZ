"""Bounded cancellable media tools. No shell, browser cookies or user config.

Video links come from the host table of ``media_source`` (YouTube, VK Video,
RuTube, Vimeo — decision 40): one public video, canonical URL, ``yt-dlp
--no-playlist``. Refusals are plain fixed sentences (playlist, private or
sign-in, 18+, live, unavailable); raw tool output never leaves this module.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import math
import os
import re
import shutil
import signal
import sys
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

from .media_source import PLATFORM_LABELS, VideoPlatform, VideoSource, video_source, youtube_source

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


#: Maps a failed tool's stderr to one of a few fixed user-facing sentences (never the text itself).
Explain = Callable[[str], str | None]
GENERIC_FAILURE = (
    "Media tool failed. The source may be unavailable, require sign-in, "
    "or use an unsupported format. Try a local media file."
)


async def run_tool(argv: list[str], *, timeout: float = 120, max_output: int = 2_000_000,
                   explain: Explain | None = None) -> str:
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
            stdout, stderr = await asyncio.gather(*readers)
            if await process.wait() != 0:
                reason = explain(stderr.decode("utf-8", errors="replace")) if explain else None
                raise MediaError(reason or GENERIC_FAILURE)
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


PLAYLIST = "This is a playlist. Paste a link to a single video."
LIVE = "This is a live stream. SKAZ can add the video after the broadcast is over."
UPCOMING = "This broadcast hasn't started yet."
POST_LIVE = "This broadcast has just ended and isn't processed yet. Try again later."
PRIVATE = "This video is private or needs a sign-in. SKAZ can only add public videos."
ADULT = "This video is age-restricted (18+). SKAZ can't add it."
UNAVAILABLE = "This video is unavailable: it was removed, is blocked in your region, or the link is wrong."
UNREACHABLE = "SKAZ couldn't reach the video site. Check the internet connection and try again."
#: yt-dlp error wording → the honest reason. Order matters: the first match wins.
_FAILURES: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"confirm your age|age[- ]restricted|inappropriate for some users|18\+", re.I), ADULT),
    (re.compile(r"private video|video is private|members[- ]only|only available to (?:members|subscribers)"
                r"|log(?:ged)? in|sign in|requires authentication|password", re.I), PRIVATE),
    (re.compile(r"live event will begin|premieres? in|upcoming", re.I), UPCOMING),
    (re.compile(r"is live|live stream|currently live|is_live", re.I), LIVE),
    (re.compile(r"playlist", re.I), PLAYLIST),
    (re.compile(r"video unavailable|not available|has been removed|does not exist|no longer available"
                r"|http error 40[34]|not found|blocked", re.I), UNAVAILABLE),
    (re.compile(r"unable to download|failed to resolve|name resolution|timed out|connection|network"
                r"|http error 5\d\d|ssl", re.I), UNREACHABLE),
)


def explain_video_failure(stderr: str) -> str | None:
    """The honest reason behind a failed yt-dlp call, or ``None`` (generic message)."""
    errors = [line for line in stderr.splitlines() if "ERROR" in line] or stderr.splitlines()[-5:]
    text = "\n".join(errors)
    for pattern, reason in _FAILURES:
        if pattern.search(text):
            return reason
    return None


def video_refusal(info: Mapping[str, Any]) -> str | None:
    """Why the video described by yt-dlp metadata can't be added, or ``None`` when it can."""
    if info.get("_type") in ("playlist", "multi_video"):
        return PLAYLIST
    live = info.get("live_status")
    if info.get("is_live") or live == "is_live":
        return LIVE
    if info.get("is_upcoming") or live == "is_upcoming":
        return UPCOMING
    if live == "post_live":
        return POST_LIVE
    if info.get("availability") in ("private", "needs_auth", "premium_only", "subscriber_only"):
        return PRIVATE
    age = info.get("age_limit")
    if isinstance(age, (int, float)) and not isinstance(age, bool) and age >= 18:
        return ADULT
    return None


def _ytdlp_args(platform: VideoPlatform, retries: int = 2) -> list[str]:
    """yt-dlp without config, plugins, cookies or playlists; YouTube also needs the bundled deno."""
    argv = [tool_path("yt-dlp"), "--ignore-config", "--no-plugin-dirs", "--no-playlist",
            "--no-warnings", "--no-progress"]
    if platform == "youtube":
        argv += ["--no-remote-components", "--js-runtimes", f"deno:{tool_path('deno')}"]
    return [*argv, "--socket-timeout", "20", "--retries", str(retries)]


async def video_info(url: str, *, timeout: float = 120) -> dict[str, Any]:
    """Raw yt-dlp metadata of one video on a supported host (no download). The one metadata call."""
    source = video_source(url)
    raw = await run_tool([*_ytdlp_args(source.platform), "--skip-download", "--dump-single-json", "--",
                          source.url], timeout=timeout, explain=explain_video_failure)
    try:
        info = json.loads(raw)
    except json.JSONDecodeError as error:
        raise MediaError(f"{source.label} returned unreadable video information.") from error
    if not isinstance(info, dict):
        raise MediaError(f"{source.label} returned unreadable video information.")
    return info


async def _metadata(source: VideoSource) -> dict[str, Any]:
    info = await video_info(source.url)
    refusal = video_refusal(info)
    if refusal is not None:
        raise MediaError(refusal)
    if source.platform == "youtube" and info.get("id") != source.video_id:
        raise MediaError(f"{source.label} returned information about another video.")
    if info.get("availability") not in (None, "public", "unlisted"):
        raise MediaError("Only available, finished public videos can be imported.")
    return {"url": source.url, "video_id": source.video_id, "platform": source.platform,
            "title": str(info.get("title") or f"{PLATFORM_LABELS[source.platform]} video")[:200],
            "duration_ms": _duration(info.get("duration"))}


async def youtube_metadata(url: str) -> dict[str, Any]:
    source = youtube_source(url)
    return await _metadata(VideoSource("youtube", source.video_id, source.url))


async def video_metadata(url: str) -> dict[str, Any]:
    """Title and duration of one public, finished video on YouTube, VK Video, RuTube or Vimeo.

    YouTube keeps going through ``youtube_metadata`` (the legacy import's own entry point).
    """
    source = video_source(url)
    if source.platform == "youtube":
        return await youtube_metadata(source.url)
    return await _metadata(source)


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
    """The best audio track of one video on a supported host (``--no-playlist``, at most 2 GiB)."""
    source = video_source(url)
    await video_metadata(source.url)
    await run_tool([
        *_ytdlp_args(source.platform), "--max-filesize", str(MAX_MEDIA_BYTES), "-f", "bestaudio/best",
        "--match-filter", "!is_live & !is_upcoming & duration <= 18000",
        "--output", str(directory / "download.%(ext)s"), "--", source.url,
    ], timeout=3600, explain=explain_video_failure)
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
