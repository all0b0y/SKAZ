"""File-backed web snapshots and opt-in HTTP sinks; no live network or model calls."""
from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import ExitStack
from pathlib import Path

import httpx
import pytest

from skaz.knowledge.permissions.web_snapshot import WebText, decoded_chunks, page_file
from skaz.knowledge.sources.fetch import FetchFailed, SafeFetcher


@pytest.mark.parametrize("offset", [0, 1, 7999, 8000, 8191, 8192, 8193, 16000, 18001])
def test_disk_text_seeks_by_characters_not_utf8_bytes(tmp_path: Path, offset: int) -> None:
    body = "Начало — 😀. " * 2500 + "END"
    with ExitStack() as owner:
        text = WebText(page_file(tmp_path, owner), tmp_path)
        for start in range(0, len(body), 733):
            text.add(body[start:start + 733])
        text.finish()
        assert text.length == len(body)
        assert text.read(offset, 8000) == body[offset:offset + 8000]


def test_late_invalid_utf8_uses_the_same_whole_document_fallback(tmp_path: Path) -> None:
    body = "ASCII prefix " * 6000 + "Русский конец."
    with ExitStack() as owner:
        raw = page_file(tmp_path, owner)
        raw.write(body.encode("cp1251"))
        assert "".join(decoded_chunks(raw, None)) == body


class Body(httpx.AsyncByteStream):
    def __init__(self) -> None:
        self.parts = 0
        self.closed = False

    async def __aiter__(self) -> AsyncIterator[bytes]:
        for _ in range(100):
            self.parts += 1
            yield b"raw-payload" * 4000

    async def aclose(self) -> None:
        self.closed = True


def network(body: Body, content_type: str = "text/plain") -> SafeFetcher:
    async def resolve(_host: str) -> list[str]:
        return ["93.184.216.34"]

    def respond(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, headers={"Content-Type": content_type}, stream=body)

    return SafeFetcher(transport=httpx.MockTransport(respond), resolver=resolve)


async def test_unknown_length_large_body_streams_to_file_not_fetched_body(tmp_path: Path) -> None:
    body = Body()
    lengths: list[int] = []
    with (tmp_path / "controlled-response").open("w+b") as output:
        def write(chunk: bytes) -> int:
            lengths.append(len(chunk))
            return output.write(chunk)

        fetched = await network(body).fetch("https://public.example.org/article", max_bytes=None,
                                            write_body=write, pin_address=True)
        assert fetched.body == b"" and not fetched.truncated
        assert body.parts == 100 and body.closed
        assert max(lengths) <= 64 * 1024
        assert output.tell() == sum(lengths) > 2 * 1024 * 1024


async def test_unsupported_mime_is_refused_before_download(tmp_path: Path) -> None:
    body = Body()
    with (tmp_path / "controlled-response").open("w+b") as output:
        with pytest.raises(FetchFailed, match="format cannot be read"):
            await network(body, "application/pdf").fetch(
                "https://public.example.org/article", max_bytes=None, write_body=output.write,
                content_types={"text/html", "text/plain"}, pin_address=True)
        assert output.tell() == 0
    assert body.parts == 0 and body.closed


async def test_uncapped_fetch_cannot_accidentally_accumulate_in_memory() -> None:
    body = Body()
    with pytest.raises(ValueError, match="streaming body writer"):
        await network(body).fetch("https://public.example.org/article", max_bytes=None)
    assert body.parts == 0


async def test_normal_fetch_size_limits_remain_enforced() -> None:
    body = Body()
    with pytest.raises(FetchFailed, match="larger than"):
        await network(body).fetch("https://public.example.org/article", max_bytes=100_000)
    assert body.closed and body.parts < 100
