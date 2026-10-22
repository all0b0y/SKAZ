"""Link classification in three steps; videos are identified, never downloaded here."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any

import httpx
import pytest

from skaz.knowledge.sources.fetch import FetchFailed, LinkRejected, SafeFetcher
from skaz.knowledge.sources.links import LinkInfo, classify_link, classify_offline, interpret_video_info


async def public(_host: str) -> list[str]:
    return ["93.184.216.34"]


def fetcher(
    handler: Callable[[httpx.Request], httpx.Response], calls: list[str] | None = None
) -> SafeFetcher:
    def wrapped(request: httpx.Request) -> httpx.Response:
        if calls is not None:  # by name: the connection itself goes to the checked address (S-05)
            calls.append(str(request.url.copy_with(host=request.headers["host"])))
        return handler(request)

    return SafeFetcher(transport=httpx.MockTransport(wrapped), resolver=public)


def no_network(request: httpx.Request) -> httpx.Response:
    raise AssertionError(f"step 1 must not use the network: {request.url}")


@pytest.mark.parametrize(
    ("url", "kind", "label"),
    [
        ("https://youtu.be/dQw4w9WgXcQ", "video", "YouTube · video"),
        ("https://vkvideo.ru/video-1_2", "video", "VK Video · video"),
        ("https://rutube.ru/video/c6cc4d620b1d4338901770a44b3e82f4/", "video", "RuTube · video"),
        ("https://vimeo.com/76979871", "video", "Vimeo · video"),
        ("https://www.example.org/papers/attention.PDF", "pdf", "example.org · PDF"),
        ("https://cdn.example.org/a/lecture.mp4?sig=1", "video_file", "cdn.example.org · video file"),
        ("https://cdn.example.org/a/podcast.mp3", "audio_file", "cdn.example.org · audio file"),
        ("https://cdn.example.org/a/voice.m4a", "audio_file", "cdn.example.org · audio file"),
        ("https://cdn.example.org/a/talk.wav", "audio_file", "cdn.example.org · audio file"),
        ("https://cdn.example.org/a/clip.mov", "video_file", "cdn.example.org · video file"),
    ],
)
async def test_step_one_needs_no_network(url: str, kind: str, label: str) -> None:
    info = await classify_link(url, fetcher(no_network))
    assert (info.kind, info.label) == (kind, label)


async def test_video_probe_adds_duration_and_title() -> None:
    async def probe(url: str) -> Mapping[str, Any]:
        assert url == "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        return {"title": "Lecture 1: Intro", "duration": 4350, "availability": "public"}

    info = await classify_link("https://youtu.be/dQw4w9WgXcQ", fetcher(no_network), video_probe=probe)
    assert (
        info.label == "YouTube · 1:12:30"
        and info.title == "Lecture 1 - Intro"
        and info.duration_ms == 4_350_000
    )
    assert info.platform == "youtube" and info.video_id == "dQw4w9WgXcQ" and info.supported


@pytest.mark.parametrize(
    ("info", "message"),
    [
        ({"_type": "playlist"}, "playlist"),
        ({"is_live": True}, "live stream"),
        ({"live_status": "is_upcoming"}, "hasn't started"),
        ({"availability": "private"}, "private"),
        ({"availability": "needs_auth"}, "sign-in"),
        ({"age_limit": 18}, "18+"),
    ],
)
def test_honest_video_refusals(info: dict[str, Any], message: str) -> None:
    with pytest.raises(LinkRejected, match=message):
        interpret_video_info(info)


async def test_probe_failure_keeps_the_link_with_a_note() -> None:
    async def broken(_url: str) -> Mapping[str, Any]:
        raise RuntimeError("tool missing")

    info = await classify_link("https://vimeo.com/76979871", fetcher(no_network), video_probe=broken)
    assert info.kind == "video" and info.label == "Vimeo · video" and info.note


async def test_step_two_content_type_and_opengraph() -> None:
    pages = {
        "/doc": httpx.Response(200, headers={"content-type": "application/pdf"}, content=b"%PDF-1.7"),
        "/song": httpx.Response(200, headers={"content-type": "audio/mpeg"}, content=b"ID3"),
        "/clip": httpx.Response(200, headers={"content-type": "video/mp4"}, content=b"...."),
        "/watch": httpx.Response(
            200,
            headers={"content-type": "text/html"},
            text=(
                "<html><head><meta property='og:type' content='video.other'>"
                "<meta property='og:title' content='Talk'><meta property='video:duration' content='95'>"
                "</head><body>x</body></html>"
            ),
        ),
        "/article": httpx.Response(
            200,
            headers={"content-type": "text/html; charset=utf-8"},
            text=("<html><head><title>Хабр: статья</title></head><body><p>Текст</p></body></html>"),
        ),
        "/zip": httpx.Response(200, headers={"content-type": "application/zip"}, content=b"PK"),
    }
    client = fetcher(lambda request: pages[request.url.path])
    results: dict[str, LinkInfo] = {}
    for path in pages:
        results[path] = await classify_link(f"https://site.example{path}", client)
    assert results["/doc"].kind == "pdf"
    assert results["/song"].kind == "audio_file"
    assert results["/clip"].kind == "video_file"
    assert (results["/watch"].kind, results["/watch"].label, results["/watch"].supported) == (
        "video",
        "site.example · 1:35",
        False,
    )
    assert results["/article"].kind == "site" and results["/article"].label == "site.example · article"
    assert results["/article"].title == "Хабр - статья"
    assert results["/zip"].supported is False and "application/zip" in (results["/zip"].note or "")


async def test_oembed_is_read_only_when_opengraph_is_silent() -> None:
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/oembed":
            return httpx.Response(200, json={"type": "video", "duration": 61, "title": "x"})
        return httpx.Response(
            200,
            headers={"content-type": "text/html"},
            text=(
                "<html><head><link rel='alternate' type='application/json+oembed' href='/oembed?u=1'>"
                "</head><body></body></html>"
            ),
        )

    info = await classify_link("https://media.example/v/1", fetcher(handler, calls))
    assert info.kind == "video" and info.label == "media.example · 1:01"
    assert calls == ["https://media.example/v/1", "https://media.example/oembed?u=1"]


async def test_unavailable_site_is_an_honest_error() -> None:
    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    with pytest.raises(FetchFailed, match="couldn't reach"):
        await classify_link("https://down.example/", fetcher(down))


def test_bad_addresses_and_video_host_errors() -> None:
    for url in ("not a url", "ftp://x.example/a", "javascript:alert(1)", "http://[::1]/"):
        with pytest.raises(LinkRejected):
            classify_offline(url)
    with pytest.raises(LinkRejected, match="playlist"):
        classify_offline("https://rutube.ru/plst/1/")
    assert classify_offline("https://habr.com/ru/articles/1/") is None
