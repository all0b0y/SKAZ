"""Slice B1: the science client (OpenAlex / arXiv / Crossref), consent, journal, limits, text, Paid.

No real network: every answer is a hand-written fixture in ``fixtures/science`` that follows the
provider's documented shape (each fixture cites its doc page).
"""

from __future__ import annotations

import json
from collections.abc import Callable
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
import pytest

from skaz.knowledge.api.schemas_science import (
    KbOpenAlexKeyUpdate,
    KbSciencePayload,
    KbScienceSearch,
    KbScienceSettingsUpdate,
)
from skaz.knowledge.errors import KnowledgeError, NotFound
from skaz.knowledge.science.client import KEY_NAME, ScienceGateway, paid_copy
from skaz.knowledge.science.ids import (
    arxiv_of_work_id,
    arxiv_work_id,
    normalize_doi,
    parent_query,
    split_arxiv,
    taxonomy_id,
)
from skaz.knowledge.science.protocols import (
    ScienceConsentRequired,
    ScienceDailyLimit,
    ScienceRef,
    ScienceUnavailable,
)
from skaz.knowledge.service import KnowledgeService
from skaz.knowledge.sources.fetch import SafeFetcher
from skaz.secrets import MemorySecretStore

FIXTURES = Path(__file__).parent / "fixtures" / "science"
NOW = datetime(2026, 11, 10, 12, 0, tzinfo=UTC)
SECRET = "oa-SECRET-key-123"


def fixture(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


def fixture_json(name: str) -> dict[str, Any]:
    data = json.loads(fixture(name))
    data.pop("_source", None)
    return data  # type: ignore[no-any-return]


def article_html(sentence: str) -> bytes:
    paragraphs = "".join(
        f"<p>{sentence} Paragraph {n} adds more detail to the argument.</p>" for n in range(30)
    )
    page = f"<html><head><title>Article</title></head><body><article>{paragraphs}</article></body></html>"
    return page.encode()


Route = Callable[[httpx.Request], httpx.Response]


class Bases:
    """Fake science bases: ``routes[(host, path)]`` answers; every request is recorded."""

    def __init__(self, kb: KnowledgeService) -> None:
        self.kb = kb
        self.routes: dict[tuple[str, str], Route | list[Route]] = {}
        self.requests: list[httpx.Request] = []
        self.journal_at_send: list[list[str]] = []

    def on(self, host: str, path: str, answer: Route | list[Route]) -> None:
        self.routes[(host, path)] = answer

    def handle(self, request: httpx.Request) -> httpx.Response:
        host = request.headers.get("host", request.url.host).split(":")[0]
        self.requests.append(request)
        with self.kb.db.read() as conn:
            self.journal_at_send.append(
                [row["outcome"] for row in conn.execute("SELECT outcome FROM science_egress ORDER BY rowid")]
            )
        answer = self.routes.get((host, request.url.path))
        if isinstance(answer, list):
            answer = answer.pop(0) if answer else None
        if answer is None:
            return httpx.Response(404, json={"error": "not found"})
        return answer(request)

    def hosts(self) -> list[str]:
        return [r.headers.get("host", r.url.host).split(":")[0] for r in self.requests]


def ok_json(data: Any, **headers: str) -> Route:
    return lambda _request: httpx.Response(200, json=data, headers=headers)


def ok_bytes(body: bytes, content_type: str) -> Route:
    return lambda _request: httpx.Response(200, content=body, headers={"content-type": content_type})


def status(code: int, **headers: str) -> Route:
    return lambda _request: httpx.Response(code, json={"error": "x"}, headers=headers)


async def public_resolver(_host: str) -> list[str]:
    return ["93.184.216.34"]


@pytest.fixture
def bases(ready: KnowledgeService) -> Bases:
    return Bases(ready)


@pytest.fixture
def secrets() -> MemorySecretStore:
    return MemorySecretStore()


@pytest.fixture
def sleeps() -> list[float]:
    return []


@pytest.fixture
def gateway(
    ready: KnowledgeService, bases: Bases, secrets: MemorySecretStore, sleeps: list[float]
) -> ScienceGateway:
    transport = httpx.MockTransport(bases.handle)
    fetcher = SafeFetcher(transport=transport, resolver=public_resolver)
    science = ScienceGateway(ready, secrets, httpx.AsyncClient(transport=transport), fetcher, now=lambda: NOW)

    async def fake_sleep(seconds: float) -> None:
        sleeps.append(seconds)

    science.transport.sleep = fake_sleep
    clock = iter(range(0, 10_000, 10))
    science.transport.monotonic = lambda: float(next(clock))
    return science


async def enable(science: ScienceGateway) -> None:
    await science.update_settings(KbScienceSettingsUpdate(enabled=True, consent="topics_dois_ids"))


def search(*topics: str, **payload: Any) -> KbScienceSearch:
    return KbScienceSearch(payload=KbSciencePayload(topics=list(topics), **payload))


# -- ids ----------------------------------------------------------------------------------------------


def test_ids_round_trip_and_normalise() -> None:
    assert normalize_doi("https://doi.org/10.1234/Agents.2024.001") == "10.1234/agents.2024.001"
    assert normalize_doi("doi:10.1234/x") == "10.1234/x"
    assert normalize_doi("not a doi") is None
    assert split_arxiv("http://arxiv.org/abs/2401.01234v3") == ("2401.01234", "v3")
    assert split_arxiv("10.48550/arXiv.2401.01234") == ("2401.01234", None)
    assert split_arxiv("hep-th/9901001v2") == ("hep-th/9901001", "v2")
    assert split_arxiv("arxiv:2401.01234") == ("2401.01234", None)
    assert arxiv_of_work_id(arxiv_work_id("hep-th/9901001")) == "hep-th/9901001"
    assert arxiv_of_work_id(arxiv_work_id("2401.01234")) == "2401.01234"
    assert taxonomy_id("https://openalex.org/domains/3") == "domains-3"
    assert taxonomy_id("https://openalex.org/T10181") == "T10181"
    assert parent_query("subfields-1702") == ("topics", "subfield.id:1702", "topic")
    assert parent_query("T10181") is None


# -- consent gate and settings ---------------------------------------------------------------------


async def test_integration_off_sends_nothing(gateway: ScienceGateway, bases: Bases) -> None:
    with pytest.raises(ScienceConsentRequired):
        await gateway.search(search("agents"))
    with pytest.raises(ScienceConsentRequired):
        await gateway.taxonomy(None)
    assert bases.requests == []
    assert (await gateway.journal()).records == []


async def test_consent_withdrawn_while_paced_sends_nothing(gateway: ScienceGateway, bases: Bases) -> None:
    """Review R1-02: a request waiting in the arXiv pacing window re-checks consent before it leaves."""
    await enable(gateway)
    bases.on("export.arxiv.org", "/api/query", ok_bytes(fixture("arxiv_feed.xml"), "application/atom+xml"))
    arxiv_search = KbScienceSearch(provider="arxiv", payload=KbSciencePayload(topics=["rag"]))
    await gateway.search(arxiv_search)

    async def withdraw_while_waiting(_seconds: float) -> None:
        gateway.store.set_enabled(False, NOW)  # Settings → science off, during the 3 s wait

    gateway.transport.sleep = withdraw_while_waiting
    gateway.transport.monotonic = lambda: 0.0  # the second request comes at once, so it must wait
    with pytest.raises(ScienceConsentRequired):
        await gateway.search(arxiv_search)
    assert len(bases.requests) == 1  # the paced second request never left
    assert len((await gateway.journal()).records) == 1  # and was never journalled as sent


async def test_enabling_records_consent_and_disabling_withdraws_it(gateway: ScienceGateway) -> None:
    settings = await gateway.settings()
    assert (settings.enabled, settings.consent_at, settings.openalex_key_configured) == (False, None, False)
    await enable(gateway)
    settings = await gateway.settings()
    assert settings.enabled and settings.consent_at == NOW
    settings = await gateway.update_settings(KbScienceSettingsUpdate(enabled=False))
    assert (settings.enabled, settings.consent_at) == (False, None)
    assert (await gateway.dismiss_hint()).full_text_hint_dismissed is True


async def test_key_lives_in_the_secret_store_and_never_comes_back(
    gateway: ScienceGateway, secrets: MemorySecretStore
) -> None:
    settings = await gateway.set_key(KbOpenAlexKeyUpdate(key=SECRET))  # type: ignore[arg-type]
    assert settings.openalex_key_configured is True
    assert secrets.get(KEY_NAME) == SECRET
    assert SECRET not in settings.model_dump_json()
    settings = await gateway.set_key(KbOpenAlexKeyUpdate(key=""))  # type: ignore[arg-type]
    assert settings.openalex_key_configured is False
    assert secrets.get(KEY_NAME) is None


# -- search, journal ------------------------------------------------------------------------------


async def test_search_is_journalled_before_it_leaves_and_carries_topics_only(
    gateway: ScienceGateway, bases: Bases
) -> None:
    await enable(gateway)
    bases.on("api.openalex.org", "/works", ok_json(fixture_json("openalex_list.json")))
    results = await gateway.search(search("agents verifying claims"), run_id="run-1")

    assert bases.journal_at_send == [["sent"]]  # the row existed, as "sent", while the request left
    request = bases.requests[0]
    assert request.url.params["search"] == "agents verifying claims"
    assert "authorization" not in request.headers and "api_key" not in str(request.url)
    assert [w.id for w in results.works] == ["W5000000001", "W4391234567"]
    assert results.next_cursor == "IlsxNjYwMDAwMDAwXSI="
    assert results.works[0].topic_ids == ["T10181"]
    journal = (await gateway.journal()).records
    assert len(journal) == 1
    record = journal[0]
    assert (record.provider, record.operation, record.destination_host) == (
        "openalex",
        "search",
        "api.openalex.org",
    )
    assert (record.outcome, record.status_code, record.run_id) == ("succeeded", 200, "run-1")
    assert record.payload.model_dump() == {"topics": ["agents verifying claims"], "dois": [], "ids": []}


async def test_journal_pages_newest_first(gateway: ScienceGateway, bases: Bases) -> None:
    await enable(gateway)
    bases.on("api.openalex.org", "/works", ok_json(fixture_json("openalex_list.json")))
    for topic in ("one", "two", "three"):
        await gateway.search(search(topic))
    first = await gateway.journal(limit=2)
    assert [r.payload.topics for r in first.records] == [["three"], ["two"]]
    assert first.next_cursor is not None
    rest = await gateway.journal(cursor=first.next_cursor, limit=2)
    assert [r.payload.topics for r in rest.records] == [["one"]] and rest.next_cursor is None
    with pytest.raises(KnowledgeError):
        await gateway.journal(cursor="garbage")


async def test_known_ids_are_served_without_a_request(gateway: ScienceGateway, bases: Bases) -> None:
    await enable(gateway)
    bases.on("api.openalex.org", "/works", ok_json(fixture_json("openalex_list.json")))
    await gateway.search(search("agents"))
    results = await gateway.search(KbScienceSearch(payload=KbSciencePayload(ids=["W5000000001"])))
    assert [w.id for w in results.works] == ["W5000000001"]
    assert len(bases.requests) == 1


async def test_parsed_work_is_honest_about_access_and_text(gateway: ScienceGateway, bases: Bases) -> None:
    await enable(gateway)
    bases.on("api.openalex.org", "/works/W4391234567", ok_json(fixture_json("openalex_work_paid.json")))
    bases.on("api.openalex.org", "/works/W4400000001", ok_json(fixture_json("openalex_work_open.json")))
    paid = await gateway.work("W4391234567")
    assert paid.doi == "10.1234/agents.2024.001"
    assert paid.abstract == "Agents check claims against sources; unsupported claims are flagged."
    assert paid.publication.precision == "day" and paid.publication.date == date(2024, 3, 5)
    assert (
        paid.access.paid is True
        and paid.access.publisher_url == "https://publisher.example.org/article/agents"
    )
    assert [(loc.kind, loc.open_access) for loc in paid.locations] == [("tei", True), ("publisher", False)]
    assert paid.referenced_ids == ["W100", "W200"] and paid.authors == ["Ada Lovelace", "Alan Turing"]

    free = await gateway.work("W4400000001")
    assert free.arxiv_id == "2401.01234" and free.access.paid is False
    assert free.publication.precision == "year"
    kinds = [(loc.kind, loc.url) for loc in free.locations]
    assert kinds == [
        ("arxiv_html", "https://arxiv.org/html/2401.01234"),
        ("open_page", "https://repository.example.edu/handle/42"),
    ]  # PDF links are never listed
    with pytest.raises(NotFound):
        await gateway.work("W1")  # 404 at OpenAlex


# -- limits: honest stops, never a silent switch --------------------------------------------------


async def test_keyless_day_budget_stops_before_sending(gateway: ScienceGateway, bases: Bases) -> None:
    await enable(gateway)
    bases.on("api.openalex.org", "/works", ok_json(fixture_json("openalex_list.json")))
    assert gateway.store.reserve(0.0995, 0.10, NOW) is None
    with pytest.raises(ScienceDailyLimit) as stop:
        await gateway.search(search("agents"))  # a search costs $0.001
    assert stop.value.retry_at == datetime(2026, 11, 11, tzinfo=UTC)
    assert bases.requests == []
    # A filter-only list ($0.0001) still fits; a single work is free.
    await gateway.citing(["W4391234567"])
    assert len(bases.requests) == 1


async def test_a_key_raises_the_day_budget(
    gateway: ScienceGateway, bases: Bases, secrets: MemorySecretStore
) -> None:
    await enable(gateway)
    secrets.set(KEY_NAME, SECRET)
    bases.on("api.openalex.org", "/works", ok_json(fixture_json("openalex_list.json")))
    assert gateway.store.reserve(0.5, 1.0, NOW) is None
    await gateway.search(search("agents"))
    assert bases.requests[0].headers["authorization"] == f"Bearer {SECRET}"
    assert SECRET not in str(bases.requests[0].url)
    journal = (await gateway.journal()).records
    assert SECRET not in journal[0].model_dump_json()


async def test_openalex_429_is_the_daily_limit_with_retry_at(gateway: ScienceGateway, bases: Bases) -> None:
    await enable(gateway)
    bases.on(
        "api.openalex.org",
        "/works",
        status(429, **{"X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "3600"}),
    )
    with pytest.raises(ScienceDailyLimit) as stop:
        await gateway.search(search("agents"))
    assert stop.value.retry_at == NOW + timedelta(hours=1)
    assert [r.outcome for r in (await gateway.journal()).records] == ["rate_limited"]
    # Until then nothing more leaves for OpenAlex; arXiv and Crossref are not used instead.
    with pytest.raises(ScienceDailyLimit):
        await gateway.citing(["W1"])
    assert bases.hosts() == ["api.openalex.org"]


async def test_per_second_429_waits_once_then_asks_again(
    gateway: ScienceGateway, bases: Bases, sleeps: list[float]
) -> None:
    await enable(gateway)
    bases.on(
        "api.openalex.org",
        "/works",
        [
            status(429, **{"Retry-After": "1", "X-RateLimit-Remaining": "40"}),
            ok_json(fixture_json("openalex_list.json")),
        ],
    )
    results = await gateway.search(search("agents"))
    assert len(results.works) == 2 and sleeps == [1.0]
    assert [r.outcome for r in (await gateway.journal()).records] == ["succeeded", "rate_limited"]


async def test_provider_failure_is_honest_and_journalled(gateway: ScienceGateway, bases: Bases) -> None:
    await enable(gateway)
    bases.on("api.openalex.org", "/works", status(503))
    with pytest.raises(ScienceUnavailable):
        await gateway.search(search("agents"))
    assert bases.hosts() == ["api.openalex.org"]
    record = (await gateway.journal()).records[0]
    assert (record.outcome, record.status_code) == ("failed", 503)


# -- full text: TEI (key) → arXiv HTML → open page → abstract -----------------------------------------


async def test_tei_with_a_key(gateway: ScienceGateway, bases: Bases, secrets: MemorySecretStore) -> None:
    await enable(gateway)
    secrets.set(KEY_NAME, SECRET)
    bases.on("api.openalex.org", "/works/W4391234567", ok_json(fixture_json("openalex_work_paid.json")))
    bases.on(
        "content.openalex.org",
        "/works/W4391234567.grobid-xml",
        ok_bytes(fixture("grobid.tei.xml"), "application/xml"),
    )
    text = await gateway.read_text("W4391234567")
    assert text.kind == "tei"
    assert text.text.startswith("Introduction\n\nAgents that use tools")
    assert (
        "Reference title" not in text.text and "root:" not in text.text
    )  # back matter and entities stay out
    assert text.source_url == "https://content.openalex.org/works/W4391234567.grobid-xml"
    tei_request = bases.requests[-1]
    assert tei_request.headers["authorization"] == f"Bearer {SECRET}" and SECRET not in str(tei_request.url)
    assert gateway.store.spent_today(NOW) == pytest.approx(0.01)


async def test_without_a_key_tei_is_skipped_and_the_abstract_is_labelled(
    gateway: ScienceGateway, bases: Bases
) -> None:
    await enable(gateway)
    bases.on("api.openalex.org", "/works/W4391234567", ok_json(fixture_json("openalex_work_paid.json")))
    text = await gateway.read_text("W4391234567")
    assert (text.kind, text.source_url) == ("abstract_only", None)
    assert text.text == "Agents check claims against sources; unsupported claims are flagged."
    assert "content.openalex.org" not in bases.hosts()
    assert "publisher.example.org" not in bases.hosts()  # a paywalled page is never fetched


async def test_arxiv_html_then_open_page(gateway: ScienceGateway, bases: Bases) -> None:
    await enable(gateway)
    bases.on("api.openalex.org", "/works/W4400000001", ok_json(fixture_json("openalex_work_open.json")))
    bases.on(
        "arxiv.org",
        "/html/2401.01234",
        ok_bytes(article_html("Retrieval over long documents works."), "text/html"),
    )
    text = await gateway.read_text("W4400000001")
    assert text.kind == "arxiv_html" and text.source_url == "https://arxiv.org/html/2401.01234"
    assert "Retrieval over long documents works." in text.text

    bases.routes.pop(("arxiv.org", "/html/2401.01234"))  # no HTML version → 404
    bases.on(
        "repository.example.edu", "/handle/42", ok_bytes(article_html("The repository copy."), "text/html")
    )
    text = await gateway.read_text("W4400000001")
    assert text.kind == "open_page" and text.source_url == "https://repository.example.edu/handle/42"
    assert "/files/42.pdf" not in [r.url.path for r in bases.requests]
    pages = [r for r in (await gateway.journal()).records if r.operation == "full_text"]
    assert [(r.destination_host, r.outcome) for r in pages][:2] == [
        ("repository.example.edu", "succeeded"),
        ("arxiv.org", "failed"),
    ]
    assert pages[0].payload.dois == ["10.48550/arxiv.2401.01234"]


# -- Paid (3c″) ---------------------------------------------------------------------------------------


async def test_paid_work_with_a_preprint_gets_no_suggestion(gateway: ScienceGateway, bases: Bases) -> None:
    await enable(gateway)
    bases.on("api.openalex.org", "/works/W4391234567", ok_json(fixture_json("openalex_work_paid.json")))
    bases.on(
        "api.crossref.org", "/works/10.1234/agents.2024.001", ok_json(fixture_json("crossref_work.json"))
    )
    work = await gateway.work("W4391234567")
    access = await gateway.paid_access(work, useful_because="Contradicts your wiki on «Agents».")
    assert access.paid and access.alternatives_checked
    assert access.free_alternative_ids == ["arxiv:2401.09999"]
    assert access.recommendation is None and access.suggestion_shown_at is None
    operations = [r.operation for r in (await gateway.journal()).records]
    assert operations.count("alternatives") == 2


async def test_paid_suggestion_once_per_work_and_alternatives_checked_once(
    gateway: ScienceGateway, bases: Bases
) -> None:
    await enable(gateway)
    bases.on("api.openalex.org", "/works/W4391234567", ok_json(fixture_json("openalex_work_paid.json")))
    message = fixture_json("crossref_work.json")
    del message["message"]["relation"]
    bases.on("api.crossref.org", "/works/10.1234/agents.2024.001", ok_json(message))
    work = await gateway.work("W4391234567")
    sent = len(bases.requests)
    first = await gateway.paid_access(work, useful_because="Contradicts your wiki on «Agents».")
    assert first.free_alternative_ids == [] and first.suggestion_shown_at == NOW
    assert first.recommendation == (
        "This article is paid. I think it's useful because it contradicts your wiki on «Agents». "
        "You can check it yourself; if you get it, add it to your materials."
    )
    assert first.publisher_url == "https://publisher.example.org/article/agents"
    checked = len(bases.requests)
    assert checked == sent + 2
    again = await gateway.paid_access(work, useful_because="Contradicts your wiki on «Agents».")
    assert again.recommendation is None and again.suggestion_shown_at == NOW
    assert len(bases.requests) == checked  # never re-checked, never re-suggested
    shown = await gateway.work("W4391234567")
    assert shown.access.alternatives_checked and shown.access.suggestion_shown_at == NOW


async def test_not_useful_paid_work_gets_no_suggestion_and_free_work_no_check(
    gateway: ScienceGateway, bases: Bases
) -> None:
    await enable(gateway)
    bases.on("api.openalex.org", "/works/W4400000001", ok_json(fixture_json("openalex_work_open.json")))
    free = await gateway.work("W4400000001")
    sent = len(bases.requests)
    assert (await gateway.paid_access(free, useful_because="New compared with your wiki.")).paid is False
    assert len(bases.requests) == sent
    assert paid_copy("New compared with your wiki.").startswith(
        "This article is paid. I think it's useful because it is new compared with your wiki."
    )


# -- N1 updates, dates, resolve -----------------------------------------------------------------------


async def test_updates_are_provable_facts(gateway: ScienceGateway, bases: Bases) -> None:
    await enable(gateway)
    bases.on("export.arxiv.org", "/api/query", ok_bytes(fixture("arxiv_feed.xml"), "application/atom+xml"))
    bases.on("api.openalex.org", "/works", ok_json(fixture_json("openalex_list.json")))
    crossref_list = {"status": "ok", "message": {"items": [fixture_json("crossref_work.json")["message"]]}}
    bases.on("api.crossref.org", "/works", ok_json(crossref_list))
    updates = await gateway.updates(
        [
            ScienceRef("m-arxiv", arxiv_id="2401.01234", version="v1"),
            ScienceRef("m-latest", arxiv_id="2401.01234", version="v3"),
            ScienceRef("m-doi", doi="10.1234/agents.2024.001"),
            ScienceRef("m-unversioned", arxiv_id="2401.01234"),
        ]
    )
    by = {(u.material_id, u.kind): u for u in updates}
    assert set(by) == {("m-arxiv", "new_version"), ("m-doi", "retracted")}
    version = by[("m-arxiv", "new_version")]
    assert (version.version, version.evidence_url) == ("v3", "https://arxiv.org/abs/2401.01234v3")
    assert version.replacement_work_id == "arxiv-2401_01234"
    retraction = by[("m-doi", "retracted")]
    assert retraction.evidence_url == "https://doi.org/10.1234/agents.2025.retraction"
    assert retraction.evidence_label == "Retraction (Crossref)"
    assert retraction.publication is not None and retraction.publication.date == date(2025, 6, 1)
    arxiv_request = next(r for r in bases.requests if r.url.host == "export.arxiv.org")
    assert arxiv_request.url.params["id_list"] == "2401.01234"


async def test_publication_dates(gateway: ScienceGateway, bases: Bases) -> None:
    await enable(gateway)
    bases.on(
        "api.openalex.org",
        "/works/doi:10.1234/agents.2024.001",
        ok_json(fixture_json("openalex_work_paid.json")),
    )
    bases.on("api.crossref.org", "/works/10.5555/unknown.1", ok_json(fixture_json("crossref_work.json")))
    bases.on("export.arxiv.org", "/api/query", ok_bytes(fixture("arxiv_feed.xml"), "application/atom+xml"))

    found = await gateway.publication(ScienceRef("m1", doi="10.1234/agents.2024.001"))
    assert (found.origin, found.precision, found.date) == ("openalex", "day", date(2024, 3, 5))
    registry = await gateway.publication(ScienceRef("m2", doi="10.5555/unknown.1"))
    assert (registry.origin, registry.precision, registry.month) == ("crossref", "month", 3)
    assert registry.evidence_url == "https://doi.org/10.5555/unknown.1"
    preprint = await gateway.publication(ScienceRef("m3", arxiv_id="2401.01234v2"))
    assert (preprint.origin, preprint.date) == ("arxiv", date(2024, 1, 3))
    unknown = await gateway.publication(ScienceRef("m4"))
    assert unknown.precision == "unknown"


async def test_resolve_prefers_openalex_and_falls_back_to_arxiv_only_when_unknown(
    gateway: ScienceGateway, bases: Bases
) -> None:
    await enable(gateway)
    bases.on("export.arxiv.org", "/api/query", ok_bytes(fixture("arxiv_feed.xml"), "application/atom+xml"))
    work = await gateway.resolve(ScienceRef("m1", arxiv_id="2401.01234"))
    assert work is not None and work.id == "arxiv-2401_01234" and work.provider == "arxiv"
    assert (
        work.title == "Retrieval for long documents"
        and work.abstract == "We study retrieval over long documents."
    )
    assert bases.hosts() == ["api.openalex.org", "export.arxiv.org"]
    assert await gateway.resolve(ScienceRef("m2", doi="10.9999/none")) is None


# -- Continues / Branches, taxonomy ---------------------------------------------------------------


async def test_citing_and_neighbours(gateway: ScienceGateway, bases: Bases) -> None:
    await enable(gateway)
    bases.on("api.openalex.org", "/works", ok_json(fixture_json("openalex_list.json")))
    results = await gateway.citing(["W4391234567", "arxiv-2401_01234"], since=date(2025, 1, 1))
    request = bases.requests[-1]
    assert request.url.params["filter"] == "cites:W4391234567,from_publication_date:2025-01-01"
    assert [w.id for w in results.works] == ["W5000000001"]  # the seed itself is not a new work
    await gateway.neighbours([], ["T10181", "my custom words"])
    assert bases.requests[-1].url.params["filter"] == "topics.id:T10181"
    assert (await gateway.neighbours([], ["free text only"])).works == []
    operations = [(r.operation, r.payload.ids, r.payload.topics) for r in (await gateway.journal()).records]
    assert operations == [("search", [], ["T10181"]), ("citations", ["W4391234567"], [])]


async def test_taxonomy_one_level_at_a_time_and_cached(gateway: ScienceGateway, bases: Bases) -> None:
    await enable(gateway)
    bases.on("api.openalex.org", "/domains", ok_json(fixture_json("openalex_domains.json")))
    bases.on("api.openalex.org", "/topics", ok_json(fixture_json("openalex_topics.json")))
    domains = await gateway.taxonomy(None)
    assert [(n.taxonomy_id, n.level, n.children_total, n.parent_id) for n in domains] == [
        ("domains-3", "domain", 2, None),
        ("domains-2", "domain", 1, None),
    ]
    assert await gateway.taxonomy(None) == domains
    assert len(bases.requests) == 1
    topics = await gateway.taxonomy("subfields-1702")
    assert [(n.taxonomy_id, n.level, n.parent_id) for n in topics] == [("T10181", "topic", "subfields-1702")]
    assert bases.requests[-1].url.params["filter"] == "subfield.id:1702"
    assert await gateway.taxonomy("T10181") == []
    assert len(bases.requests) == 2


async def test_arxiv_and_crossref_search_need_no_key(gateway: ScienceGateway, bases: Bases) -> None:
    await enable(gateway)
    bases.on("export.arxiv.org", "/api/query", ok_bytes(fixture("arxiv_feed.xml"), "application/atom+xml"))
    crossref_list = {
        "status": "ok",
        "message": {"items": [fixture_json("crossref_work.json")["message"]], "next-cursor": "abc"},
    }
    bases.on("api.crossref.org", "/works", ok_json(crossref_list))
    arxiv_results = await gateway.search(
        KbScienceSearch(provider="arxiv", payload=KbSciencePayload(topics=["rag"]))
    )
    assert arxiv_results.works[0].publication_type == "preprint" and arxiv_results.next_cursor is None
    crossref_results = await gateway.search(
        KbScienceSearch(provider="crossref", payload=KbSciencePayload(topics=["agents"]))
    )
    assert crossref_results.works[0].provider == "crossref" and crossref_results.next_cursor == "abc"
    assert all("authorization" not in r.headers for r in bases.requests)
    assert gateway.store.spent_today(NOW) == 0


# -- the real app ------------------------------------------------------------------------------------


async def test_runtime_wires_the_client_and_routes_go_live(kb_app: Any, kb_client: httpx.AsyncClient) -> None:
    runtime = kb_app.state.runtime
    assert isinstance(runtime.kb_science, ScienceGateway)
    assert runtime.kb_explore.science is runtime.kb_science
    response = await kb_client.get("/kb/settings/science")
    assert (response.status_code, response.json()) == (503, {"code": "not_ready"})

    runtime.kb.connect(None)
    response = await kb_client.get("/kb/settings/science")
    assert response.status_code == 200 and response.json()["enabled"] is False
    response = await kb_client.post("/kb/science/search", json={"payload": {"topics": ["agents"]}})
    assert (response.status_code, response.json()) == (403, {"code": "consent_required"})
    response = await kb_client.put("/kb/settings/science", json={"enabled": True})
    assert (response.status_code, response.json()) == (422, {"code": "invalid_request"})
    response = await kb_client.put(
        "/kb/settings/science", json={"enabled": True, "consent": "topics_dois_ids"}
    )
    assert response.status_code == 200 and response.json()["enabled"] is True
    response = await kb_client.put("/kb/settings/science/openalex-key", json={"key": SECRET})
    assert response.status_code == 200 and response.json()["openalex_key_configured"] is True
    assert SECRET not in response.text

    runtime.kb_science.store.reserve(0.9995, 1.0, datetime.now(UTC))
    response = await kb_client.post("/kb/science/search", json={"payload": {"topics": ["agents"]}})
    assert (response.status_code, response.json()) == (429, {"code": "openalex_daily_limit"})
    # The app's test HTTP client answers 599: a provider failure, not a crash.
    response = await kb_client.get("/kb/science/works/W123")
    assert (response.status_code, response.json()) == (502, {"code": "provider_unavailable"})
    response = await kb_client.get("/kb/science/works/unknown-work")
    assert (response.status_code, response.json()) == (404, {"code": "not_found"})
    journal = (await kb_client.get("/kb/science/journal?limit=1")).json()
    assert [r["outcome"] for r in journal["records"]] == ["failed"]
    assert SECRET not in json.dumps(journal)
