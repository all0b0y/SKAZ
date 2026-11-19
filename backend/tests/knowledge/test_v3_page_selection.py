"""Selected PDF pages as requested through the real chat routes, with an offline engine."""
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI

from skaz.knowledge.library.library import INBOX_ID
from skaz.knowledge.service import KnowledgeService
from skaz.knowledge.sources.service import SourceService
from skaz.knowledge.sources.visual import parse_explicit_pages
from skaz.runtime import Runtime
from tests.knowledge.chat_support import connect
from tests.knowledge.ingest_support import settle
from tests.knowledge.pdf_fixtures import line, make_pdf
from tests.knowledge.test_source_visual import make_png
from tests.knowledge.test_visual_transport041_wiring import _setup_routing_matrix


@pytest.mark.parametrize(("query", "expected"), [
    ("Compare the charts on pages 2, 4 and 6", [2, 4, 6]),
    ("See pages 2, 4, & 6", [2, 4, 6]),
    ("Read pages 2&4–3", [2, 4, 3]),
    ("Page 8, then pages 2–3", [8, 2, 3]),
    ("Compare page 0 with the chart", [0]),
    ("See pp. 2, 4–5, and 7 and page 2", [2, 4, 5, 7]),
    ("На страницах 6, 4 и 2", [6, 4, 2]),
    ("Read pages 8–6, 8 and 2–3", [8, 7, 6, 2, 3]),
    ("Read pages 2 and 10000", [2, 10000]),
])
def test_parse_page_selectors(query: str, expected: list[int]) -> None:
    assert parse_explicit_pages(query) == expected


def test_direct_explicit_range_order(ready: KnowledgeService, tmp_path: Path) -> None:
    source = SourceService(ready, page_renderer=lambda _pdf, _page: make_png())
    path = tmp_path / "ordered.pdf"
    path.write_bytes(make_pdf([line(f"Chart {i}", 690) for i in range(3)]))
    added = source.add_file(path, INBOX_ID)
    ordered = source.prepare_pdf_pages(added.material_id, page_range=(3, 1))
    assert [item.page for item in ordered] == [3, 2, 1]


@pytest.mark.parametrize(("query", "pages", "error"), [
    ("Compare the charts on pages 2, 4 and 6", [2, 4, 6], None),
    ("Compare the charts on pages 2, 4 & 6", [2, 4, 6], None),
    ("Page 8, then pages 2–3", [8, 2, 3], None),
    ("Compare page 0 with the chart", [], "Page 0 is out of range"),
    ("Read pages 2, 4 & 9", [], "Page 9 is out of range"),
    ("Read pages 1, 2, 3, 4, 5, 6 and 7", [], "at most 6 pages"),
    ("Read pages 1, 2, 3, 4, 5, 6 & 7", [], "at most 6 pages"),
    ("Read pages 2–100000000", [], "out of range"),
])
async def test_routed_explicit_pages(
    kb_client: httpx.AsyncClient, kb_app: FastAPI, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
    query: str, pages: list[int], error: str | None,
) -> None:
    runtime: Runtime = kb_app.state.runtime
    await connect(kb_client, runtime)
    engines = _setup_routing_matrix(runtime)
    path = tmp_path / "report.pdf"
    path.write_bytes(make_pdf([line(f"Chart {i}", 620) for i in range(1, 9)]))
    material = runtime.kb_sources.add_file(path, INBOX_ID)
    rendered: list[int] = []

    def render(_page_pdf: bytes, number: int) -> bytes:
        rendered.append(number)
        return make_png()

    monkeypatch.setattr(runtime.kb_sources.visual, "page_renderer", render)
    chat = await kb_client.post("/kb/chats", json={"engine": "claude_code", "model": "sonnet"})
    chat_id = chat.json()["id"]
    body = {"text": query, "attachments": [material.material_id]}
    pre = await kb_client.post("/kb/chats/visual-preflight", json={"chat_id": chat_id, **body})
    assert pre.status_code == 200 and not rendered
    send = await kb_client.post(f"/kb/chats/{chat_id}/messages", json=body)
    if error:
        assert not pre.json()["supported"] and error in pre.json()["detail"]
        assert send.status_code == 422 and error in send.json()["detail"]
        assert send.json()["code"] == "VISUAL_UNSUPPORTED"
        assert not engines["claude_code"].turns
    else:
        assert pre.json()["supported"] and send.status_code == 202
        await settle(lambda: runtime.kb_chats.state_of(chat_id) == "idle")
        assert [v.locator.page for v in engines["claude_code"].turns[-1].visuals] == pages
    assert rendered == pages
