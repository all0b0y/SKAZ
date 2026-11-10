"""OpenAlex: request shapes and response parsing (no I/O here).

Docs: https://developers.openalex.org/api/authentication (key, budget, 429) and
https://developers.openalex.org/access/fulltext (TEI XML, ``has_content``). Costs per request, in USD:
single entity free, list + filter $0.0001, search $0.001, content download $0.01. Daily budget: $0.10
without a key, $1 with a free key; it resets at midnight UTC.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import date
from typing import Any

from ..api.schemas_explore_common import KbPublicationDate
from ..api.schemas_science import KbPaidAccess, KbScienceLocation, KbScienceSearch, KbScienceWork
from .ids import (
    is_openalex_work,
    is_topic_id,
    mapping,
    normalize_doi,
    short_openalex,
    split_arxiv,
    taxonomy_id,
)
from .protocols import TaxonomyNode

API = "https://api.openalex.org"
API_HOST = "api.openalex.org"
CONTENT_HOST = "content.openalex.org"
COST_SINGLE = 0.0
COST_LIST = 0.0001
COST_SEARCH = 0.001
COST_CONTENT = 0.01
ALLOWANCE_KEYLESS = 0.10
ALLOWANCE_KEY = 1.0
#: Only the fields SKAZ reads; a smaller answer, the same cost.
WORK_FIELDS = ",".join(
    (
        "id",
        "doi",
        "title",
        "display_name",
        "publication_year",
        "publication_date",
        "type",
        "primary_location",
        "locations",
        "best_oa_location",
        "open_access",
        "authorships",
        "topics",
        "referenced_works",
        "cited_by_count",
        "is_retracted",
        "has_content",
        "abstract_inverted_index",
        "ids",
    )
)
UNKNOWN_DATE = KbPublicationDate(
    year=None, date=None, month=None, precision="unknown", origin="unknown", evidence_url=None
)


def work_url(work_id: str) -> str:
    return f"{API}/works/{work_id}"


def tei_url(work_id: str) -> str:
    return f"https://{CONTENT_HOST}/works/{work_id}.grobid-xml"


def abstract_text(index: Mapping[str, Sequence[int]] | None) -> str | None:
    """OpenAlex ships abstracts as an inverted index (word → positions)."""
    if not index:
        return None
    placed: dict[int, str] = {}
    for word, positions in index.items():
        for position in positions:
            if isinstance(position, int) and 0 <= position < 100_000:
                placed[position] = word
    text = " ".join(placed[key] for key in sorted(placed)).strip()
    return text or None


def publication_of(data: Mapping[str, Any], evidence_url: str | None) -> KbPublicationDate:
    raw = data.get("publication_date")
    if isinstance(raw, str):
        try:
            day = date.fromisoformat(raw[:10])
        except ValueError:
            day = None
        if day is not None:
            return KbPublicationDate(
                year=day.year,
                date=day,
                month=day.month,
                precision="day",
                origin="openalex",
                evidence_url=evidence_url,
            )
    year = data.get("publication_year")
    if isinstance(year, int) and 1 <= year <= 9999:
        return KbPublicationDate(
            year=year, date=None, month=None, precision="year", origin="openalex", evidence_url=evidence_url
        )
    return UNKNOWN_DATE


def _arxiv_of(data: Mapping[str, Any], doi: str | None) -> str | None:
    found = split_arxiv(doi) if doi else None
    if found is not None:
        return found[0]
    for location in data.get("locations") or ():
        if not isinstance(location, Mapping):
            continue
        for key in ("landing_page_url", "pdf_url"):
            value = location.get(key)
            if isinstance(value, str) and "arxiv.org/" in value.lower():
                found = split_arxiv(value)
                if found is not None:
                    return found[0]
    return None


def _is_pdf(url: str) -> bool:
    return url.lower().split("?", 1)[0].endswith(".pdf")


def locations_of(data: Mapping[str, Any], work_id: str, arxiv_id: str | None) -> list[KbScienceLocation]:
    """Text locations in the 3c′ order. PDF links are never listed: research never downloads a PDF."""
    found: list[KbScienceLocation] = []
    seen: set[str] = set()

    def add(url: str, kind: Any, open_access: bool) -> None:
        if url and url not in seen and url.startswith(("https://", "http://")):
            seen.add(url)
            found.append(KbScienceLocation(url=url, kind=kind, open_access=open_access))

    content = data.get("has_content")
    if isinstance(content, Mapping) and content.get("grobid_xml") is True:
        add(tei_url(work_id), "tei", True)
    if arxiv_id:
        add(f"https://arxiv.org/html/{arxiv_id}", "arxiv_html", True)
    for location in data.get("locations") or ():
        if not isinstance(location, Mapping) or location.get("is_oa") is not True:
            continue
        url = location.get("landing_page_url")
        if isinstance(url, str) and not _is_pdf(url) and "arxiv.org/" not in url.lower():
            add(url, "open_page", True)
    primary = data.get("primary_location")
    if isinstance(primary, Mapping):
        url = primary.get("landing_page_url")
        if isinstance(url, str) and not _is_pdf(url) and primary.get("is_oa") is not True:
            add(url, "publisher", False)
    return found


def parse_work(data: Mapping[str, Any]) -> KbScienceWork | None:
    work_id = short_openalex(str(data.get("id") or ""))
    if work_id is None or not is_openalex_work(work_id):
        return None
    doi = normalize_doi(data.get("doi") if isinstance(data.get("doi"), str) else None)
    arxiv_id = _arxiv_of(data, doi)
    locations = locations_of(data, work_id, arxiv_id)
    open_access = mapping(data.get("open_access"))
    is_oa = bool(open_access.get("is_oa")) or any(loc.open_access and loc.kind != "tei" for loc in locations)
    primary = mapping(data.get("primary_location"))
    source = mapping(primary.get("source"))
    publisher_url = next((loc.url for loc in locations if loc.kind == "publisher"), None)
    if publisher_url is None and doi and not is_oa:
        publisher_url = f"https://doi.org/{doi}"
    title = data.get("display_name") or data.get("title") or ""
    authors = [
        str(author["display_name"])
        for item in data.get("authorships") or ()
        if isinstance(item, Mapping)
        and isinstance(author := item.get("author"), Mapping)
        and isinstance(author.get("display_name"), str)
    ]
    topics = [
        tid
        for topic in data.get("topics") or ()
        if isinstance(topic, Mapping)
        and (tid := taxonomy_id(str(topic.get("id") or "")))
        and is_topic_id(tid)
    ]
    referenced = [
        short
        for ref in data.get("referenced_works") or ()
        if isinstance(ref, str) and (short := short_openalex(ref)) and is_openalex_work(short)
    ]
    cited = data.get("cited_by_count")
    return KbScienceWork(
        id=work_id,
        provider="openalex",
        provider_id=work_id,
        doi=doi,
        arxiv_id=arxiv_id,
        title=str(title).strip(),
        authors=authors,
        publication=publication_of(data, f"https://openalex.org/{work_id}"),
        venue=str(source["display_name"]) if isinstance(source.get("display_name"), str) else None,
        publication_type=str(data["type"]) if isinstance(data.get("type"), str) else None,
        abstract=abstract_text(data.get("abstract_inverted_index")),
        topic_ids=topics,
        referenced_ids=referenced,
        cited_by_count=cited if isinstance(cited, int) and cited >= 0 else 0,
        locations=locations,
        access=KbPaidAccess(
            paid=not is_oa,
            alternatives_checked=False,
            free_alternative_ids=[],
            suggestion_shown_at=None,
            recommendation=None,
            publisher_url=publisher_url,
        ),
    )


def parse_list(data: Mapping[str, Any]) -> tuple[list[KbScienceWork], str | None]:
    works = [
        work for item in data.get("results") or () if isinstance(item, Mapping) and (work := parse_work(item))
    ]
    meta = mapping(data.get("meta"))
    cursor = meta.get("next_cursor")
    return works, (str(cursor) if isinstance(cursor, str) and cursor and works else None)


def is_retracted(data: Mapping[str, Any]) -> bool:
    return data.get("is_retracted") is True


def doi_key(data: Mapping[str, Any]) -> str | None:
    raw = data.get("doi")
    return normalize_doi(raw) if isinstance(raw, str) else None


def _clean_topic(text: str) -> str:
    return " ".join(text.replace('"', " ").replace("(", " ").replace(")", " ").split())


def search_request(body: KbScienceSearch, openalex_ids: Sequence[str]) -> tuple[dict[str, str], float]:
    """Query parameters and cost: free-text topics are a search ($0.001), filters only are a list."""
    filters: list[str] = []
    words = [
        clean for topic in body.payload.topics if not is_topic_id(topic) and (clean := _clean_topic(topic))
    ]
    topic_ids = [topic for topic in body.payload.topics if is_topic_id(topic)]
    if topic_ids:
        filters.append("topics.id:" + "|".join(topic_ids))
    if body.payload.dois:
        dois = [
            doi for d in body.payload.dois if (doi := normalize_doi(d)) and "," not in doi and "|" not in doi
        ]
        if dois:
            filters.append("doi:" + "|".join(dois))
    if openalex_ids:
        filters.append("ids.openalex:" + "|".join(openalex_ids))
    if body.dates is not None and body.dates.from_date is not None:
        filters.append(f"from_publication_date:{body.dates.from_date.isoformat()}")
    if body.dates is not None and body.dates.to_date is not None:
        filters.append(f"to_publication_date:{body.dates.to_date.isoformat()}")
    params = {"per-page": str(body.limit), "cursor": body.cursor or "*", "select": WORK_FIELDS}
    if filters:
        params["filter"] = ",".join(filters)
    if words:
        params["search"] = words[0] if len(words) == 1 else " OR ".join(f"({word})" for word in words)
    return params, COST_SEARCH if words else COST_LIST


def list_request(
    filters: Sequence[str], *, limit: int, cursor: str | None, sort: str | None = None
) -> dict[str, str]:
    params = {
        "filter": ",".join(filters),
        "per-page": str(limit),
        "cursor": cursor or "*",
        "select": WORK_FIELDS,
    }
    if sort:
        params["sort"] = sort
    return params


def taxonomy_nodes(data: Mapping[str, Any], parent_id: str | None, level: Any) -> list[TaxonomyNode]:
    children_key = {"domain": "fields", "field": "subfields", "subfield": "topics"}.get(level)
    nodes: list[TaxonomyNode] = []
    for item in data.get("results") or ():
        if not isinstance(item, Mapping):
            continue
        node_id = taxonomy_id(str(item.get("id") or ""))
        name = item.get("display_name")
        if node_id is None or not isinstance(name, str) or not name.strip():
            continue
        children = item.get(children_key) if children_key else None
        nodes.append(
            TaxonomyNode(
                taxonomy_id=node_id,
                parent_id=parent_id,
                level=level,
                name=name.strip(),
                children_total=len(children) if isinstance(children, list) else 0,
            )
        )
    return nodes
