"""N2 decision 2(1): an exact duplicate — the same DOI, address or file — is answered before ingest.

No second material, no ingest event (so no wiki budget), and for a link no request at all when the
address is already known. Code only: no agent is involved.
"""

from __future__ import annotations

import asyncio
import time
from pathlib import Path
from typing import Any

import httpx
import pytest

from skaz.knowledge.library.fsio import write_atomic
from skaz.knowledge.library.library import INBOX_ID
from skaz.knowledge.markdown.source import FragmentInput, Origin
from skaz.knowledge.service import KnowledgeService
from skaz.knowledge.sources import duplicates
from skaz.knowledge.sources import service as source_service
from skaz.knowledge.sources.duplicates import doi_of, find_duplicate, url_key
from skaz.knowledge.sources.service import SourceEvent, SourceService
from tests.knowledge.pdf_fixtures import line, make_pdf
from tests.knowledge.source_corpus import CLEAN_EN
from tests.knowledge.test_source_service import service_with

ARTICLE = (
    "<html><head><title>Why water boils</title></head><body><article><h1>Why water boils</h1>"
    + "".join(f"<p>{text}</p>" for text in CLEAN_EN[:3])
    + "</article></body></html>"
)


@pytest.mark.parametrize(
    ("a", "b"),
    [
        ("https://Example.COM/a/b", "https://example.com/a/b"),
        ("HTTPS://example.com/a/b/", "https://example.com/a/b"),
        ("https://example.com/a#part-2", "https://example.com/a"),
        ("https://example.com:443/a", "https://example.com/a"),
        ("https://example.com", "https://example.com/"),
        ("https://example.com.", "https://example.com/"),
    ],
)
def test_the_same_address_written_differently_is_one_key(a: str, b: str) -> None:
    assert url_key(a) == url_key(b) is not None


@pytest.mark.parametrize(
    ("a", "b"),
    [
        ("https://example.com/a?page=1", "https://example.com/a?page=2"),  # the query is kept
        ("http://example.com/a", "https://example.com/a"),  # the scheme is kept
        ("https://example.com/A", "https://example.com/a"),  # the path keeps its case
        ("https://example.com/a//", "https://example.com/a"),  # only one trailing slash is dropped
    ],
)
def test_conservative_normalisation_keeps_different_pages_apart(a: str, b: str) -> None:
    assert url_key(a) != url_key(b)


def test_not_a_web_address_has_no_key() -> None:
    assert url_key(None) is None and url_key("ftp://example.com/x") is None and url_key("notes") is None


def test_doi_from_resolver_and_publisher_links() -> None:
    assert doi_of("https://doi.org/10.1000/ABC.123") == "10.1000/abc.123"
    assert doi_of("https://dx.doi.org/10.1000/abc.123/") == "10.1000/abc.123"
    assert doi_of("https://dl.acm.org/doi/10.1145/3290605.3300233") == "10.1145/3290605.3300233"
    assert doi_of("https://onlinelibrary.wiley.com/doi/full/10.1002/xyz.42?af=R") == "10.1002/xyz.42"
    assert doi_of("https://example.com/10.1000/abc") is None
    assert doi_of("https://doi.org/about") is None


def _pdf(tmp_path: Path, name: str, words: str = CLEAN_EN[0]) -> Path:
    path = tmp_path / name
    path.write_bytes(make_pdf([line(words, 700)], title="Lecture"))
    return path


def test_the_same_file_again_is_the_material_already_there(sources: SourceService, tmp_path: Path) -> None:
    events: list[SourceEvent] = []
    sources.subscribe(events.append)
    first = sources.add_file(_pdf(tmp_path, "lecture.pdf"), INBOX_ID)
    copy = tmp_path / "copy" / "renamed.pdf"
    copy.parent.mkdir()
    copy.write_bytes((tmp_path / "lecture.pdf").read_bytes())
    again = sources.add_file(copy, INBOX_ID, to_wiki=True)
    assert again.existing and again.material_id == first.material_id and again.title == first.title
    assert len(sources.kb.materials()) == 1
    assert events == [SourceEvent("material_ready", first.material_id)]  # no second ingest
    origin = sources.kb.material(first.material_id).origin or {}
    assert len(str(origin["sha256"])) == 64


def test_a_different_file_with_the_same_name_is_new(sources: SourceService, tmp_path: Path) -> None:
    first = sources.add_file(_pdf(tmp_path, "lecture.pdf"), INBOX_ID)
    other_dir = tmp_path / "other"
    other_dir.mkdir()
    second = sources.add_file(_pdf(other_dir, "lecture.pdf", CLEAN_EN[1]), INBOX_ID)
    assert not second.existing and second.material_id != first.material_id


def test_a_material_from_before_the_hash_is_found_by_its_kept_original(
        sources: SourceService, tmp_path: Path) -> None:
    pdf = _pdf(tmp_path, "old.pdf")
    kb = sources.kb
    files = kb.create_material(INBOX_ID, "Old lecture", "pdf", [FragmentInput(text=CLEAN_EN[0])],
                               origin=Origin(type="file", file_name="old.pdf"))
    write_atomic(files.directory / ".skaz" / "original.pdf", pdf.read_bytes())
    assert "sha256" not in (kb.material(files.manifest.id).origin or {})
    again = sources.add_file(pdf, INBOX_ID)
    assert again.existing and again.material_id == files.manifest.id


async def test_the_same_link_is_answered_without_a_request(ready: KnowledgeService) -> None:
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        text = ARTICLE.replace(CLEAN_EN[0], CLEAN_EN[3]) if request.url.query else ARTICLE
        return httpx.Response(200, headers={"content-type": "text/html; charset=utf-8"}, text=text)

    sources = service_with(ready, handler)
    first = await sources.add_link("https://blog.example/boiling", INBOX_ID)
    again = await sources.add_link("HTTPS://Blog.Example/boiling/#comments", INBOX_ID)
    assert again.existing and again.material_id == first.material_id
    assert len(seen) == 1 and len(ready.materials()) == 1
    other = await sources.add_link("https://blog.example/boiling?page=2", INBOX_ID)
    assert not other.existing and len(seen) == 2


async def test_a_doi_link_matches_the_same_doi_written_otherwise(ready: KnowledgeService) -> None:
    data = make_pdf([line(CLEAN_EN[0], 700)], title="Paper")
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return httpx.Response(200, headers={"content-type": "application/pdf"}, content=data)

    sources = service_with(ready, handler)
    first = await sources.add_link("https://doi.org/10.1000/ABC", INBOX_ID)
    again = await sources.add_link("https://dx.doi.org/10.1000/abc", INBOX_ID)
    assert again.existing and again.material_id == first.material_id and len(seen) == 1


async def test_a_link_landing_on_a_known_page_or_the_same_bytes_is_not_added_again(
        ready: KnowledgeService, tmp_path: Path) -> None:
    pdf = _pdf(tmp_path, "paper.pdf")
    data = pdf.read_bytes()

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/short":
            return httpx.Response(302, headers={"location": "https://blog.example/boiling"})
        if request.url.path == "/paper.pdf":
            return httpx.Response(200, headers={"content-type": "application/pdf"}, content=data)
        return httpx.Response(200, headers={"content-type": "text/html; charset=utf-8"}, text=ARTICLE)

    sources = service_with(ready, handler)
    page = await sources.add_link("https://blog.example/boiling", INBOX_ID)
    redirected = await sources.add_link("https://sho.rt/short", INBOX_ID)
    assert redirected.existing and redirected.material_id == page.material_id
    file = sources.add_file(pdf, INBOX_ID)
    linked = await sources.add_link("https://files.example/paper.pdf", INBOX_ID)
    assert linked.existing and linked.material_id == file.material_id
    assert len(ready.materials()) == 2


def test_only_documents_from_before_the_hash_have_their_kept_original_read(
        sources: SourceService, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # Q1 n2 L1: a recording or an import keeps no original document in ``.skaz``; its folder is not
    # searched on every add (a large, cloud-synced library of recordings stays untouched).
    kb = sources.kb
    kb.create_material(INBOX_ID, "Old talk", "audio", [FragmentInput(text=CLEAN_EN[1])],
                       origin=Origin(type="file", file_name="talk.m4a"))
    old = kb.create_material(INBOX_ID, "Old lecture", "pdf", [FragmentInput(text=CLEAN_EN[0])],
                             origin=Origin(type="file", file_name="old.pdf"))
    looked: list[str] = []
    monkeypatch.setattr(duplicates, "_original_matches",
                        lambda _kb, record, _digest, _size: looked.append(record.title) or False)
    assert find_duplicate(kb, content=b"%PDF-1.4 something else") is None
    assert looked == ["Old lecture"] and old.manifest.id


def _slow_check(monkeypatch: pytest.MonkeyPatch) -> None:
    """Widen the window between "is it there?" and storing it, as a slow disk would."""
    def slow(*args: Any, **kwargs: Any) -> Any:
        found = find_duplicate(*args, **kwargs)
        time.sleep(0.2)
        return found
    monkeypatch.setattr(source_service, "find_duplicate", slow)


async def test_two_adds_of_the_same_file_at_once_make_one_material(
        sources: SourceService, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # Q1 n2 L3: both adds checked before either stored the material — both used to pass.
    _slow_check(monkeypatch)
    pdf = _pdf(tmp_path, "lecture.pdf")
    results = await asyncio.gather(*(asyncio.to_thread(sources.add_file, pdf, INBOX_ID) for _ in range(2)))
    assert sorted(result.existing for result in results) == [False, True]
    assert len(sources.kb.materials()) == 1


async def test_two_adds_of_the_same_link_at_once_make_one_material(
        ready: KnowledgeService, monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return httpx.Response(200, headers={"content-type": "text/html; charset=utf-8"}, text=ARTICLE)

    sources = service_with(ready, handler)
    _slow_check(monkeypatch)
    url = "https://blog.example/boiling"
    results = await asyncio.gather(*(sources.add_link(url, INBOX_ID) for _ in range(2)))
    assert sorted(result.existing for result in results) == [False, True]
    assert len(ready.materials()) == 1 and len(seen) == 1


def test_pasted_text_is_never_a_duplicate(sources: SourceService) -> None:
    sources.add_text(CLEAN_EN[0], INBOX_ID)
    assert not sources.add_text(CLEAN_EN[0], INBOX_ID).existing
    assert find_duplicate(sources.kb, content=CLEAN_EN[0].encode("utf-8")) is None


async def test_the_api_answers_200_with_the_material_already_there(
        kb_client: httpx.AsyncClient, tmp_path: Path) -> None:
    await kb_client.post("/kb/library", json={})
    pdf = _pdf(tmp_path, "lecture.pdf")
    body = {"path": str(pdf), "folder_id": INBOX_ID}
    created = await kb_client.post("/kb/materials/file", json=body)
    assert created.status_code == 201 and created.json()["already_in_library"] is False
    again = await kb_client.post("/kb/materials/file", json=body)
    assert again.status_code == 200, again.text
    assert again.json()["already_in_library"] is True
    assert again.json()["material"]["id"] == created.json()["material"]["id"]
    listed = (await kb_client.get("/kb/materials")).json()
    assert len(listed) == 1


@pytest.fixture
def sources(ready: KnowledgeService) -> SourceService:
    return service_with(ready, lambda request: httpx.Response(404))
