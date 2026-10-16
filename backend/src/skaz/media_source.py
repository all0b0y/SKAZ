"""Validate untrusted source URLs before invoking any downloader.

``youtube_source`` is the original single-host check. ``video_source`` extends
it with the host table of decision 40 (YouTube, VK Video, RuTube, Vimeo): the
same strictness — one public video, no playlists, channels or other sites —
and a canonical URL for ``yt-dlp --no-playlist``.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal
from urllib.parse import SplitResult, parse_qs, unquote, urlsplit


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


VideoPlatform = Literal["youtube", "vk", "rutube", "vimeo"]
PLATFORM_LABELS: dict[VideoPlatform, str] = {
    "youtube": "YouTube", "vk": "VK Video", "rutube": "RuTube", "vimeo": "Vimeo",
}
_YOUTUBE_HOSTS = frozenset({"youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "www.youtu.be"})
_VKVIDEO_HOSTS = frozenset({"vkvideo.ru", "www.vkvideo.ru", "m.vkvideo.ru"})
_VK_HOSTS = frozenset({"vk.com", "www.vk.com", "m.vk.com", "vk.ru", "www.vk.ru", "m.vk.ru"})
_RUTUBE_HOSTS = frozenset({"rutube.ru", "www.rutube.ru", "m.rutube.ru"})
_VIMEO_HOSTS = frozenset({"vimeo.com", "www.vimeo.com", "player.vimeo.com"})
_VK_ID = re.compile(r"(?:video|clip)(-?\d{1,20})_(\d{1,20})")
_RUTUBE_ID = re.compile(r"[0-9a-f]{32}")
_VIMEO_ID = re.compile(r"\d{1,12}")
_VIMEO_HASH = re.compile(r"[0-9a-f]{6,20}")


@dataclass(frozen=True)
class VideoSource:
    platform: VideoPlatform
    video_id: str
    #: Canonical single-video URL handed to the downloader.
    url: str

    @property
    def label(self) -> str:
        return PLATFORM_LABELS[self.platform]


def _split(value: str) -> SplitResult | None:
    """A plain public http(s) URL, or ``None``. No credentials, no explicit port."""
    if len(value) > 4096 or any(ord(char) < 32 for char in value):
        return None
    try:
        url = urlsplit(value.strip())
        if (url.scheme not in ("https", "http") or url.username is not None
                or url.password is not None or url.port is not None or not url.hostname):
            return None
    except ValueError:
        return None
    return url


def _vk_video_path(url: SplitResult) -> bool:
    path = url.path.lower()
    query = parse_qs(url.query)
    return (path.startswith(("/video", "/clip", "/videos"))
            or any(item.startswith("video") for item in query.get("z", [])))


def match_video_host(value: str) -> VideoPlatform | None:
    """Step 1 (no network): the platform when the address is on a supported video host.

    ``vk.com`` also hosts profiles and posts, so only its video paths count.
    A match does not mean the address is a valid single video: see ``video_source``.
    """
    url = _split(value)
    if url is None:
        return None
    host = (url.hostname or "").lower()
    if host in _YOUTUBE_HOSTS:
        return "youtube"
    if host in _VKVIDEO_HOSTS or (host in _VK_HOSTS and _vk_video_path(url)):
        return "vk"
    if host in _RUTUBE_HOSTS:
        return "rutube"
    if host in _VIMEO_HOSTS:
        return "vimeo"
    return None


def _single(platform: VideoPlatform) -> InvalidMediaSource:
    return InvalidMediaSource(
        f"Enter a link to a single {PLATFORM_LABELS[platform]} video (not a channel or another page)."
    )


_PLAYLIST = "This is a playlist. Paste a link to a single video."
_LIVE = "This is a live stream. SKAZ can add the video after the broadcast is over."


def _youtube(value: str, url: SplitResult) -> VideoSource:
    if url.path.rstrip("/") == "/playlist":
        raise InvalidMediaSource(_PLAYLIST)
    try:
        source = youtube_source(value)
    except InvalidMediaSource as error:
        raise _single("youtube") from error
    return VideoSource("youtube", source.video_id, source.url)


def _vk(url: SplitResult) -> VideoSource:
    path = url.path.strip("/")
    query = parse_qs(url.query)
    lowered = path.lower()
    if lowered.startswith(("playlist", "video/playlist", "videos")) or "/playlist" in lowered:
        raise InvalidMediaSource(_PLAYLIST)
    if lowered == "video_ext.php":
        owners, ids = query.get("oid", []), query.get("id", [])
        if (len(owners) == 1 and len(ids) == 1 and re.fullmatch(r"-?\d{1,20}", owners[0])
                and re.fullmatch(r"\d{1,20}", ids[0])):
            return VideoSource("vk", f"{owners[0]}_{ids[0]}", f"https://vk.com/video{owners[0]}_{ids[0]}")
        raise _single("vk")
    match = _VK_ID.fullmatch(path)
    if match is None:
        popups = [unquote(item).split("/", 1)[0] for item in query.get("z", [])]
        found = [_VK_ID.fullmatch(item) for item in popups]
        matches = [item for item in found if item is not None]
        if len(matches) != 1:
            raise _single("vk")
        match = matches[0]
    owner, number = match.group(1), match.group(2)
    kind = "clip" if path.lower().startswith("clip") else "video"
    return VideoSource("vk", f"{owner}_{number}", f"https://vk.com/{kind}{owner}_{number}")


def _rutube(url: SplitResult) -> VideoSource:
    parts = [part for part in url.path.split("/") if part]
    head = parts[0].lower() if parts else ""
    if head in ("plst", "playlist", "channel", "metainfo", "u", "feeds"):
        raise InvalidMediaSource(_PLAYLIST if head in ("plst", "playlist") else _single("rutube").args[0])
    if head == "live":
        raise InvalidMediaSource(_LIVE)
    if head == "video" and len(parts) >= 2 and parts[1].lower() == "private":
        raise InvalidMediaSource("Private RuTube links aren't supported. Use a public video.")
    candidate = ""
    if head in ("video", "shorts") and len(parts) == 2:
        candidate = parts[1]
    elif head == "play" and len(parts) == 3 and parts[1] == "embed":
        candidate = parts[2]
    if not _RUTUBE_ID.fullmatch(candidate):
        raise _single("rutube")
    return VideoSource("rutube", candidate, f"https://rutube.ru/video/{candidate}/")


def _vimeo(url: SplitResult) -> VideoSource:
    parts = [part for part in url.path.split("/") if part]
    head = parts[0].lower() if parts else ""
    if head in ("showcase", "album") or (head == "channels" and len(parts) < 3):
        raise InvalidMediaSource(_PLAYLIST)
    if head == "event":
        raise InvalidMediaSource(_LIVE)
    video_id, secret = "", ""
    if (url.hostname or "").lower() == "player.vimeo.com":
        if len(parts) == 2 and head == "video":
            video_id = parts[1]
            hashes = parse_qs(url.query).get("h", [])
            secret = hashes[0] if len(hashes) == 1 else ""
    elif len(parts) == 1:
        video_id = parts[0]
    elif len(parts) == 2 and _VIMEO_ID.fullmatch(parts[0]):
        video_id, secret = parts
    elif head == "channels" and len(parts) == 3:
        video_id = parts[2]
    elif head == "groups" and len(parts) == 4 and parts[2] == "videos":
        video_id = parts[3]
    if not _VIMEO_ID.fullmatch(video_id) or (secret and not _VIMEO_HASH.fullmatch(secret)):
        raise _single("vimeo")
    canonical = f"https://vimeo.com/{video_id}" + (f"/{secret}" if secret else "")
    return VideoSource("vimeo", video_id, canonical)


def video_source(value: str) -> VideoSource:
    """One public video on a supported host, with a canonical URL; honest errors otherwise."""
    platform = match_video_host(value)
    url = _split(value)
    if platform is None or url is None:
        raise InvalidMediaSource(
            "Enter a link to a single video on YouTube, VK Video, RuTube or Vimeo."
        )
    if platform == "youtube":
        return _youtube(value, url)
    if platform == "vk":
        return _vk(url)
    if platform == "rutube":
        return _rutube(url)
    return _vimeo(url)
