"""``runtime.kb_science``: B1's ``ScienceClient`` (for B2–B6) and ``ScienceService`` (for the routes).

OpenAlex is the base (keyless by default, an optional free key from the secret store); arXiv and
Crossref need no key; there is no Semantic Scholar. Only topics, DOIs and public ids leave SKAZ — every
request goes through ``transport``, which journals it first. Limits stop honestly with their reason;
SKAZ never switches provider because one failed.

Full text: OpenAlex TEI (with a key) → arXiv HTML → an open article page/file → the abstract.
FX-2 user-click imports try ``read_pdf`` first and keep the original PDF. Paid works (3c″):
free alternatives are checked first, once per work;
the suggestion appears at most once per work, and only when the work looks useful.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable, Sequence
from datetime import UTC, date, datetime
from html.parser import HTMLParser
from typing import Any, cast
from urllib.parse import unquote, urljoin, urlsplit

import httpx

from ...native_io import disk_call
from ...secrets import SecretStore
from ..api.contract_routes import ContractFailure
from ..api.schemas_explore_common import KbPublicationDate
from ..api.schemas_science import (
    KbOpenAlexKeyUpdate,
    KbPaidAccess,
    KbScienceJournal,
    KbSciencePayload,
    KbScienceResults,
    KbScienceSearch,
    KbScienceSettings,
    KbScienceSettingsUpdate,
    KbScienceText,
    KbScienceWork,
)
from ..errors import NotFound
from ..service import KnowledgeService
from ..sources.fetch import Fetched, SafeFetcher
from ..sources.html import decode_html
from ..sources.web_page import HTML_TYPES
from . import arxiv, crossref, openalex
from .fulltext import page_text, tei_text
from .ids import (
    arxiv_of_work_id,
    arxiv_work_id,
    is_openalex_work,
    mapping,
    normalize_doi,
    parent_query,
    scope_filter,
    split_arxiv,
)
from .protocols import (
    TOPIC_RESULTS,
    TOPIC_TERM_CHARS,
    TOPIC_TERMS,
    ScienceRef,
    ScienceUnavailable,
    ScienceUpdate,
    TaxonomyNode,
)
from .store import ScienceStore
from .transport import Call, ScienceTransport

logger = logging.getLogger(__name__)

#: The secret store entry of the optional OpenAlex key (as ``/kb/settings/keys/{provider}``).
KEY_NAME = "openalex"
#: OpenAlex OR-filters and the egress payload both carry at most 30 values.
MAX_IDS = 30
PAGE_LIMIT = 50
TAXONOMY_PAGE = 200
TAXONOMY_PAGES = 5
#: Open article pages tried before falling back to the abstract.
OPEN_PAGE_TRIES = 3
FILE_TRIES = 5
TEXT_FILE_TYPES = frozenset({"text/plain", "text/markdown", "text/x-markdown"})
ARTICLE_EXTENSIONS = frozenset({".pdf", ".md", ".txt", ".html", ".htm"})
PAID_COPY = (
    "This article is paid. I think it's useful because {because}. You can check it yourself; if you get it, "
    "add it to your materials."
)
_VERB_FIRST = frozenset(
    {"contradicts", "extends", "repeats", "adds", "covers", "answers", "updates", "shows"}
)
_IS_FIRST = frozenset({"new", "a", "an", "the"})


def _because(reason: str) -> str:
    """B2's reason ("Contradicts your wiki on «X».") inside the approved copy's sentence."""
    text = " ".join(reason.split()).rstrip(".").strip()
    if not text:
        return text
    lowered = text[0].lower() + text[1:]
    first = lowered.split(" ", 1)[0]
    if first in _VERB_FIRST:
        return "it " + lowered
    if first in _IS_FIRST:
        return "it is " + lowered
    return lowered


def paid_copy(reason: str) -> str:
    return PAID_COPY.format(because=_because(reason))


def _results(works: list[KbScienceWork], cursor: str | None) -> KbScienceResults:
    return KbScienceResults(works=works, next_cursor=cursor, stop_reason=None)


def _extension(url: str) -> str:
    try:
        path = unquote(urlsplit(url).path).lower()
    except ValueError:
        return ""
    return "." + path.rsplit(".", 1)[-1] if "." in path.rsplit("/", 1)[-1] else ""


class _ArticleLinks(HTMLParser):
    """Only file links and alternate representations; article text never becomes an instruction."""

    def __init__(self, base: str) -> None:
        super().__init__(convert_charrefs=True)
        self.base = base
        self.urls: list[str] = []
        self.pdf_urls: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        href = values.get("href")
        if tag not in ("a", "link") or not href:
            return
        try:
            url = urljoin(self.base, href)
        except ValueError:
            return
        alternate = tag == "link" and "alternate" in (values.get("rel") or "").lower().split()
        if (
            url.startswith(("https://", "http://")) and (_extension(url) in ARTICLE_EXTENSIONS or alternate)
            and url not in self.urls
        ):
            self.urls.append(url)
            if _extension(url) == ".pdf" or values.get("type") == "application/pdf":
                self.pdf_urls.append(url)


def _article_links(fetched: Fetched, *, pdf_only: bool = False) -> list[str]:
    if fetched.content_type not in HTML_TYPES:
        return []
    parser = _ArticleLinks(fetched.url)
    parser.feed(decode_html(fetched.body, fetched.charset))
    return parser.pdf_urls if pdf_only else parser.urls


def _is_pdf(fetched: Fetched) -> bool:
    return fetched.body.startswith(b"%PDF-") or fetched.content_type == "application/pdf"


def _page_text(fetched: Fetched) -> str | None:
    try:
        return page_text(fetched)
    except (AssertionError, ValueError):
        # Some empty/broken repository pages make readability/lxml fail instead of returning no text.
        return None


def _file_text(fetched: Fetched) -> str | None:
    if _is_pdf(fetched):
        return None
    if fetched.content_type in TEXT_FILE_TYPES or (
        fetched.content_type in ("", "application/octet-stream")
        and _extension(fetched.url) in (".md", ".txt")
    ):
        body = decode_html(fetched.body, fetched.charset).strip()
        return body[:400_000] if len(body) >= 80 else None
    return _page_text(fetched)


class ScienceGateway:
    """Implements ``ScienceClient`` and ``ScienceService``; the routes reach it as ``runtime.kb_science``."""

    def __init__(
        self,
        kb: KnowledgeService,
        secrets: SecretStore,
        http: httpx.AsyncClient,
        fetcher: SafeFetcher | None = None,
        *,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
        transport: ScienceTransport | None = None,
    ) -> None:
        self.kb = kb
        self.secrets = secrets
        self.store = ScienceStore(kb.db, kb.settings)
        self.now = now
        #: The secret store couldn't be read at the last try: requests go keyless and Settings says so.
        self.key_unreadable = False
        self.transport = transport or ScienceTransport(
            self.store, http, self._key, fetcher or SafeFetcher(), now=now
        )

    # -- helpers ---------------------------------------------------------------------------------------

    def _key(self) -> str | None:
        try:
            value = self.secrets.get(KEY_NAME)
        except Exception as error:
            # Requests go on keyless (never a crash), but not silently (user decision B1-6 A): the warning
            # here and the Settings problem from ``key_unreadable`` say the key isn't being used.
            self.key_unreadable = True
            logger.warning("OpenAlex key couldn't be read: %s", type(error).__name__)
            return None
        self.key_unreadable = False
        return value.strip() or None if isinstance(value, str) else None

    def key_problem(self) -> bool:
        """Settings → problems: True when the secret store can't be read, so a saved key isn't used."""
        self._key()
        return self.key_unreadable

    async def _ready(self) -> None:
        view = await disk_call(self.kb.view)
        if view.state == "not_configured":
            raise ContractFailure(503, "not_ready")

    async def _json(self, call: Call, run_id: str | None) -> Any | None:
        body = await self.transport.body(call, run_id=run_id)
        if body is None:
            return None
        try:
            return json.loads(body)
        except ValueError as error:
            logger.warning("Science answer was not JSON: %s %s", call.provider, call.operation)
            raise ScienceUnavailable() from error

    async def _feed(self, call: Call, run_id: str | None) -> tuple[list[arxiv.ArxivEntry], int]:
        body = await self.transport.body(call, run_id=run_id)
        if body is None:
            return [], 0
        try:
            return arxiv.parse_feed(body)
        except Exception as error:  # lxml raises several types for a broken feed
            logger.warning("arXiv answer was not a feed: %s", type(error).__name__)
            raise ScienceUnavailable() from error

    def _with_access(self, works: Sequence[KbScienceWork]) -> list[KbScienceWork]:
        """Cached works plus what the one-time paid check already found (sync, for ``disk_call``)."""
        self.store.save_works(works, self.now())
        merged: list[KbScienceWork] = []
        for work in works:
            check = self.store.paid_check(work.id)
            if check is None:
                merged.append(work)
                continue
            access = work.access.model_copy(
                update={
                    "alternatives_checked": check.checked_at is not None,
                    "free_alternative_ids": list(check.alternatives),
                    "suggestion_shown_at": check.suggestion_shown_at,
                }
            )
            merged.append(work.model_copy(update={"access": access}))
        return merged

    async def _keep(self, works: Sequence[KbScienceWork]) -> list[KbScienceWork]:
        return await disk_call(self._with_access, openalex.deduplicate_works(works))

    async def _openalex_work(
        self, path: str, payload: KbSciencePayload, operation: Any, run_id: str | None
    ) -> KbScienceWork | None:
        data = await self._json(
            Call(
                "openalex",
                operation,
                f"{openalex.API}/works/{path}",
                payload,
                params={"select": openalex.WORK_FIELDS},
                cost=openalex.COST_SINGLE,
            ),
            run_id,
        )
        work = openalex.parse_work(data) if isinstance(data, dict) else None
        if work is not None:
            work = (await self._keep([work]))[0]
        return work

    async def _work(self, work_id: str, run_id: str | None) -> KbScienceWork:
        cached = await disk_call(self.store.work, work_id)
        if cached is not None:
            return (await self._keep([cached]))[0]
        if is_openalex_work(work_id):
            found = await self._openalex_work(work_id, KbSciencePayload(ids=[work_id]), "metadata", run_id)
            if found is not None:
                return found
        elif (arxiv_id := arxiv_of_work_id(work_id)) is not None:
            entries, _ = await self._feed(
                Call(
                    "arxiv",
                    "metadata",
                    arxiv.API,
                    KbSciencePayload(ids=[arxiv_id]),
                    params=arxiv.id_params([arxiv_id]),
                    accept="application/atom+xml",
                ),
                run_id,
            )
            if entries:
                return (await self._keep([entries[0].work]))[0]
        raise NotFound("No such work")

    # -- ScienceService (routes) -------------------------------------------------------------------

    def _settings_now(self) -> KbScienceSettings:
        return KbScienceSettings(
            enabled=self.store.enabled(),
            consent_at=self.store.consent_at(),
            openalex_key_configured=self._key() is not None,
            full_text_hint_dismissed=self.store.hint_dismissed(),
        )

    async def settings(self) -> KbScienceSettings:
        await self._ready()
        return await disk_call(self._settings_now)

    async def update_settings(self, body: KbScienceSettingsUpdate) -> KbScienceSettings:
        await self._ready()
        await disk_call(self.store.set_enabled, body.enabled, self.now())
        return await disk_call(self._settings_now)

    async def set_key(self, body: KbOpenAlexKeyUpdate) -> KbScienceSettings:
        await self._ready()
        key = body.key.get_secret_value().strip()
        if key:
            await disk_call(self.secrets.set, KEY_NAME, key)
        else:
            await disk_call(self.secrets.delete, KEY_NAME)
        return await disk_call(self._settings_now)

    async def journal(self, cursor: str | None = None, limit: int = 50) -> KbScienceJournal:
        await self._ready()
        records, next_cursor = await disk_call(self.store.journal, cursor, limit)
        return KbScienceJournal(records=records, next_cursor=next_cursor)

    async def dismiss_hint(self) -> KbScienceSettings:
        await self._ready()
        await disk_call(self.store.dismiss_hint)
        return await disk_call(self._settings_now)

    async def work(self, work_id: str) -> KbScienceWork:
        await self._ready()
        return await self._work(work_id, None)

    # -- shared: search, read_text ------------------------------------------------------------------

    async def search(self, body: KbScienceSearch, *, run_id: str | None = None) -> KbScienceResults:
        await self._ready()
        if body.provider == "arxiv":
            return await self._search_arxiv(body, run_id)
        if body.provider == "crossref":
            return await self._search_crossref(body, run_id)
        return await self._search_openalex(body, run_id)

    async def _search_openalex(self, body: KbScienceSearch, run_id: str | None) -> KbScienceResults:
        payload = body.payload
        cached = await disk_call(self.store.works, payload.ids)
        missing = [work_id for work_id in payload.ids if work_id not in cached]
        openalex_ids = [work_id for work_id in missing if is_openalex_work(work_id)]
        found = [cached[work_id] for work_id in payload.ids if work_id in cached]
        if not payload.topics and not payload.dois and not openalex_ids:
            return _results(await self._keep(found), None)  # every id is known here: nothing leaves
        words = [topic for topic in payload.topics if scope_filter(topic) is None]
        groups: list[tuple[str, list[str]] | None] = list(openalex.scopes(payload.topics)) or [None]
        cursor: str | None = None
        for scope in groups:
            sent = KbSciencePayload(
                topics=words + (scope[1] if scope else []), dois=payload.dois, ids=openalex_ids
            )
            params, cost = openalex.search_request(body, openalex_ids, scope)
            data = await self._json(
                Call("openalex", "search", f"{openalex.API}/works", sent, params=params, cost=cost), run_id
            )
            works, cursor = openalex.parse_list(data) if isinstance(data, dict) else ([], None)
            found += [work for work in works if work.id not in {known.id for known in found}]
        # Several groups are several lists: there is no one cursor to go on with.
        return _results(await self._keep(found), cursor if len(groups) == 1 else None)

    async def _search_arxiv(self, body: KbScienceSearch, run_id: str | None) -> KbScienceResults:
        ids = [
            found[0]
            for value in body.payload.ids
            if (found := split_arxiv(arxiv_of_work_id(value) or value)) is not None
        ]
        if not body.payload.topics and not ids:
            return _results([], None)
        start = int(body.cursor or 0) if (body.cursor or "0").isdigit() else 0
        entries, total = await self._feed(
            Call(
                "arxiv",
                "search",
                arxiv.API,
                KbSciencePayload(topics=body.payload.topics, ids=ids),
                params=arxiv.search_params(body, ids),
                accept="application/atom+xml",
            ),
            run_id,
        )
        following = start + len(entries)
        cursor = str(following) if entries and following < total else None
        return _results(await self._keep([entry.work for entry in entries]), cursor)

    async def _search_crossref(self, body: KbScienceSearch, run_id: str | None) -> KbScienceResults:
        dois = [doi for value in body.payload.dois if (doi := normalize_doi(value))]
        if not body.payload.topics and not dois:
            return _results([], None)
        data = await self._json(
            Call(
                "crossref",
                "search",
                f"{crossref.API}/works",
                KbSciencePayload(topics=body.payload.topics, dois=dois),
                params=crossref.search_params(body),
            ),
            run_id,
        )
        works, cursor = crossref.parse_list(data) if isinstance(data, dict) else ([], None)
        return _results(await self._keep(works), cursor)

    async def read_pdf(self, work_id: str, *, run_id: str | None = None) -> Fetched | None:
        """FX-2, user-click only: explicit open PDF → PDF on an open repository page."""
        await self._ready()
        work = await self._work(work_id, run_id)
        sent = KbSciencePayload(dois=[work.doi]) if work.doi else KbSciencePayload(ids=[work.provider_id])

        def call(url: str) -> Call:
            provider = (
                "arxiv" if urlsplit(url).hostname in ("arxiv.org", "export.arxiv.org") else work.provider
            )
            return Call(provider, "full_text", url, sent)

        urls = [loc.url for loc in work.locations if loc.open_access and _extension(loc.url) == ".pdf"]
        if work.arxiv_id:
            urls.insert(0, f"https://arxiv.org/pdf/{work.arxiv_id}.pdf")
        tried: set[str] = set()
        for url in dict.fromkeys(urls):
            tried.add(url)
            fetched = await self.transport.download(call(url), run_id=run_id)
            if fetched is not None and _is_pdf(fetched):
                return fetched
        pages = [
            loc.url for loc in work.locations
            if loc.open_access and loc.kind == "open_page" and _extension(loc.url) not in (".md", ".txt")
        ]
        for url in [url for url in dict.fromkeys(pages) if url not in tried][:OPEN_PAGE_TRIES]:
            tried.add(url)
            fetched = await self.transport.download(call(url), run_id=run_id)
            if fetched is None:
                continue
            if _is_pdf(fetched):
                return fetched
            links = [
                link for link in _article_links(fetched, pdf_only=True) if link not in tried
            ]
            for link in links[:FILE_TRIES]:
                tried.add(link)
                pdf = await self.transport.download(call(link), run_id=run_id)
                if pdf is not None and _is_pdf(pdf):
                    return pdf
        return None

    async def read_text(self, work_id: str, *, run_id: str | None = None) -> KbScienceText:
        await self._ready()
        work = await self._work(work_id, run_id)
        key = await disk_call(self._key)
        check = await disk_call(self.store.paid_check, work.id)
        alternatives = check.alternatives if check is not None else []

        def text(kind: Any, body: str, url: str | None) -> KbScienceText:
            return KbScienceText(work_id=work.id, kind=kind, text=body, source_url=url, access=work.access)

        tei = next((loc for loc in work.locations if loc.kind == "tei"), None)
        if key and tei is not None and work.provider == "openalex":
            try:
                raw = await self.transport.body(
                    Call(
                        "openalex",
                        "full_text",
                        tei.url,
                        KbSciencePayload(ids=[work.provider_id]),
                        cost=openalex.COST_CONTENT,
                        accept="application/xml,text/xml;q=0.9",
                    ),
                    run_id=run_id,
                )
            except ScienceUnavailable:
                raw = None
            body = tei_text(raw) if raw is not None else None
            if body:
                return text("tei", body, tei.url)

        arxiv_ids = [work.arxiv_id] if work.arxiv_id else []
        arxiv_ids += [
            found[0] for alt in alternatives if alt.startswith("arxiv:") and (found := split_arxiv(alt))
        ]
        for arxiv_id in dict.fromkeys(arxiv_ids):
            url = f"https://arxiv.org/html/{arxiv_id}"
            fetched = await self.transport.page(
                Call("arxiv", "full_text", url, KbSciencePayload(ids=[arxiv_id])),
                run_id=run_id, allow_vpn_fake_ip=True,
            )
            body = _page_text(fetched) if fetched is not None else None
            if body:
                return text("arxiv_html", body, url)

        pages = [
            loc.url for loc in work.locations
            if loc.kind == "open_page" and loc.open_access and _extension(loc.url) != ".pdf"
        ]
        pages += [alt for alt in alternatives if alt.startswith(("https://", "http://"))]
        sent = KbSciencePayload(dois=[work.doi]) if work.doi else KbSciencePayload(ids=[work.provider_id])
        for url in list(dict.fromkeys(pages))[:OPEN_PAGE_TRIES]:
            if _extension(url) in (".md", ".txt"):
                fetched = await self.transport.download(
                    Call(work.provider, "full_text", url, sent), run_id=run_id,
                )
                body = _file_text(fetched) if fetched is not None else None
                if body:
                    return text("open_page", body, fetched.url if fetched else url)
                continue
            fetched = await self.transport.page(
                Call(work.provider, "full_text", url, sent), run_id=run_id, allow_vpn_fake_ip=True,
            )
            if fetched is not None:
                links = [
                    link for link in _article_links(fetched) if _extension(link) != ".pdf" and link != url
                ]
                for link in links[:FILE_TRIES]:
                    attached = await self.transport.download(
                        Call(work.provider, "full_text", link, sent), run_id=run_id,
                    )
                    body = _file_text(attached) if attached is not None else None
                    if body:
                        return text("open_page", body, attached.url if attached else link)
            body = _page_text(fetched) if fetched is not None else None
            if body:
                return text("open_page", body, fetched.url if fetched else url)

        return text("abstract_only", work.abstract or "", None)

    async def open_text_url(self, work_id: str, *, run_id: str | None = None) -> str | None:
        """EX3 (UX-3): the free copy the reader opens, checked by fetching it — free (no paid OpenAlex
        content call). arXiv HTML first (an arXiv paper always has its PDF), then the open pages."""
        await self._ready()
        work = await self._work(work_id, run_id)
        from_html = (split_arxiv(loc.url) for loc in work.locations if loc.kind == "arxiv_html")
        arxiv_id = work.arxiv_id or next((found[0] for found in from_html if found), None)
        if arxiv_id:
            url = f"https://arxiv.org/html/{arxiv_id}"
            fetched = await self.transport.page(
                Call("arxiv", "full_text", url, KbSciencePayload(ids=[arxiv_id])),
                run_id=run_id, allow_vpn_fake_ip=True,
            )
            return url if fetched is not None and _page_text(fetched) else f"https://arxiv.org/pdf/{arxiv_id}"
        sent = KbSciencePayload(dois=[work.doi]) if work.doi else KbSciencePayload(ids=[work.provider_id])
        pages = [loc.url for loc in work.locations if loc.kind == "open_page" and loc.open_access]
        pdfs = [url for url in pages if _extension(url) == ".pdf"]
        for url in list(dict.fromkeys(url for url in pages if url not in pdfs))[:OPEN_PAGE_TRIES]:
            fetched = await self.transport.page(
                Call(work.provider, "full_text", url, sent), run_id=run_id, allow_vpn_fake_ip=True,
            )
            if fetched is not None and _page_text(fetched):
                return url
        # Keep PDF-only works visible without downloading their PDFs during automatic search checks.
        return next(iter(pdfs), None)

    # -- ScienceClient --------------------------------------------------------------------------------

    async def citing(
        self,
        work_ids: Sequence[str],
        *,
        since: date | None = None,
        cursor: str | None = None,
        run_id: str | None = None,
    ) -> KbScienceResults:
        ids = [work_id for work_id in dict.fromkeys(work_ids) if is_openalex_work(work_id)][:MAX_IDS]
        if not ids:
            return _results([], None)
        filters = ["cites:" + "|".join(ids)]
        if since is not None:
            filters.append(f"from_publication_date:{since.isoformat()}")
        data = await self._json(
            Call(
                "openalex",
                "citations",
                f"{openalex.API}/works",
                KbSciencePayload(ids=ids),
                params=openalex.list_request(
                    filters, limit=PAGE_LIMIT, cursor=cursor, sort="publication_date:desc"
                ),
                cost=openalex.COST_LIST,
            ),
            run_id,
        )
        works, next_cursor = openalex.parse_list(data) if isinstance(data, dict) else ([], None)
        return _results(await self._keep([w for w in works if w.id not in ids]), next_cursor)

    async def neighbours(
        self,
        work_ids: Sequence[str],
        topic_ids: Sequence[str],
        *,
        since: date | None = None,
        cursor: str | None = None,
        run_id: str | None = None,
    ) -> KbScienceResults:
        """Works related to the seeds (OpenAlex ``related_to``), else works in the given topics."""
        ids = [work_id for work_id in dict.fromkeys(work_ids) if is_openalex_work(work_id)][:MAX_IDS]
        requests: list[tuple[list[str], KbSciencePayload, str]] = []
        if ids:
            requests.append((["related_to:" + "|".join(ids)], KbSciencePayload(ids=ids), "citations"))
        else:
            # A topic, or a domain/field/subfield by its hierarchy filter (review R1-05); one request per
            # filter kind, since OpenAlex ANDs separate filters.
            for name, group in openalex.scopes(list(dict.fromkeys(topic_ids)), limit=MAX_IDS):
                requests.append(
                    ([openalex.scope_expression(name, group)], KbSciencePayload(topics=group), "search")
                )
        if not requests:
            return _results([], None)
        found: list[KbScienceWork] = []
        next_cursor: str | None = None
        for filters, payload, operation in requests:
            if since is not None:
                filters.append(f"from_publication_date:{since.isoformat()}")
            data = await self._json(
                Call(
                    "openalex",
                    cast(Any, operation),
                    f"{openalex.API}/works",
                    payload,
                    params=openalex.list_request(
                        filters, limit=PAGE_LIMIT, cursor=cursor, sort="publication_date:desc"
                    ),
                    cost=openalex.COST_LIST,
                ),
                run_id,
            )
            works, next_cursor = openalex.parse_list(data) if isinstance(data, dict) else ([], None)
            seen = {work.id for work in found} | set(ids)
            found += [work for work in works if work.id not in seen]
        return _results(await self._keep(found), next_cursor if len(requests) == 1 else None)

    async def resolve(self, ref: ScienceRef, *, run_id: str | None = None) -> KbScienceWork | None:
        doi = normalize_doi(ref.doi)
        found_arxiv = split_arxiv(ref.arxiv_id)
        arxiv_id = found_arxiv[0] if found_arxiv else None
        cached = (await disk_call(self.store.work_by_doi, doi) if doi else None) or (
            await disk_call(self.store.work_by_arxiv, arxiv_id) if arxiv_id else None
        )
        if cached is not None and cached.provider == "openalex":
            return (await self._keep([cached]))[0]
        if doi:
            work = await self._openalex_work(f"doi:{doi}", KbSciencePayload(dois=[doi]), "metadata", run_id)
            if work is not None or not arxiv_id:
                return work
        if arxiv_id:
            arxiv_doi = f"10.48550/arxiv.{arxiv_id}".lower()
            work = await self._openalex_work(
                f"doi:{arxiv_doi}", KbSciencePayload(dois=[arxiv_doi]), "metadata", run_id
            )
            if work is not None:
                return work
            if cached is not None:
                return (await self._keep([cached]))[0]
            entries, _ = await self._feed(
                Call(
                    "arxiv",
                    "metadata",
                    arxiv.API,
                    KbSciencePayload(ids=[arxiv_id]),
                    params=arxiv.id_params([arxiv_id]),
                    accept="application/atom+xml",
                ),
                run_id,
            )
            if entries:
                return (await self._keep([entries[0].work]))[0]
        return None

    async def publication(self, ref: ScienceRef, *, run_id: str | None = None) -> KbPublicationDate:
        doi = normalize_doi(ref.doi)
        found_arxiv = split_arxiv(ref.arxiv_id)
        arxiv_id = found_arxiv[0] if found_arxiv else None
        if doi:
            cached = await disk_call(self.store.work_by_doi, doi)
            if cached is not None and cached.publication.precision != "unknown":
                return cached.publication
            work = await self._openalex_work(f"doi:{doi}", KbSciencePayload(dois=[doi]), "metadata", run_id)
            if work is not None and work.publication.precision != "unknown":
                return work.publication
            if work is None:  # OpenAlex doesn't know the DOI (not a failure): ask its registry
                data = await self._json(
                    Call("crossref", "metadata", crossref.work_url(doi), KbSciencePayload(dois=[doi])), run_id
                )
                message = data.get("message") if isinstance(data, dict) else None
                if isinstance(message, dict) and (published := crossref.publication_of(message, doi)):
                    return published
        if arxiv_id:
            cached = await disk_call(self.store.work_by_arxiv, arxiv_id)
            if cached is not None and cached.provider == "arxiv":
                return cached.publication
            entries, _ = await self._feed(
                Call(
                    "arxiv",
                    "metadata",
                    arxiv.API,
                    KbSciencePayload(ids=[arxiv_id]),
                    params=arxiv.id_params([arxiv_id]),
                    accept="application/atom+xml",
                ),
                run_id,
            )
            if entries:
                await self._keep([entries[0].work])
                return entries[0].work.publication
        return openalex.UNKNOWN_DATE

    async def updates(
        self, refs: Sequence[ScienceRef], *, run_id: str | None = None
    ) -> Sequence[ScienceUpdate]:
        """Provable N1 facts only: a newer arXiv version than the user's, a retraction, a new version."""
        found: dict[tuple[str, str], ScienceUpdate] = {}
        by_arxiv: dict[str, list[ScienceRef]] = {}
        by_doi: dict[str, list[ScienceRef]] = {}
        for ref in refs:
            doi = normalize_doi(ref.doi)
            if doi:
                by_doi.setdefault(doi, []).append(ref)
            found_arxiv = split_arxiv(ref.arxiv_id)
            if found_arxiv is not None and ref.version:
                by_arxiv.setdefault(found_arxiv[0], []).append(ref)

        arxiv_ids = list(by_arxiv)
        for start in range(0, len(arxiv_ids), MAX_IDS):
            batch = arxiv_ids[start : start + MAX_IDS]
            entries, _ = await self._feed(
                Call(
                    "arxiv",
                    "metadata",
                    arxiv.API,
                    KbSciencePayload(ids=batch),
                    params=arxiv.id_params(batch),
                    accept="application/atom+xml",
                ),
                run_id,
            )
            await self._keep([entry.work for entry in entries])
            for entry in entries:
                latest = entry.latest_version
                for ref in by_arxiv.get(entry.work.provider_id, ()):
                    if latest and ref.version and int(latest[1:]) > int(ref.version.lower().lstrip("v") or 0):
                        published = (
                            KbPublicationDate(
                                year=entry.updated.year,
                                date=entry.updated,
                                month=entry.updated.month,
                                precision="day",
                                origin="arxiv",
                                evidence_url=arxiv.abs_url(entry.work.provider_id, latest),
                            )
                            if entry.updated is not None
                            else None
                        )
                        found[(ref.material_id, "new_version")] = ScienceUpdate(
                            material_id=ref.material_id,
                            kind="new_version",
                            evidence_url=arxiv.abs_url(entry.work.provider_id, latest),
                            evidence_label=f"arXiv {entry.work.provider_id}{latest}",
                            version=latest,
                            replacement_work_id=arxiv_work_id(entry.work.provider_id),
                            publication=published,
                        )

        # "," and "|" separate filter values: a DOI holding one can't ride in a batched filter.
        dois = [doi for doi in by_doi if "," not in doi and "|" not in doi]
        for start in range(0, len(dois), MAX_IDS):
            batch = dois[start : start + MAX_IDS]
            data = await self._json(
                Call(
                    "openalex",
                    "metadata",
                    f"{openalex.API}/works",
                    KbSciencePayload(dois=batch),
                    params=openalex.list_request(["doi:" + "|".join(batch)], limit=len(batch), cursor=None),
                    cost=openalex.COST_LIST,
                ),
                run_id,
            )
            for item in (data.get("results") or ()) if isinstance(data, dict) else ():
                if not isinstance(item, dict) or not openalex.is_retracted(item):
                    continue
                work = openalex.parse_work(item)
                for ref in by_doi.get(openalex.doi_key(item) or "", ()):
                    found[(ref.material_id, "retracted")] = ScienceUpdate(
                        material_id=ref.material_id,
                        kind="retracted",
                        evidence_url=f"https://openalex.org/{work.id}" if work else None,
                        evidence_label="Marked retracted in OpenAlex",
                    )
            data = await self._json(
                Call(
                    "crossref",
                    "metadata",
                    f"{crossref.API}/works",
                    KbSciencePayload(dois=batch),
                    params=crossref.doi_filter(batch),
                ),
                run_id,
            )
            message = data.get("message") if isinstance(data, dict) else None
            for item in (message.get("items") or ()) if isinstance(message, dict) else ():
                if not isinstance(item, dict):
                    continue
                doi = normalize_doi(str(item.get("DOI") or ""))
                for update in crossref.updates_of(item):
                    for ref in by_doi.get(doi or "", ()):
                        evidence = f"https://doi.org/{update.notice_doi}" if update.notice_doi else None
                        found[(ref.material_id, update.kind)] = ScienceUpdate(
                            material_id=ref.material_id,
                            kind=update.kind,
                            evidence_url=evidence,
                            evidence_label=f"{update.label} (Crossref)",
                            publication=update.published,
                        )
        return list(found.values())

    async def search_topics(
        self, terms: Sequence[str], *, run_id: str | None = None
    ) -> Sequence[TaxonomyNode]:
        """Free /topics searches for X1's hidden label: one per term, since OpenAlex ANDs the words of a
        search (a topic name joined with its concepts matched no topic at all). The topics found by more
        terms come first, then by the first term that found them and its rank. No model work here."""
        await self._ready()
        words = list(dict.fromkeys(term.strip() for term in terms if term.strip()))
        if not words:
            return []
        if len(words) > TOPIC_TERMS or any(len(word) > TOPIC_TERM_CHARS for word in words):
            raise ContractFailure(422, "invalid_request")
        found: dict[str, tuple[TaxonomyNode, int, int, int]] = {}  # id → node, hits, first term, rank
        for index, word in enumerate(words):
            data = await self._json(
                Call(
                    "openalex",
                    "taxonomy",
                    f"{openalex.API}/topics",
                    KbSciencePayload(topics=[word]),
                    params={"search": word, "per-page": str(TOPIC_RESULTS)},
                    cost=openalex.COST_SINGLE,
                ),
                run_id,
            )
            if not isinstance(data, dict) or not isinstance(data.get("results"), list):
                raise ScienceUnavailable()
            for rank, found_node in enumerate(openalex.taxonomy_nodes(data, None, "topic")):
                known = found.get(found_node.taxonomy_id)
                if known is None:
                    found[found_node.taxonomy_id] = (found_node, 1, index, rank)
                else:
                    found[found_node.taxonomy_id] = (known[0], known[1] + 1, known[2], known[3])
        ranked = sorted(found.values(), key=lambda item: (-item[1], item[2], item[3]))
        return [item[0] for item in ranked][:TOPIC_RESULTS]

    async def taxonomy(self, parent_id: str | None = None) -> Sequence[TaxonomyNode]:
        """One level of the OpenAlex taxonomy; kept 30 days, since it changes rarely and B4 asks per view."""
        now = self.now()
        cached = await disk_call(self.store.taxonomy, parent_id, now)
        if cached is not None:
            return cached
        if parent_id is None:
            endpoint, filters, level = "domains", None, "domain"
        else:
            query = parent_query(parent_id)
            if query is None:
                return []  # a topic or an id that is not OpenAlex's: no children
            endpoint, filters, level = query
        nodes: list[TaxonomyNode] = []
        cursor: str | None = "*"
        payload = KbSciencePayload(ids=[parent_id] if parent_id else [])
        for _ in range(TAXONOMY_PAGES):
            params = {"per-page": str(TAXONOMY_PAGE), "cursor": cursor or "*"}
            if filters:
                params["filter"] = filters
            data = await self._json(
                Call(
                    "openalex",
                    "taxonomy",
                    f"{openalex.API}/{endpoint}",
                    payload,
                    params=params,
                    cost=openalex.COST_LIST,
                ),
                None,
            )
            if not isinstance(data, dict):
                break
            page = openalex.taxonomy_nodes(data, parent_id, level)
            nodes += page
            meta = mapping(data.get("meta"))
            cursor = meta.get("next_cursor") if isinstance(meta.get("next_cursor"), str) else None
            if not cursor or not page:
                break
        await disk_call(self.store.save_taxonomy, parent_id, nodes, now)
        return nodes

    async def paid_access(
        self, work: KbScienceWork, *, useful_because: str | None, run_id: str | None = None
    ) -> KbPaidAccess:
        if not work.access.paid:
            return work.access
        await disk_call(self.store.save_works, [work], self.now())
        check = await disk_call(self.store.paid_check, work.id)
        if check is None or check.checked_at is None:
            alternatives = await self._alternatives(work, run_id)
            await disk_call(self.store.save_paid_check, work.id, self.now(), alternatives)
        else:
            alternatives = check.alternatives
        recommendation = None
        useful = bool(useful_because and useful_because.strip())
        if useful and not alternatives and await disk_call(self.store.mark_suggestion, work.id, self.now()):
            recommendation = paid_copy(useful_because or "")
        check = await disk_call(self.store.paid_check, work.id)
        publisher = work.access.publisher_url or next(
            (loc.url for loc in work.locations if loc.kind == "publisher"), None
        )
        return KbPaidAccess(
            paid=True,
            alternatives_checked=True,
            free_alternative_ids=list(alternatives),
            suggestion_shown_at=check.suggestion_shown_at if check is not None else None,
            recommendation=recommendation,
            publisher_url=publisher,
        )

    async def _alternatives(self, work: KbScienceWork, run_id: str | None) -> list[str]:
        """Free copies of a paid work: open locations OpenAlex knows now, and preprints Crossref names."""
        found: list[str] = []
        if work.provider == "openalex":
            fresh = await self._openalex_work(
                work.provider_id, KbSciencePayload(ids=[work.provider_id]), "alternatives", run_id
            )
            if fresh is not None:
                if fresh.arxiv_id:
                    found.append(f"arxiv:{fresh.arxiv_id}")
                found += [loc.url for loc in fresh.locations if loc.kind == "open_page" and loc.open_access]
                if await disk_call(self._key) and any(loc.kind == "tei" for loc in fresh.locations):
                    found.append(f"openalex-tei:{fresh.provider_id}")
        if work.doi:
            data = await self._json(
                Call(
                    "crossref", "alternatives", crossref.work_url(work.doi), KbSciencePayload(dois=[work.doi])
                ),
                run_id,
            )
            message = data.get("message") if isinstance(data, dict) else None
            if isinstance(message, dict):
                for doi in crossref.preprints_of(message):
                    preprint = split_arxiv(doi)
                    found.append(f"arxiv:{preprint[0]}" if preprint else f"doi:{doi}")
        return list(dict.fromkeys(found))
