"""FX-2/FX-5: user-click imports and version deduplication; no real network or models."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from io import BytesIO
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

from skaz.knowledge.api.schemas_explore import KbFinding, KbFunnelStart
from skaz.knowledge.api.schemas_science import (
    KbScienceLocation,
    KbSciencePayload,
    KbScienceSearch,
    KbScienceSettingsUpdate,
    KbScienceText,
    KbScienceWork,
)
from skaz.knowledge.explore.reading import is_real_abstract
from skaz.knowledge.library.library import EXPLORE_FOLDER_ID
from skaz.knowledge.science import openalex
from skaz.knowledge.science.client import ScienceGateway
from skaz.knowledge.science.protocols import ScienceConsentRequired
from skaz.knowledge.science.transport import Call
from skaz.knowledge.sources.fetch import Fetched, SafeFetcher
from skaz.knowledge.sources.fragments import sanitize_title
from skaz.knowledge.sources.service import SourceService
from skaz.secrets import MemorySecretStore
from tests.knowledge.test_b2_funnel import REAL_ABSTRACT, run_to_end, work
from tests.knowledge.test_b2_funnel import parts as parts

TITLE = "Mixture of Experts Scaling Laws: What MoE Architectures Mean for 2025-2026 Model Development"
RECORD = "https://zenodo.org/records/21850092"
ARTICLE = "We measure expert routing accuracy and report reproducible scaling experiments. " * 50


async def finding(parts: SimpleNamespace, paper: KbScienceWork | None = None) -> KbFinding:
    parts.science.search_works = [paper or work(1, title=TITLE, abstract=REAL_ABSTRACT, topics=["T1"])]
    run = await run_to_end(parts, KbFunnelStart(query="agents", channels=["search"]))
    found = await parts.funnel.findings(run_id=run.id)
    return found.groups[0].findings[0]  # type: ignore[no-any-return]


def pdf_bytes() -> bytes:
    writer = PdfWriter()
    writer.pdf_header = b"%PDF-1.4"
    page = writer.add_blank_page(width=600, height=800)
    font = DictionaryObject({
        NameObject("/Type"): NameObject("/Font"),
        NameObject("/Subtype"): NameObject("/Type1"),
        NameObject("/BaseFont"): NameObject("/Helvetica"),
    })
    page[NameObject("/Resources")] = DictionaryObject({
        NameObject("/Font"): DictionaryObject({NameObject("/F1"): font}),
    })
    stream = DecodedStreamObject()
    stream.set_data(b"BT /F1 12 Tf 50 700 Td (Measured expert routing accuracy on scientific tasks.) Tj ET")
    page[NameObject("/Contents")] = stream
    output = BytesIO()
    writer.write(output)
    return output.getvalue()


@pytest.fixture
async def network(parts: SimpleNamespace) -> AsyncIterator[SimpleNamespace]:
    routes: dict[str, tuple[bytes, str, int]] = {}
    requests: list[httpx.Request] = []

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        body, content_type, status = routes.get(request.url.path, (b"missing", "text/plain", 404))
        return httpx.Response(status, content=body, headers={"content-type": content_type})

    async def fake_ip(_host: str) -> list[str]:
        return ["198.18.0.8"]

    transport = httpx.MockTransport(respond)
    fetcher = SafeFetcher(transport=transport, resolver=fake_ip)
    async with httpx.AsyncClient(transport=transport) as http:
        gateway = ScienceGateway(parts.kb, MemorySecretStore(), http, fetcher)
        await gateway.update_settings(KbScienceSettingsUpdate(enabled=True, consent="topics_dois_ids"))
        yield SimpleNamespace(gateway=gateway, routes=routes, requests=requests, fetcher=fetcher)


def use_gateway(parts: SimpleNamespace, network: SimpleNamespace, found: KbFinding) -> None:
    network.gateway.store.save_works([found.work], network.gateway.now())
    parts.funnel.science = network.gateway


@pytest.mark.parametrize("prefix", ["Research article: ", "Preprint: ", "Article: "])
def test_placeholder_abstract_is_not_real(prefix: str) -> None:
    assert not is_real_abstract(prefix + TITLE, TITLE)


def test_bibliography_is_not_an_abstract() -> None:
    assert not is_real_abstract(
        "Oleh Ivchenko; Iryna Ivchenko. Proceedings of the International Conference on Machine Learning.",
        TITLE,
    )
    assert is_real_abstract("Proceedings of the conference. " + REAL_ABSTRACT, TITLE)
    assert not is_real_abstract("Too short.", TITLE)


@pytest.mark.parametrize("mime", ["application/pdf", "application/octet-stream"])
async def test_pdf_is_saved_with_original_and_page_text(
    parts: SimpleNamespace, network: SimpleNamespace, mime: str,
) -> None:
    url = RECORD + "/files/paper.pdf"
    found = await finding(parts, work(1, title=TITLE, abstract=REAL_ABSTRACT, locations=[
        KbScienceLocation(url=url, kind="open_page", open_access=True),
    ]))
    raw = pdf_bytes()
    network.routes["/records/21850092/files/paper.pdf"] = (raw, mime, 200)
    use_gateway(parts, network, found)
    sources = SourceService(parts.kb)
    events: list[Any] = []
    sources.subscribe(events.append)
    parts.funnel.reading.sources = sources
    added = await parts.funnel.add_to_materials(found.id)
    assert (added.content, added.to_wiki, added.importing) == ("pdf", False, False)
    material = parts.kb.material(added.material_id)
    assert (material.folder_id, material.kind, material.title) == (
        EXPLORE_FOLDER_ID, "pdf", sanitize_title(TITLE),
    )
    assert material.fragments[0].page == 1
    assert "Measured expert routing" in material.fragments[0].text
    assert material.origin is not None and material.origin["content"] == "pdf"
    originals = list(parts.kb.require().root.rglob("original.pdf"))
    assert len(originals) == 1 and originals[0].read_bytes() == raw
    assert events[0].to_wiki is False
    assert network.requests[0].url.host == "198.18.0.8"  # checked fake-IP, pinned by SafeFetcher
    assert network.requests[0].headers["host"] == "zenodo.org"
    journal = await network.gateway.journal()
    assert [(r.operation, r.outcome) for r in journal.records] == [("full_text", "succeeded")]
    current = await parts.funnel.finding(found.id)
    assert (current.state, current.importing, current.imported_content) == ("materials", False, "pdf")
    assert (await parts.funnel.add_to_materials(found.id)).content == "pdf"
    assert len(network.requests) == 1


@pytest.mark.parametrize("extension,mime", [
    ("md", "text/markdown"), ("txt", "text/plain"), ("html", "text/html"),
])
async def test_zenodo_attachment_is_imported_as_full_text(
    parts: SimpleNamespace, network: SimpleNamespace, extension: str, mime: str,
) -> None:
    found = await finding(parts, work(1, title=TITLE, abstract=REAL_ABSTRACT, locations=[
        KbScienceLocation(url=RECORD, kind="open_page", open_access=True),
    ]))
    path = f"/records/21850092/files/paper.{extension}"
    network.routes["/records/21850092"] = (
        f'<html><head><link rel="alternate" href="{path}?download=1"></head>'
        f"<body><p>Research article: {TITLE}</p></body></html>".encode(), "text/html", 200,
    )
    article = (
        f"<html><body><article><p>{ARTICLE}</p></article></body></html>" if extension == "html" else ARTICLE
    )
    network.routes[path] = (article.encode(), mime, 200)
    use_gateway(parts, network, found)
    added = await parts.funnel.add_to_materials(found.id)
    assert (added.content, added.to_wiki) == ("full_text", False)
    prepared, folder, to_wiki = parts.sources.prepared[0]
    assert (folder, to_wiki, prepared.title) == (EXPLORE_FOLDER_ID, False, sanitize_title(TITLE))
    assert "reproducible scaling experiments" in " ".join(f.text for f in prepared.fragments)
    assert any(r.url.path == path for r in network.requests)
    assert all(r.outcome != "sent" for r in (await network.gateway.journal()).records)


async def test_page_pdf_is_preferred_to_markdown(parts: SimpleNamespace, network: SimpleNamespace) -> None:
    found = await finding(parts, work(1, title=TITLE, abstract=REAL_ABSTRACT, locations=[
        KbScienceLocation(url=RECORD, kind="open_page", open_access=True),
    ]))
    network.routes["/records/21850092"] = (
        b'<html><body><a href="/records/21850092/files/paper.md">Text</a>'
        b'<a href="/records/21850092/files/paper.pdf">PDF</a></body></html>', "text/html", 200,
    )
    network.routes["/records/21850092/files/paper.pdf"] = (pdf_bytes(), "application/pdf", 200)
    use_gateway(parts, network, found)
    added = await parts.funnel.add_to_materials(found.id)
    assert added.content == "pdf"
    assert not any(r.url.path.endswith(".md") for r in network.requests)


@pytest.mark.parametrize("abstract,content,suffix", [
    (None, "link_only", " (link only)"),
    ("Research article: " + TITLE, "link_only", " (link only)"),
    (REAL_ABSTRACT, "abstract_only", " (abstract only)"),
])
async def test_import_always_preserves_link_with_honest_content_label(
    parts: SimpleNamespace, network: SimpleNamespace, abstract: str | None, content: str, suffix: str,
) -> None:
    found = await finding(parts)
    changed = found.work.model_copy(update={
        "abstract": abstract, "doi": "10.5281/zenodo.21850092", "authors": ["Oleh Ivchenko"],
        "venue": "Zenodo", "locations": [],
    })
    parts.funnel.store.update_details(found.id, {"work": changed.model_dump(mode="json")})
    found = await parts.funnel.finding(found.id)
    use_gateway(parts, network, found)
    added = await parts.funnel.add_to_materials(found.id)
    assert added.content == content
    prepared, folder, to_wiki = parts.sources.prepared[0]
    body = "\n".join(f.text for f in prepared.fragments)
    assert (prepared.title, folder, to_wiki) == (sanitize_title(TITLE + suffix), EXPLORE_FOLDER_ID, False)
    assert "https://doi.org/10.5281/zenodo.21850092" in body
    if content == "link_only":
        assert "Oleh Ivchenko" in body and "2026" in body and "Zenodo" in body
    current = await parts.funnel.finding(found.id)
    assert (current.importing, current.imported_content, current.state) == (False, content, "materials")


async def test_importing_state_and_concurrent_click_share_one_import(parts: SimpleNamespace) -> None:
    found = await finding(parts)
    entered, release = asyncio.Event(), asyncio.Event()
    calls = 0

    async def slow_read(work_id: str, *, run_id: str | None = None) -> KbScienceText:
        nonlocal calls
        calls += 1
        entered.set()
        await release.wait()
        return KbScienceText(
            work_id=work_id, kind="open_page", text=ARTICLE, source_url=RECORD, access=found.work.access,
        )

    parts.science.read_text = slow_read
    first = asyncio.create_task(parts.funnel.add_to_materials(found.id))
    try:
        await asyncio.wait_for(entered.wait(), 3)
        current = await parts.funnel.finding(found.id)
        assert (current.importing, current.state) == (True, "importing")
        listed = await parts.funnel.findings(run_id=found.run_id)
        assert listed.groups[0].findings[0].state == "importing"
        second = asyncio.create_task(parts.funnel.add_to_materials(found.id))
        await asyncio.sleep(0)
    finally:
        release.set()
        await first
    one, two = await asyncio.gather(first, second)
    assert one == two and calls == 1 and len(parts.sources.prepared) == 1
    current = await parts.funnel.finding(found.id)
    assert (current.state, current.importing, current.imported_content) == ("materials", False, "full_text")


async def test_failure_clears_importing_and_allows_retry(parts: SimpleNamespace) -> None:
    found = await finding(parts)
    parts.science.error = ScienceConsentRequired()
    with pytest.raises(Exception, match="consent_required"):
        await parts.funnel.add_to_materials(found.id)
    assert not (await parts.funnel.finding(found.id)).importing
    parts.science.error = None
    parts.science.texts[found.work.id] = KbScienceText(
        work_id=found.work.id, kind="abstract_only", text=REAL_ABSTRACT,
        source_url=None, access=found.work.access,
    )
    assert (await parts.funnel.add_to_materials(found.id)).content == "abstract_only"


def zenodo_versions() -> list[KbScienceWork]:
    return [
        work(n, title=TITLE, doi=f"10.5281/zenodo.{record}", abstract=REAL_ABSTRACT, locations=[
            KbScienceLocation(url=f"https://zenodo.org/records/{record}", kind="open_page", open_access=True),
        ]).model_copy(update={"authors": ["Oleh Ivchenko", "Iryna Ivchenko"]})
        for n, record in [(1, 21847852), (2, 21850092)]
    ]


def test_zenodo_versions_merge_and_keep_alternative_locations() -> None:
    older, newer = zenodo_versions()
    merged = openalex.deduplicate_works([older, newer, older])
    assert len(merged) == 1 and merged[0].doi == newer.doi
    assert {loc.url for loc in merged[0].locations} == {
        loc.url for w in [older, newer] for loc in w.locations
    }
    assert len(merged[0].locations) == 2
    assert older.locations != merged[0].locations  # inputs stay untouched


def test_dedup_keeps_short_titles_and_different_authors() -> None:
    a = work(1, title="A sufficiently long title about expert routing", doi="10.1234/one")
    b = a.model_copy(update={"id": "work-2", "doi": "10.1234/two", "authors": ["Someone Else"]})
    assert len(openalex.deduplicate_works([a, b])) == 2
    assert len(openalex.deduplicate_works([work(1, title="Short"), work(2, title="Short")])) == 2


@pytest.mark.parametrize("operation", ["search", "citing", "neighbours"])
async def test_gateway_deduplicates_result_lists(
    network: SimpleNamespace, monkeypatch: pytest.MonkeyPatch, operation: str,
) -> None:
    data = {"results": [
        {
            "id": f"https://openalex.org/W{n}", "title": TITLE, "doi": f"10.5281/zenodo.{record}",
            "publication_year": 2026, "authorships": [{"author": {"display_name": "Oleh Ivchenko"}}],
        }
        for n, record in [(7201976340, 21847852), (7201976300, 21850092)]
    ]}

    async def answer(call: Call, run_id: str | None) -> dict[str, Any]:
        return data

    monkeypatch.setattr(network.gateway, "_json", answer)
    if operation == "search":
        result = await network.gateway.search(KbScienceSearch(payload=KbSciencePayload(topics=["experts"])))
    elif operation == "citing":
        result = await network.gateway.citing(["W123"])
    else:
        result = await network.gateway.neighbours(["W123"], [])
    assert len(result.works) == 1 and result.works[0].doi == "10.5281/zenodo.21850092"


async def test_read_and_open_page_allow_vpn_fake_ip(parts: SimpleNamespace, network: SimpleNamespace) -> None:
    found = await finding(parts, work(1, abstract=REAL_ABSTRACT, locations=[
        KbScienceLocation(url=RECORD, kind="open_page", open_access=True),
    ]))
    network.routes["/records/21850092"] = (
        f"<html><body><article><p>{ARTICLE}</p></article></body></html>".encode(), "text/html", 200,
    )
    use_gateway(parts, network, found)
    assert await network.gateway.open_text_url(found.work.id) == RECORD
    assert (await network.gateway.read_text(found.work.id)).kind == "open_page"


def test_openalex_preserves_open_pdf_locations() -> None:
    locations = openalex.locations_of({"locations": [{
        "is_oa": True, "pdf_url": RECORD + "/files/paper.pdf", "landing_page_url": RECORD,
    }]}, "W1", None)
    assert RECORD + "/files/paper.pdf" in [loc.url for loc in locations]


async def test_alternate_pdf_without_extension(parts: SimpleNamespace, network: SimpleNamespace) -> None:
    found = await finding(parts, work(1, abstract=REAL_ABSTRACT, locations=[
        KbScienceLocation(url=RECORD, kind="open_page", open_access=True),
    ]))
    network.routes["/records/21850092"] = (
        b'<html><head><link rel="alternate" type="application/pdf" href="/download"></head></html>',
        "text/html", 200,
    )
    network.routes["/download"] = (pdf_bytes(), "application/pdf", 200)
    use_gateway(parts, network, found)
    assert (await parts.funnel.add_to_materials(found.id)).content == "pdf"


async def test_failed_tei_continues_to_open_page(parts: SimpleNamespace, network: SimpleNamespace) -> None:
    found = await finding(parts, work(1, abstract=REAL_ABSTRACT, locations=[
        KbScienceLocation(
            url="https://content.openalex.org/works/W1.grobid-xml", kind="tei", open_access=True,
        ),
        KbScienceLocation(url=RECORD, kind="open_page", open_access=True),
    ]))
    network.gateway.secrets.set("openalex", "fixture-key")
    network.routes["/works/W1.grobid-xml"] = (b"unavailable", "text/plain", 503)
    network.routes["/records/21850092"] = (
        f"<html><body><article><p>{ARTICLE}</p></article></body></html>".encode(), "text/html", 200,
    )
    use_gateway(parts, network, found)
    assert (await network.gateway.read_text(found.work.id)).kind == "open_page"


async def test_bad_pdf_continues_to_real_abstract(parts: SimpleNamespace, network: SimpleNamespace) -> None:
    found = await finding(parts, work(1, abstract=REAL_ABSTRACT, locations=[
        KbScienceLocation(url=RECORD + "/files/bad.pdf", kind="open_page", open_access=True),
    ]))
    network.routes["/records/21850092/files/bad.pdf"] = (b"%PDF-1.4 broken", "application/pdf", 200)
    use_gateway(parts, network, found)
    assert (await parts.funnel.add_to_materials(found.id)).content == "abstract_only"


@pytest.mark.parametrize("url", ["http://127.0.0.1/paper.pdf", "http://198.18.0.8/paper.pdf"])
async def test_download_still_rejects_private_and_fake_ip_literals(
    network: SimpleNamespace, url: str,
) -> None:
    call = Call("openalex", "full_text", url, KbSciencePayload())
    assert await network.gateway.transport.download(call) is None
    assert network.requests == []
    assert (await network.gateway.journal()).records[0].outcome == "failed"


async def test_download_limits_and_explicit_fake_ip_opt_out(network: SimpleNamespace) -> None:
    network.routes["/large"] = (b"x" * 20, "text/plain", 200)
    call = Call("openalex", "full_text", "https://zenodo.org/large", KbSciencePayload())
    assert await network.gateway.transport.download(call, max_bytes=10) is None
    assert await network.gateway.transport.download(call, allow_vpn_fake_ip=False) is None
    assert len(network.requests) == 1
    assert all(r.outcome == "failed" for r in (await network.gateway.journal()).records)


async def test_cancelled_import_clears_importing(parts: SimpleNamespace) -> None:
    found = await finding(parts)
    entered = asyncio.Event()

    async def never_read(work_id: str, *, run_id: str | None = None) -> KbScienceText:
        entered.set()
        await asyncio.Future[None]()
        raise AssertionError("unreachable")

    parts.science.read_text = never_read
    task = asyncio.create_task(parts.funnel.add_to_materials(found.id))
    await asyncio.wait_for(entered.wait(), 3)
    assert (await parts.funnel.finding(found.id)).importing
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert not (await parts.funnel.finding(found.id)).importing


async def test_arxiv_pdf_has_correct_provider(parts: SimpleNamespace, network: SimpleNamespace) -> None:
    paper = work(1, abstract=REAL_ABSTRACT).model_copy(update={"arxiv_id": "2401.01234"})
    found = await finding(parts, paper)
    network.routes["/pdf/2401.01234.pdf"] = (pdf_bytes(), "application/pdf", 200)
    use_gateway(parts, network, found)
    assert (await parts.funnel.add_to_materials(found.id)).content == "pdf"
    record = (await network.gateway.journal()).records[0]
    assert (record.provider, record.destination_host) == ("arxiv", "arxiv.org")


async def test_pdf_only_location_has_reader_url_without_downloading_pdf(
    parts: SimpleNamespace, network: SimpleNamespace,
) -> None:
    url = RECORD + "/files/paper.pdf"
    found = await finding(parts, work(1, abstract=REAL_ABSTRACT, locations=[
        KbScienceLocation(url=url, kind="open_page", open_access=True),
    ]))
    use_gateway(parts, network, found)
    assert await network.gateway.open_text_url(found.work.id) == url
    assert network.requests == []


async def test_cancelled_download_closes_egress_record(
    network: SimpleNamespace, monkeypatch: pytest.MonkeyPatch,
) -> None:
    entered = asyncio.Event()

    async def never_fetch(url: str, **kwargs: Any) -> Fetched:
        entered.set()
        await asyncio.Future[None]()
        raise AssertionError("unreachable")

    monkeypatch.setattr(network.fetcher, "fetch", never_fetch)
    call = Call("openalex", "full_text", RECORD, KbSciencePayload())
    task = asyncio.create_task(network.gateway.transport.download(call))
    await asyncio.wait_for(entered.wait(), 3)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert (await network.gateway.journal()).records[0].outcome == "failed"
