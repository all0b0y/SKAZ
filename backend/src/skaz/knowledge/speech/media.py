"""What a speech material is called and what kind it is, decided before anything starts."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from pathlib import PurePath

from ...gateways.soniox_async import SUPPORTED_EXTENSIONS
from ...media_source import InvalidMediaSource, VideoPlatform, video_source
from .carriers import CarrierKind

#: Containers that normally carry a picture: their audio track is extracted first.
VIDEO_EXTENSIONS = frozenset({"mp4", "m4v", "mov", "mkv", "webm", "avi"})
AUDIO_EXTENSIONS = frozenset(SUPPORTED_EXTENSIONS) - VIDEO_EXTENSIONS


class UnsupportedMedia(ValueError):
    """Not a file kind or video link SKAZ can import; the message says why."""


def file_kind(path: PurePath) -> CarrierKind:
    suffix = path.suffix.lower().lstrip(".")
    if suffix in VIDEO_EXTENSIONS:
        return "video"
    if suffix in AUDIO_EXTENSIONS:
        return "audio"
    supported = ", ".join(sorted(AUDIO_EXTENSIONS | VIDEO_EXTENSIONS))
    raise UnsupportedMedia(f"SKAZ can't import .{suffix or '?'} files. Supported: {supported}.")


@dataclass(frozen=True)
class VideoLink:
    url: str
    video_id: str
    host: VideoPlatform


def classify_video_link(url: str) -> VideoLink:
    """A single public video on a supported host, or ``UnsupportedMedia`` with the reason.

    The host table is S1's (``media_source.video_source``: YouTube, VK Video,
    RuTube, Vimeo, strict single-video check, canonical URL); there is no
    second list here.
    """
    try:
        source = video_source(url)
    except InvalidMediaSource as error:
        raise UnsupportedMedia(str(error)) from error
    return VideoLink(source.url, source.video_id, source.platform)


_MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


def default_recording_titles(now: datetime) -> tuple[str, str]:
    """``Recording Oct 15, 2026 14.30`` and, for a second one in the same minute, with seconds.

    English whatever the system locale (the interface is English-only). ``:`` is
    not allowed in names (Finder, Obsidian), so the time uses dots.
    """
    day = f"{_MONTHS[now.month - 1]} {now.day}, {now.year}"
    return f"Recording {day} {now:%H.%M}", f"Recording {day} {now:%H.%M.%S}"
