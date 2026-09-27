"""Validate untrusted source URLs before invoking any downloader."""
from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import parse_qs, urlsplit


class InvalidMediaSource(ValueError):
    """The source is not a supported public single-video URL."""


@dataclass(frozen=True)
class YouTubeSource:
    video_id: str
    url: str


def youtube_source(value: str) -> YouTubeSource:
    message = "Enter a single YouTube video link (not a playlist or another website)."
    if len(value) > 4096 or any(ord(char) < 32 for char in value):
        raise InvalidMediaSource(message)
    try:
        url = urlsplit(value.strip())
        if (url.scheme not in ("https", "http") or url.username is not None
                or url.password is not None or url.port is not None):
            raise InvalidMediaSource(message)
        host = url.hostname
        parts = url.path.strip("/").split("/")
        video_id = ""
        if host in ("youtu.be", "www.youtu.be") and len(parts) == 1:
            video_id = parts[0]
        elif host in ("youtube.com", "www.youtube.com", "m.youtube.com"):
            if url.path == "/watch":
                ids = parse_qs(url.query, keep_blank_values=True).get("v", [])
                if len(ids) == 1:
                    video_id = ids[0]
            elif len(parts) == 2 and parts[0] in ("shorts", "embed", "live"):
                video_id = parts[1]
        if not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
            raise InvalidMediaSource(message)
    except ValueError as error:
        raise InvalidMediaSource(message) from error
    return YouTubeSource(video_id, f"https://www.youtube.com/watch?v={video_id}")
