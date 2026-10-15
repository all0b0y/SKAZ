"""The video downloader accepts exactly the S1 host table (YouTube, VK Video, RuTube, Vimeo).

yt-dlp is a fake executable in ``tmp_path`` (``SKAZ_MEDIA_TOOLS_DIR``) that
prints scripted metadata and records its argv: this proves the flags, the
strict address check and the honest refusals, not what the real sites return.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import pytest

from skaz import media_tools
from skaz.knowledge.sources.fetch import LinkRejected
from skaz.knowledge.sources.links import interpret_video_info
from skaz.knowledge.speech.media import UnsupportedMedia, classify_video_link
from skaz.media_source import InvalidMediaSource

FAKE_YTDLP = r"""
import json, sys
scenario = json.load(open(%(scenario)r))
with open(%(record)r, "a") as handle:
    handle.write(json.dumps(sys.argv[1:]) + "\n")
if scenario.get("stderr"):
    sys.stderr.write(scenario["stderr"])
    sys.exit(1)
if "--dump-single-json" in sys.argv:
    print(json.dumps(scenario["info"]))
else:
    out = sys.argv[sys.argv.index("--output") + 1].replace("%%(ext)s", "m4a")
    open(out, "wb").write(b"audio")
"""


class FakeTools:
    def __init__(self, directory: Path) -> None:
        directory.mkdir(parents=True, exist_ok=True)
        self.directory = directory
        self.scenario = directory / "scenario.json"
        self.record = directory / "calls.jsonl"
        script = directory / "yt-dlp"
        script.write_text(
            f"#!{sys.executable}\n"
            + FAKE_YTDLP % {"scenario": str(self.scenario), "record": str(self.record)}
        )
        script.chmod(0o755)
        deno = directory / "deno"
        deno.write_text("#!/bin/sh\nexit 0\n")
        deno.chmod(0o755)
        self.play(info={})

    def play(self, *, info: dict[str, Any] | None = None, stderr: str | None = None) -> None:
        self.scenario.write_text(json.dumps({"info": info or {}, "stderr": stderr}), encoding="utf-8")

    def calls(self) -> list[list[str]]:
        if not self.record.exists():
            return []
        return [json.loads(line) for line in self.record.read_text(encoding="utf-8").splitlines()]


@pytest.fixture
def tools(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> FakeTools:
    fake = FakeTools(tmp_path / "media-tools")
    monkeypatch.setenv("SKAZ_MEDIA_TOOLS_DIR", str(fake.directory))
    return fake


VIDEOS = [
    ("https://youtu.be/dQw4w9WgXcQ", "youtube", "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"),
    (
        "https://vkvideo.ru/video-220754053_456243093",
        "vk",
        "https://vk.com/video-220754053_456243093",
        "-220754053_456243093",
    ),
    (
        "https://rutube.ru/video/c6cc4d620b1d4338901770a44b3e82f4/",
        "rutube",
        "https://rutube.ru/video/c6cc4d620b1d4338901770a44b3e82f4/",
        "c6cc4d620b1d4338901770a44b3e82f4",
    ),
    ("https://vimeo.com/76979871", "vimeo", "https://vimeo.com/76979871", "76979871"),
]


@pytest.mark.parametrize(("url", "platform", "canonical", "video_id"), VIDEOS)
async def test_metadata_for_every_host_uses_the_canonical_single_video_url(
    tools: FakeTools,
    url: str,
    platform: str,
    canonical: str,
    video_id: str,
) -> None:
    tools.play(info={"id": video_id, "title": "Lecture 1", "duration": 95.0, "availability": "public"})
    info = await media_tools.video_metadata(url)
    assert info == {
        "url": canonical,
        "video_id": video_id,
        "platform": platform,
        "title": "Lecture 1",
        "duration_ms": 95_000,
    }
    (argv,) = tools.calls()
    assert argv[-2:] == ["--", canonical]
    assert "--no-playlist" in argv and "--ignore-config" in argv and "--skip-download" in argv
    # Only YouTube needs the bundled JavaScript runtime.
    assert ("--js-runtimes" in argv) == (platform == "youtube")


async def test_download_is_single_video_bounded_and_audio_only(tools: FakeTools, tmp_path: Path) -> None:
    tools.play(info={"id": "76979871", "title": "Talk", "duration": 61})
    work = tmp_path / "work"
    work.mkdir()
    path = await media_tools.download_audio("https://vimeo.com/76979871", work)
    assert path.read_bytes() == b"audio"
    download = tools.calls()[-1]
    assert "--no-playlist" in download and download[-1] == "https://vimeo.com/76979871"
    assert download[download.index("--max-filesize") + 1] == str(media_tools.MAX_MEDIA_BYTES)
    assert "!is_live" in download[download.index("--match-filter") + 1]


@pytest.mark.parametrize(
    "url",
    [
        "https://example.com/watch?v=dQw4w9WgXcQ",
        "https://vimeo.com/showcase/1",
        "https://rutube.ru/plst/123/",
        "https://www.youtube.com/playlist?list=PL1",
    ],
)
async def test_other_addresses_never_reach_the_downloader(tools: FakeTools, url: str, tmp_path: Path) -> None:
    with pytest.raises(InvalidMediaSource):
        await media_tools.video_metadata(url)
    with pytest.raises(InvalidMediaSource):
        await media_tools.download_audio(url, tmp_path)
    assert tools.calls() == []


@pytest.mark.parametrize(
    ("info", "reason"),
    [
        ({"_type": "playlist"}, media_tools.PLAYLIST),
        ({"is_live": True}, media_tools.LIVE),
        ({"live_status": "is_upcoming"}, media_tools.UPCOMING),
        ({"availability": "private"}, media_tools.PRIVATE),
        ({"availability": "needs_auth"}, media_tools.PRIVATE),
        ({"age_limit": 18}, media_tools.ADULT),
    ],
)
async def test_metadata_refusals_are_honest(tools: FakeTools, info: dict[str, Any], reason: str) -> None:
    tools.play(info={"id": "76979871", "title": "x", "duration": 10, **info})
    with pytest.raises(media_tools.MediaError) as error:
        await media_tools.video_metadata("https://vimeo.com/76979871")
    assert str(error.value) == reason
    # The link preview (S1) uses the same wording.
    with pytest.raises(LinkRejected) as rejected:
        interpret_video_info(info)
    assert rejected.value.message == reason


@pytest.mark.parametrize(
    ("stderr", "reason"),
    [
        ("ERROR: [vimeo] 1: This video is private\n", media_tools.PRIVATE),
        (
            "ERROR: [youtube] x: Sign in to confirm your age. This video may be inappropriate\n",
            media_tools.ADULT,
        ),
        ("ERROR: [rutube] x: Video unavailable\n", media_tools.UNAVAILABLE),
        ("ERROR: [vk] x: This live event will begin in 3 hours\n", media_tools.UPCOMING),
        (
            "ERROR: Unable to download webpage: <urlopen error [Errno 8] nodename nor servname provided>\n",
            media_tools.UNREACHABLE,
        ),
    ],
)
async def test_tool_failures_become_fixed_reasons_never_raw_output(
    tools: FakeTools,
    stderr: str,
    reason: str,
) -> None:
    tools.play(stderr=stderr + "secret-cookie=abc\n")
    with pytest.raises(media_tools.MediaError) as error:
        await media_tools.video_metadata("https://rutube.ru/video/c6cc4d620b1d4338901770a44b3e82f4/")
    assert str(error.value) == reason
    assert "secret" not in str(error.value)


@pytest.mark.parametrize(("url", "platform", "canonical", "video_id"), VIDEOS)
def test_speech_import_uses_the_same_host_table(
    url: str, platform: str, canonical: str, video_id: str
) -> None:
    link = classify_video_link(url)
    assert (link.url, link.video_id, link.host) == (canonical, video_id, platform)


def test_speech_import_refuses_what_the_table_refuses() -> None:
    for url in ("https://example.com/v/1", "https://vimeo.com/showcase/1", "https://vk.com/id1"):
        with pytest.raises(UnsupportedMedia):
            classify_video_link(url)
