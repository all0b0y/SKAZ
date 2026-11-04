"""Long approved page completeness through real registry/runtime and authored HTTP only."""
from __future__ import annotations

import asyncio
import threading

import pytest

from skaz.knowledge.agents.engine import AgentTurn
from skaz.knowledge.agents.tools import ToolContext, ToolInputError, ToolOutcome
from skaz.knowledge.agents.web import WebLink
from skaz.knowledge.permissions import web_read
from skaz.knowledge.permissions.web_read import WebReadArgs
from skaz.knowledge.permissions.web_snapshot import page_file

from .test_w3b_web_tool import env as env
from .test_web_read import ReaderEnv, payload, read_page
from .test_web_read import reader as reader


async def test_a_page_keeps_its_text_beyond_the_old_snapshot_limit(reader: ReaderEnv) -> None:
    body = "Проверяем полный текст — evidence 😀. " * 5000 + "THE REAL END OF THE PAGE."
    assert len(body) > 120_000
    reader.routes["/article"] = (200, {"Content-Type": "text/plain; charset=utf-8"}, body.encode())
    reader.agents["codex"].read_all = True
    await read_page(reader)
    pages = [payload(result) for result in reader.agents["codex"].pages]
    assert "".join(page["text"] for page in pages) == body
    assert all(page["total_chars"] == len(body) and not page["truncated"] for page in pages)
    assert pages[-1]["next_offset"] is None and len(reader.requests) == 1


async def test_heavy_html_with_small_visible_article_is_read_instead_of_rejected(reader: ReaderEnv) -> None:
    article = "The visible scientific article contains controlled evidence and explanations. " * 5
    html = ("<html><head><title>Heavy article</title><script>const ignored = '"
            + "SCRIPT_PAYLOAD" * 170_000
            + "';</script></head><body><article><p>"
            + article + "</p><p>VISIBLE ARTICLE END.</p></article></body></html>")
    assert len(html.encode()) > 2 * 1024 * 1024
    reader.routes["/article"] = (200, {"Content-Type": "text/html; charset=utf-8"}, html.encode())
    _, result = await read_page(reader)
    data = payload(result)
    assert article.strip() in data["text"] and "VISIBLE ARTICLE END." in data["text"]
    assert "SCRIPT_PAYLOAD" not in data["text"] and not data["truncated"]
    assert len(reader.requests) == 1


async def test_runtime_shutdown_closes_the_private_cached_page_files(reader: ReaderEnv) -> None:
    await read_page(reader)
    documents = [snapshot.text for snapshot in reader.app.runtime.kb_web_reader._snapshots.values()]
    assert documents and all(document.read(0, 1) for document in documents)
    await reader.app.runtime.kb_chats.close()
    reader.app.runtime.close()
    for document in documents:
        with pytest.raises(ToolInputError, match="no longer available"):
            document.read(0, 1)


async def test_a_large_plain_page_is_complete_and_keeps_per_call_limits(reader: ReaderEnv) -> None:
    body = "😀" * 530_000 + "VISIBLE COMPLETE END."
    assert len(body.encode()) > 2 * 1024 * 1024
    reader.routes["/article"] = (200, {"Content-Type": "text/plain; charset=utf-8"}, body.encode())
    reader.agents["codex"].read_all = True
    await read_page(reader)
    results = reader.agents["codex"].pages
    pages = [payload(result) for result in results]
    assert "".join(page["text"] for page in pages) == body
    assert all(not page["truncated"] and page["total_chars"] == len(body) for page in pages)
    assert all(len(result.text.encode()) <= 48_000 for result in results)
    assert pages[-1]["next_offset"] is None and len(reader.requests) == 1


async def test_cancelled_preparation_stops_consuming_text_before_releasing_files(
        reader: ReaderEnv, monkeypatch: pytest.MonkeyPatch) -> None:
    from collections.abc import Iterator

    second = "https://papers.example.org/article?document=second"
    reader.app.codex_search.links = (WebLink("First", "https://papers.example.org/article"),
                                     WebLink("Second", second))
    reader.routes["/article"] = (200, {"Content-Type": "text/plain"}, b"A visible controlled first page.")
    entered, released = asyncio.Event(), threading.Event()
    consumed: list[int] = []
    loop = asyncio.get_running_loop()

    def controlled_decode(_source: object, _charset: object, **_kwargs: object) -> Iterator[str]:
        for index in range(100):
            if index == 1:
                loop.call_soon_threadsafe(entered.set)
                assert released.wait(5), "Test barrier was not released"
            consumed.append(index)
            yield "A controlled parser chunk. " * 20

    async def exercise(turn: AgentTurn, _first: ToolOutcome) -> None:
        monkeypatch.setattr(web_read, "decoded_chunks", controlled_decode)
        pending = asyncio.create_task(reader.app.runtime.kb_web_reader.read(
            ToolContext(turn.run_id, "codex"), WebReadArgs(url=second)))
        try:
            await asyncio.wait_for(entered.wait(), 3)
            pending.cancel()
            # Cancellation is queued first; resume the worker on the next event-loop turn.
            loop.call_soon(released.set)
            with pytest.raises(asyncio.CancelledError):
                await pending
        finally:
            released.set()
            await asyncio.gather(pending, return_exceptions=True)

    reader.agents["codex"].after_read = exercise
    await read_page(reader)
    assert len(consumed) <= 2


async def test_parser_deadline_never_publishes_a_partial_document(
        reader: ReaderEnv, monkeypatch: pytest.MonkeyPatch) -> None:
    from collections.abc import Iterator

    clock = [0.0]
    monkeypatch.setattr(web_read, "monotonic", lambda: clock[0])

    def decode(_source: object, _charset: object, **_kwargs: object) -> Iterator[str]:
        yield "PRIVATE PARTIAL DOCUMENT."
        clock[0] = 1000.0
        yield "DO NOT PUBLISH THIS TAIL."

    monkeypatch.setattr(web_read, "decoded_chunks", decode)
    reader.routes["/article"] = (200, {"Content-Type": "text/plain"}, b"controlled source")
    _, result = await read_page(reader)
    assert result.is_error and "too long to process" in result.text
    assert "PRIVATE PARTIAL" not in result.text
    assert not reader.app.runtime.kb_web_reader._snapshots


async def test_repeated_cancellation_closes_all_owned_preparation_files(
        reader: ReaderEnv, monkeypatch: pytest.MonkeyPatch) -> None:
    from collections.abc import Iterator
    from typing import Any

    first = "https://papers.example.org/article"
    second = first + "?document=second"
    reader.app.codex_search.links = (WebLink("First", first), WebLink("Second", second))
    reader.routes["/article"] = (200, {"Content-Type": "text/plain"}, b"controlled visible source")
    loop = asyncio.get_running_loop()
    preparing, closing = asyncio.Event(), asyncio.Event()
    prepare_release, close_release = threading.Event(), threading.Event()
    opened: list[Any] = []
    original_file = page_file

    def track(*args: Any) -> Any:
        file = original_file(*args)
        opened.append(file)
        if len(opened) == 1:
            original_close = file.close

            def held_close() -> None:
                loop.call_soon_threadsafe(closing.set)
                assert close_release.wait(5), "Close barrier was not released"
                original_close()

            monkeypatch.setattr(file, "close", held_close)
        return file

    def decode(*_args: Any, **_kwargs: Any) -> Iterator[str]:
        loop.call_soon_threadsafe(preparing.set)
        assert prepare_release.wait(5), "Prepare barrier was not released"
        yield "A controlled parser chunk."

    async def exercise(turn: AgentTurn, _first: ToolOutcome) -> None:
        monkeypatch.setattr(web_read, "page_file", track)
        monkeypatch.setattr(web_read, "decoded_chunks", decode)
        pending = asyncio.create_task(reader.app.runtime.kb_web_reader.read(
            ToolContext(turn.run_id, "codex"), WebReadArgs(url=second)))
        try:
            await asyncio.wait_for(preparing.wait(), 3)
            pending.cancel()
            loop.call_soon(prepare_release.set)
            await asyncio.wait_for(closing.wait(), 3)
            pending.cancel()
            loop.call_soon(close_release.set)
            with pytest.raises(asyncio.CancelledError):
                await pending
        finally:
            prepare_release.set()
            close_release.set()
            await asyncio.gather(pending, return_exceptions=True)

    reader.agents["codex"].after_read = exercise
    try:
        await read_page(reader)
        assert len(opened) == 2
        assert all(file.closed for file in opened)
    finally:
        for file in opened:
            file.close()
