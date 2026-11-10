"""Crossref: the REST works API (no key). Docs: https://api.crossref.org/swagger-ui/index.html and
https://www.crossref.org/documentation/retrieve-metadata/rest-api/ (``updated-by`` / ``update-to``
carry Crossmark updates: retractions, new versions; ``relation.has-preprint`` names free preprints).
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date
from typing import Any, Literal

from ..api.schemas_explore_common import KbPublicationDate
from ..api.schemas_science import KbPaidAccess, KbScienceLocation, KbScienceSearch, KbScienceWork
from .ids import crossref_work_id, mapping, normalize_doi

API = "https://api.crossref.org"
API_HOST = "api.crossref.org"
_TAGS = re.compile(r"<[^>]+>")
RETRACTING = frozenset({"retraction", "withdrawal", "removal"})
NEW_VERSION = frozenset({"new_version", "new-version", "new_edition", "new-edition"})


@dataclass(frozen=True)
class CrossrefUpdate:
    kind: Literal["retracted", "new_version"]
    notice_doi: str | None
    label: str
    published: KbPublicationDate | None


def work_url(doi: str) -> str:
    return f"{API}/works/{doi}"


def date_of(parts_holder: Any, evidence_url: str | None) -> KbPublicationDate | None:
    if not isinstance(parts_holder, Mapping):
        return None
    parts = parts_holder.get("date-parts")
    if not isinstance(parts, list) or not parts or not isinstance(parts[0], list) or not parts[0]:
        return None
    first = [value for value in parts[0] if isinstance(value, int)]
    if not first or not 1 <= first[0] <= 9999:
        return None
    year = first[0]
    month = first[1] if len(first) > 1 and 1 <= first[1] <= 12 else None
    if month is not None and len(first) > 2:
        try:
            day = date(year, month, first[2])
        except ValueError:
            day = None
        if day is not None:
            return KbPublicationDate(
                year=year,
                date=day,
                month=month,
                precision="day",
                origin="crossref",
                evidence_url=evidence_url,
            )
    if month is not None:
        return KbPublicationDate(
            year=year, date=None, month=month, precision="month", origin="crossref", evidence_url=evidence_url
        )
    return KbPublicationDate(
        year=year, date=None, month=None, precision="year", origin="crossref", evidence_url=evidence_url
    )


def publication_of(message: Mapping[str, Any], doi: str) -> KbPublicationDate | None:
    evidence = f"https://doi.org/{doi}"
    for key in ("published", "issued", "published-print", "published-online"):
        found = date_of(message.get(key), evidence)
        if found is not None:
            return found
    return None


def _first(value: Any) -> str | None:
    if isinstance(value, list) and value and isinstance(value[0], str):
        return value[0].strip() or None
    return value.strip() or None if isinstance(value, str) else None


def parse_work(message: Mapping[str, Any]) -> KbScienceWork | None:
    doi = normalize_doi(message.get("DOI") if isinstance(message.get("DOI"), str) else None)
    if doi is None:
        return None
    authors = []
    for author in message.get("author") or ():
        if isinstance(author, Mapping):
            name = " ".join(str(part) for part in (author.get("given"), author.get("family")) if part)
            if name or author.get("name"):
                authors.append(name or str(author["name"]))
    abstract = message.get("abstract")
    landing = f"https://doi.org/{doi}"
    return KbScienceWork(
        id=crossref_work_id(doi),
        provider="crossref",
        provider_id=doi,
        doi=doi,
        arxiv_id=None,
        title=_first(message.get("title")) or "",
        authors=authors,
        publication=publication_of(message, doi)
        or KbPublicationDate(
            year=None, date=None, month=None, precision="unknown", origin="unknown", evidence_url=None
        ),
        venue=_first(message.get("container-title")),
        publication_type=str(message["type"]) if isinstance(message.get("type"), str) else None,
        abstract=" ".join(_TAGS.sub(" ", abstract).split()) or None if isinstance(abstract, str) else None,
        topic_ids=[],
        referenced_ids=[],
        cited_by_count=int(message.get("is-referenced-by-count") or 0),
        # Crossref does not say whether a work is open: the publisher page is the only location it knows.
        locations=[KbScienceLocation(url=landing, kind="publisher", open_access=False)],
        access=KbPaidAccess(
            paid=False,
            alternatives_checked=False,
            free_alternative_ids=[],
            suggestion_shown_at=None,
            recommendation=None,
            publisher_url=landing,
        ),
    )


def parse_list(data: Mapping[str, Any]) -> tuple[list[KbScienceWork], str | None]:
    message = mapping(data.get("message"))
    works = [
        work
        for item in message.get("items") or ()
        if isinstance(item, Mapping) and (work := parse_work(item))
    ]
    cursor = message.get("next-cursor")
    return works, (str(cursor) if isinstance(cursor, str) and cursor and works else None)


def updates_of(message: Mapping[str, Any]) -> list[CrossrefUpdate]:
    """Crossmark updates naming this work: retractions and new versions (corrections are not N1)."""
    found: list[CrossrefUpdate] = []
    for item in message.get("updated-by") or ():
        if not isinstance(item, Mapping):
            continue
        kind_raw = str(item.get("type") or "").lower()
        notice = normalize_doi(item.get("DOI") if isinstance(item.get("DOI"), str) else None)
        published = date_of(item.get("updated"), f"https://doi.org/{notice}" if notice else None)
        label = str(item.get("label") or kind_raw.replace("_", " ").capitalize() or "Update")
        if kind_raw in RETRACTING:
            found.append(CrossrefUpdate("retracted", notice, label, published))
        elif kind_raw in NEW_VERSION:
            found.append(CrossrefUpdate("new_version", notice, label, published))
    return found


def preprints_of(message: Mapping[str, Any]) -> list[str]:
    relation = mapping(message.get("relation"))
    found: list[str] = []
    for item in relation.get("has-preprint") or ():
        if isinstance(item, Mapping) and str(item.get("id-type") or "").lower() == "doi":
            doi = normalize_doi(str(item.get("id") or ""))
            if doi:
                found.append(doi)
    return found


def _clean(text: str) -> str:
    return " ".join(text.split())


def search_params(body: KbScienceSearch) -> dict[str, str]:
    filters: list[str] = [f"doi:{doi}" for d in body.payload.dois if (doi := normalize_doi(d))]
    if body.dates is not None and body.dates.from_date is not None:
        filters.append(f"from-pub-date:{body.dates.from_date.isoformat()}")
    if body.dates is not None and body.dates.to_date is not None:
        filters.append(f"until-pub-date:{body.dates.to_date.isoformat()}")
    params = {"rows": str(body.limit), "cursor": body.cursor or "*"}
    words = " ".join(clean for topic in body.payload.topics if (clean := _clean(topic)))
    if words:
        params["query.bibliographic"] = words
    if filters:
        params["filter"] = ",".join(filters)
    return params


def doi_filter(dois: Sequence[str]) -> dict[str, str]:
    return {"filter": ",".join(f"doi:{doi}" for doi in dois), "rows": str(len(dois))}
