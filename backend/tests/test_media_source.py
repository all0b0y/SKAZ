"""Untrusted URLs accepted by the media-import boundary."""
from __future__ import annotations

import pytest

from audiohelper.media_source import InvalidMediaSource, youtube_source


@pytest.mark.parametrize("url", [
    "https://www.youtube.com/watch?v=BaW_jenozKc",
    "https://youtu.be/BaW_jenozKc?t=30",
    "https://m.youtube.com/watch?v=BaW_jenozKc&list=ignored",
    "https://www.youtube.com/shorts/BaW_jenozKc",
])
def test_single_video_has_one_identity_and_starts_at_the_beginning(url: str) -> None:
    source = youtube_source(url)
    assert source.video_id == "BaW_jenozKc"
    assert source.url == "https://www.youtube.com/watch?v=BaW_jenozKc"


@pytest.mark.parametrize("url", [
    "file:///etc/passwd", "http://127.0.0.1/video", "https://youtube.com.evil.test/watch?v=BaW_jenozKc",
    "https://user:pass@youtube.com/watch?v=BaW_jenozKc", "https://youtube.com:8443/watch?v=BaW_jenozKc",
    "https://youtube.com/playlist?list=123", "https://youtu.be/short",
    "https://youtube.com/watch?v=BaW_jenozKc&v=AAAAAAAAAAA",
    "https://youtu.be/BaW_jenozKc/extra", "https://youtube.com/watch?v=BaW_jenozKc%0A",
])
def test_non_video_and_ambiguous_sources_are_rejected(url: str) -> None:
    with pytest.raises(InvalidMediaSource):
        youtube_source(url)
