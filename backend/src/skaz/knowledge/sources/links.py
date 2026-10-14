"""What a pasted link is, in three steps (decision 40).

1. No network: the video host table (``media_source.video_source``: YouTube,
   VK Video, RuTube, Vimeo, strict single-video check) and file extensions.
2. Unknown address: one light request — its Content-Type, OpenGraph
   ``og:type=video``/``og:video`` in the page head, and (only if the head
   names one and OpenGraph said nothing) the page's oEmbed document.
3. Otherwise a site: the article text can be added.

The result is a ``LinkInfo`` with a kind and a label ("YouTube · 1:12:30",
"habr.com · article"). Videos are only identified and validated here;
downloading and transcribing them belongs to the speech import (S2).
"""

from __future__ import annotations

import json
import math
import re
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, replace
from typing import Any, Literal
from urllib.parse import urljoin, urlsplit

from ... import media_tools
from ...media_source import PLATFORM_LABELS, InvalidMediaSource, VideoPlatform, match_video_host, video_source
from .fetch import Fetched, FetchFailed, LinkRejected, SafeFetcher, check_url
from .fragments import sanitize_title
from .html import decode_html

LinkKind = Literal["video", "audio_file", "video_file", "pdf", "site"]
VideoProbe = Callable[[str], Awaitable[Mapping[str, Any]]]

VIDEO_EXTENSIONS = frozenset({".mp4", ".mov", ".m4v", ".webm", ".mkv"})
AUDIO_EXTENSIONS = frozenset({".mp3", ".m4a", ".wav", ".ogg", ".flac", ".aac", ".opus"})
PROBE_BYTES = 512 * 1024
OEMBED_BYTES = 64 * 1024
UNSUPPORTED_VIDEO = (
    "SKAZ adds videos from YouTube, VK Video, RuTube and Vimeo. "
    "The text of this page can be added as an article."
)


@dataclass(frozen=True)
class LinkInfo:
    kind: LinkKind
    #: The address SKAZ will use: the canonical single-video URL for videos, otherwise as entered.
    url: str
    domain: str
    #: "YouTube · 1:12:30", "habr.com · article", "example.org · PDF".
    label: str
    platform: VideoPlatform | None = None
    video_id: str | None = None
    title: str | None = None
    duration_ms: int | None = None
    #: False when SKAZ can't add the link as this kind (e.g. a video on an unsupported site).
    supported: bool = True
    #: A plain-English remark for the UI (why unsupported, a failed metadata check…).
    note: str | None = None


def domain_of(url: str) -> str:
    host = (urlsplit(url).hostname or "").lower()
    return host[4:] if host.startswith("www.") else host


def format_duration(ms: int) -> str:
    seconds = max(0, ms // 1000)
    hours, rest = divmod(seconds, 3600)
    minutes, secs = divmod(rest, 60)
    return f"{hours}:{minutes:02d}:{secs:02d}" if hours else f"{minutes}:{secs:02d}"


def _video_label(platform: str, duration_ms: int | None) -> str:
    return f"{platform} · {format_duration(duration_ms)}" if duration_ms else f"{platform} · video"


def _extension(url: str) -> str:
    path = urlsplit(url).path.lower()
    dot = path.rfind(".")
    return path[dot:] if dot > path.rfind("/") else ""


def classify_offline(value: str) -> LinkInfo | None:
    """Step 1. ``None`` when a request is needed; ``LinkRejected`` for bad or unsupported video links."""
    url = check_url(value)
    if match_video_host(url) is not None:
        try:
            source = video_source(url)
        except InvalidMediaSource as error:
            raise LinkRejected(str(error)) from error
        return LinkInfo(
            "video",
            source.url,
            domain_of(source.url),
            _video_label(source.label, None),
            platform=source.platform,
            video_id=source.video_id,
        )
    domain = domain_of(url)
    extension = _extension(url)
    if extension == ".pdf":
        return LinkInfo("pdf", url, domain, f"{domain} · PDF")
    if extension in VIDEO_EXTENSIONS:
        return LinkInfo("video_file", url, domain, f"{domain} · video file")
    if extension in AUDIO_EXTENSIONS:
        return LinkInfo("audio_file", url, domain, f"{domain} · audio file")
    return None


def interpret_video_info(info: Mapping[str, Any]) -> tuple[str | None, int | None]:
    """Honest refusals from downloader metadata (yt-dlp JSON); ``(title, duration_ms)`` otherwise."""
    if info.get("_type") in ("playlist", "multi_video"):
        raise LinkRejected("This is a playlist. Paste a link to a single video.")
    live = info.get("live_status")
    if info.get("is_live") or live == "is_live":
        raise LinkRejected("This is a live stream. SKAZ can add the video after the broadcast is over.")
    if live == "is_upcoming":
        raise LinkRejected("This broadcast hasn't started yet.")
    if live == "post_live":
        raise LinkRejected("This broadcast has just ended and isn't processed yet. Try again later.")
    availability = info.get("availability")
    if availability in ("private", "needs_auth", "premium_only", "subscriber_only"):
        raise LinkRejected("This video is private or needs a sign-in. SKAZ can only add public videos.")
    age = info.get("age_limit")
    if isinstance(age, (int, float)) and age >= 18:
        raise LinkRejected("This video is age-restricted (18+). SKAZ can't add it.")
    duration = info.get("duration")
    duration_ms = None
    if isinstance(duration, (int, float)) and math.isfinite(duration) and duration > 0:
        duration_ms = round(duration * 1000)
    title = info.get("title")
    return (sanitize_title(str(title)) if title else None), duration_ms


_META = re.compile(r"<meta\s[^>]*>", re.IGNORECASE)
_LINK = re.compile(r"<link\s[^>]*>", re.IGNORECASE)
_ATTR = re.compile(r"""([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))""")
_TITLE = re.compile(r"<title[^>]*>(.*?)</title>", re.IGNORECASE | re.DOTALL)


def _attributes(tag: str) -> dict[str, str]:
    return {name.lower(): (a or b or c) for name, a, b, c in _ATTR.findall(tag)}


@dataclass(frozen=True)
class PageHead:
    og: dict[str, str]
    title: str | None
    oembed: str | None


def read_head(html: str) -> PageHead:
    """OpenGraph properties, the title and the JSON oEmbed link from the start of a page."""
    head = html[: html.lower().find("</head>")] if "</head>" in html.lower() else html
    og: dict[str, str] = {}
    for tag in _META.findall(head):
        attrs = _attributes(tag)
        key = (attrs.get("property") or attrs.get("name") or "").lower()
        if key.startswith(("og:", "video:")) and "content" in attrs:
            og.setdefault(key, attrs["content"].strip())
    oembed = None
    for tag in _LINK.findall(head):
        attrs = _attributes(tag)
        if attrs.get("type", "").lower() == "application/json+oembed" and attrs.get("href"):
            oembed = attrs["href"]
            break
    title_match = _TITLE.search(head)
    title = og.get("og:title") or (title_match.group(1).strip() if title_match else None)
    return PageHead(og, title, oembed)


def _seconds(value: str | None) -> int | None:
    try:
        seconds = float(value) if value else 0.0
    except ValueError:
        return None
    return round(seconds * 1000) if math.isfinite(seconds) and seconds > 0 else None


async def classify_link(
    value: str, fetcher: SafeFetcher, *, video_probe: VideoProbe | None = None
) -> LinkInfo:
    offline = classify_offline(value)
    if offline is not None:
        if offline.kind == "video" and video_probe is not None:
            try:
                info = await video_probe(offline.url)
            except LinkRejected:
                raise
            except media_tools.MediaError as error:
                return replace(offline, note=str(error))
            except Exception:
                return replace(offline, note="SKAZ couldn't check the video details now.")
            title, duration_ms = interpret_video_info(info)
            label = _video_label(PLATFORM_LABELS[offline.platform or "youtube"], duration_ms)
            return replace(offline, title=title, duration_ms=duration_ms, label=label)
        return offline
    url = check_url(value)
    fetched = await fetcher.fetch(url, max_bytes=PROBE_BYTES, allow_partial=True)
    return await _classify_fetched(url, fetched, fetcher)


async def _classify_fetched(url: str, fetched: Fetched, fetcher: SafeFetcher) -> LinkInfo:
    domain = domain_of(url)
    kind = fetched.content_type
    if kind == "application/pdf":
        return LinkInfo("pdf", url, domain, f"{domain} · PDF")
    if kind.startswith("audio/"):
        return LinkInfo("audio_file", url, domain, f"{domain} · audio file")
    if kind.startswith("video/"):
        return LinkInfo("video_file", url, domain, f"{domain} · video file")
    if kind == "text/plain":
        return LinkInfo("site", url, domain, f"{domain} · text")
    if kind not in ("text/html", "application/xhtml+xml", ""):
        return LinkInfo(
            "site",
            url,
            domain,
            f"{domain} · file",
            supported=False,
            note=f"SKAZ can't read this kind of file ({kind}).",
        )
    html = decode_html(fetched.body, fetched.charset)
    head = read_head(html)
    title = sanitize_title(head.title) if head.title else None
    og_type = head.og.get("og:type", "").lower()
    if og_type.startswith("video") or "og:video" in head.og or "og:video:url" in head.og:
        duration = _seconds(head.og.get("video:duration") or head.og.get("og:video:duration"))
        return LinkInfo(
            "video",
            url,
            domain,
            _video_label(domain, duration),
            title=title,
            duration_ms=duration,
            supported=False,
            note=UNSUPPORTED_VIDEO,
        )
    if head.oembed:
        embedded = await _oembed(urljoin(fetched.url, head.oembed), fetcher)
        if embedded.get("type") == "video":
            duration = embedded.get("duration")
            duration_ms = (
                round(float(duration) * 1000) if isinstance(duration, (int, float)) and duration > 0 else None
            )
            return LinkInfo(
                "video",
                url,
                domain,
                _video_label(domain, duration_ms),
                title=title,
                duration_ms=duration_ms,
                supported=False,
                note=UNSUPPORTED_VIDEO,
            )
    return LinkInfo("site", url, domain, f"{domain} · article", title=title)


async def _oembed(url: str, fetcher: SafeFetcher) -> dict[str, Any]:
    try:
        fetched = await fetcher.fetch(
            url, max_bytes=OEMBED_BYTES, allow_partial=False, accept="application/json"
        )
        data = json.loads(fetched.body.decode("utf-8", errors="replace"))
    except (FetchFailed, LinkRejected, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


async def ytdlp_probe(url: str) -> Mapping[str, Any]:
    """Video metadata from the bundled yt-dlp (no download, no cookies, no config, one video).

    The flags mirror the speech import's own yt-dlp call (``media_tools``),
    which stays the only place that downloads.
    """
    argv = [
        media_tools.tool_path("yt-dlp"),
        "--ignore-config",
        "--no-plugin-dirs",
        "--no-playlist",
        "--no-warnings",
        "--no-progress",
        "--socket-timeout",
        "20",
        "--retries",
        "1",
    ]
    if match_video_host(url) == "youtube":
        argv += ["--no-remote-components", "--js-runtimes", f"deno:{media_tools.tool_path('deno')}"]
    raw = await media_tools.run_tool([*argv, "--skip-download", "--dump-single-json", "--", url], timeout=45)
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise ValueError("Unreadable video information.")
    return data
