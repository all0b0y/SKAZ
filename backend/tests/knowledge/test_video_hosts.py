"""Step 1 of link classification: the offline video host table in ``media_source``."""

from __future__ import annotations

import pytest

from skaz.media_source import InvalidMediaSource, match_video_host, video_source, youtube_source


@pytest.mark.parametrize(
    ("url", "platform", "video_id", "canonical"),
    [
        (
            "https://youtu.be/dQw4w9WgXcQ",
            "youtube",
            "dQw4w9WgXcQ",
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        ),
        (
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123",
            "youtube",
            "dQw4w9WgXcQ",
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        ),
        (
            "https://vk.com/video-12345_456239017",
            "vk",
            "-12345_456239017",
            "https://vk.com/video-12345_456239017",
        ),
        ("https://vk.com/video12345_67", "vk", "12345_67", "https://vk.com/video12345_67"),
        ("https://vk.com/feed?z=video-1_2%2Fpl_cat_trends", "vk", "-1_2", "https://vk.com/video-1_2"),
        (
            "https://vkvideo.ru/video-220754053_456243093",
            "vk",
            "-220754053_456243093",
            "https://vk.com/video-220754053_456243093",
        ),
        ("https://vk.com/clip-5_6", "vk", "-5_6", "https://vk.com/clip-5_6"),
        ("https://vk.com/video_ext.php?oid=-7&id=8&hash=abc", "vk", "-7_8", "https://vk.com/video-7_8"),
        (
            "https://rutube.ru/video/c6cc4d620b1d4338901770a44b3e82f4/",
            "rutube",
            "c6cc4d620b1d4338901770a44b3e82f4",
            "https://rutube.ru/video/c6cc4d620b1d4338901770a44b3e82f4/",
        ),
        (
            "https://rutube.ru/shorts/c6cc4d620b1d4338901770a44b3e82f4",
            "rutube",
            "c6cc4d620b1d4338901770a44b3e82f4",
            "https://rutube.ru/video/c6cc4d620b1d4338901770a44b3e82f4/",
        ),
        (
            "https://rutube.ru/play/embed/c6cc4d620b1d4338901770a44b3e82f4",
            "rutube",
            "c6cc4d620b1d4338901770a44b3e82f4",
            "https://rutube.ru/video/c6cc4d620b1d4338901770a44b3e82f4/",
        ),
        ("https://vimeo.com/76979871", "vimeo", "76979871", "https://vimeo.com/76979871"),
        (
            "https://vimeo.com/76979871/abc123def0",
            "vimeo",
            "76979871",
            "https://vimeo.com/76979871/abc123def0",
        ),
        (
            "https://player.vimeo.com/video/76979871?h=abc123def0",
            "vimeo",
            "76979871",
            "https://vimeo.com/76979871/abc123def0",
        ),
        ("https://vimeo.com/channels/staffpicks/76979871", "vimeo", "76979871", "https://vimeo.com/76979871"),
    ],
)
def test_single_videos_on_supported_hosts(url: str, platform: str, video_id: str, canonical: str) -> None:
    assert match_video_host(url) == platform
    source = video_source(url)
    assert (source.platform, source.video_id, source.url) == (platform, video_id, canonical)


@pytest.mark.parametrize(
    ("url", "fragment"),
    [
        ("https://www.youtube.com/playlist?list=PL590L5WQmH8fJ54F369BLDSqIwcs-TCfs", "playlist"),
        ("https://vkvideo.ru/playlist/-220754053_3", "playlist"),
        ("https://vk.com/video/playlist/-1_2", "playlist"),
        ("https://vk.com/videos-12345", "playlist"),
        ("https://rutube.ru/plst/123456/", "playlist"),
        ("https://vimeo.com/showcase/9876543", "playlist"),
        ("https://vimeo.com/album/123", "playlist"),
        ("https://rutube.ru/live/video/c6cc4d620b1d4338901770a44b3e82f4/", "live"),
        ("https://vimeo.com/event/123456", "live"),
        ("https://rutube.ru/video/private/c6cc4d620b1d4338901770a44b3e82f4/?p=k", "Private"),
        ("https://vimeo.com/someuser", "single Vimeo video"),
        ("https://rutube.ru/video/not-an-id/", "single RuTube video"),
        ("https://www.youtube.com/@channel", "single YouTube video"),
    ],
)
def test_video_hosts_refuse_anything_but_one_video_honestly(url: str, fragment: str) -> None:
    assert match_video_host(url) is not None
    with pytest.raises(InvalidMediaSource) as error:
        video_source(url)
    assert fragment in str(error.value)


@pytest.mark.parametrize(
    "url",
    [
        "https://vk.com/wall-1_2",
        "https://vk.com/durov",
        "https://habr.com/ru/articles/1/",
        "https://en.wikipedia.org/wiki/Physics",
        "ftp://vimeo.com/76979871",
        "https://user:pw@vimeo.com/76979871",
        "https://evil.example/youtube.com/watch?v=dQw4w9WgXcQ",
        "https://notyoutube.com/watch?v=dQw4w9WgXcQ",
    ],
)
def test_other_addresses_are_not_video_hosts(url: str) -> None:
    assert match_video_host(url) is None
    with pytest.raises(InvalidMediaSource):
        video_source(url)


def test_youtube_source_keeps_its_contract() -> None:
    assert youtube_source("https://youtu.be/dQw4w9WgXcQ").url == "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    with pytest.raises(InvalidMediaSource, match="single YouTube video"):
        youtube_source("https://vimeo.com/76979871")
