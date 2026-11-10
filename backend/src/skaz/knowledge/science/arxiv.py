"""arXiv: the Atom API (no key). Docs: https://info.arxiv.org/help/api/user-manual.html

The API asks for no more than one request every three seconds; ``transport`` paces arXiv requests.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime

from lxml import etree  # type: ignore[import-untyped]

from ..api.schemas_explore_common import KbPublicationDate
from ..api.schemas_science import KbPaidAccess, KbScienceLocation, KbScienceSearch, KbScienceWork
from .ids import arxiv_work_id, normalize_doi, split_arxiv

API = "https://export.arxiv.org/api/query"
API_HOST = "export.arxiv.org"
HTML_HOST = "arxiv.org"
_ATOM = "{http://www.w3.org/2005/Atom}"
_ARXIV = "{http://arxiv.org/schemas/atom}"
_OPENSEARCH = "{http://a9.com/-/spec/opensearch/1.1/}"


@dataclass(frozen=True)
class ArxivEntry:
    work: KbScienceWork
    #: The newest version the API knows ("v3").
    latest_version: str | None
    updated: date | None


def _parser() -> etree.XMLParser:
    return etree.XMLParser(resolve_entities=False, no_network=True, huge_tree=False, load_dtd=False)


def _text(node: etree._Element | None) -> str:
    return " ".join("".join(node.itertext()).split()) if node is not None else ""


def _day(value: str) -> date | None:
    try:
        return datetime.fromisoformat(value.strip().replace("Z", "+00:00")).date()
    except ValueError:
        return None


def abs_url(arxiv_id: str, version: str | None = None) -> str:
    return f"https://arxiv.org/abs/{arxiv_id}{version or ''}"


def parse_feed(body: bytes) -> tuple[list[ArxivEntry], int]:
    """Entries and ``totalResults``. A malformed feed is a provider failure for the caller."""
    root = etree.fromstring(body, parser=_parser())
    entries: list[ArxivEntry] = []
    for entry in root.iter(f"{_ATOM}entry"):
        found = split_arxiv(_text(entry.find(f"{_ATOM}id")))
        if found is None:
            continue  # the API's error answer is an entry without an arXiv id
        arxiv_id, version = found
        published = _day(_text(entry.find(f"{_ATOM}published")))
        updated = _day(_text(entry.find(f"{_ATOM}updated")))
        doi = normalize_doi(_text(entry.find(f"{_ARXIV}doi")))
        category = entry.find(f"{_ARXIV}primary_category")
        journal = _text(entry.find(f"{_ARXIV}journal_ref")) or None
        publication = (
            KbPublicationDate(
                year=published.year,
                date=published,
                month=published.month,
                precision="day",
                origin="arxiv",
                evidence_url=abs_url(arxiv_id, "v1"),
            )
            if published is not None
            else KbPublicationDate(
                year=None, date=None, month=None, precision="unknown", origin="unknown", evidence_url=None
            )
        )
        work = KbScienceWork(
            id=arxiv_work_id(arxiv_id),
            provider="arxiv",
            provider_id=arxiv_id,
            doi=doi,
            arxiv_id=arxiv_id,
            title=_text(entry.find(f"{_ATOM}title")),
            authors=[
                name
                for author in entry.iter(f"{_ATOM}author")
                if (name := _text(author.find(f"{_ATOM}name")))
            ],
            publication=publication,
            venue=journal or (f"arXiv {category.get('term')}" if category is not None else "arXiv"),
            publication_type="preprint",
            abstract=_text(entry.find(f"{_ATOM}summary")) or None,
            topic_ids=[],
            referenced_ids=[],
            cited_by_count=0,
            locations=[
                KbScienceLocation(
                    url=f"https://arxiv.org/html/{arxiv_id}", kind="arxiv_html", open_access=True
                )
            ],
            access=KbPaidAccess(
                paid=False,
                alternatives_checked=False,
                free_alternative_ids=[],
                suggestion_shown_at=None,
                recommendation=None,
                publisher_url=None,
            ),
        )
        entries.append(ArxivEntry(work, version, updated))
    total_node = root.find(f"{_OPENSEARCH}totalResults")
    total = int(_text(total_node)) if total_node is not None and _text(total_node).isdigit() else len(entries)
    return entries, total


def _clean(text: str) -> str:
    return " ".join(text.replace('"', " ").replace("(", " ").replace(")", " ").split())


def search_params(body: KbScienceSearch, arxiv_ids: Sequence[str]) -> dict[str, str]:
    parts = [f'all:"{clean}"' for topic in body.payload.topics if (clean := _clean(topic))]
    query = " OR ".join(parts)
    if body.dates is not None and (body.dates.from_date or body.dates.to_date):
        start = body.dates.from_date.strftime("%Y%m%d") + "0000" if body.dates.from_date else "199101010000"
        end = body.dates.to_date.strftime("%Y%m%d") + "2359" if body.dates.to_date else "299912312359"
        window = f"submittedDate:[{start} TO {end}]"
        query = f"({query}) AND {window}" if query else window
    offset = int(body.cursor) if body.cursor and body.cursor.isdigit() else 0
    params = {
        "start": str(offset),
        "max_results": str(body.limit),
        "sortBy": "submittedDate",
        "sortOrder": "descending",
    }
    if query:
        params["search_query"] = query
    if arxiv_ids:
        params["id_list"] = ",".join(arxiv_ids)
    return params


def id_params(arxiv_ids: Sequence[str]) -> dict[str, str]:
    return {"id_list": ",".join(arxiv_ids), "max_results": str(len(arxiv_ids))}
