"""Real publication date extraction and N7-5 date-window matching (0.4.0 B5).

Import date (``created_at``, ``fetched_at``) is never a publication date; partial
precision (``year``, ``month``, ``day``, ``unknown``) never invents components.
"""

from __future__ import annotations

import calendar
import json
import re
from collections.abc import Sequence
from datetime import date
from pathlib import Path
from typing import Any, Literal

import lxml.html  # type: ignore[import-untyped]
from lxml import etree

from ..api.schemas_explore_common import KbDateWindow, KbPublicationDate
from ..library.layout import SERVICE_DIR
from ..science.protocols import ScienceRef
from ..sources.duplicates import doi_of
from ..sources.html import decode_html
from ..store.records import MaterialRecord

KbPublicationOrigin = Literal["openalex", "arxiv", "crossref", "page", "unknown"]

UNKNOWN_PUBLICATION = KbPublicationDate(
    year=None,
    date=None,
    month=None,
    precision="unknown",
    origin="unknown",
    evidence_url=None,
)

_ARXIV_URL_RE = re.compile(
    r"(?:^|https?://(?:[\w.-]+\.)?arxiv\.org/(?:abs|pdf|html|e-print)/)"
    r"((?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?/\d{7}))(?:(v\d+))?(?:\.pdf)?(?:$|[?#/\s])",
    re.IGNORECASE,
)
_ARXIV_ID_RE = re.compile(
    r"(?:^|\barXiv:\s*)(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?/\d{7})(v\d+)?\b",
    re.IGNORECASE,
)
_DOI_TEXT_RE = re.compile(
    r"\b(10\.\d{4,9}/[-._;()/:A-Za-z0-9]+)\b",
    re.IGNORECASE,
)
_DAY_RE = re.compile(
    r"^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$"
)
_MONTH_RE = re.compile(r"^(\d{4})[-/](\d{1,2})$")
_YEAR_RE = re.compile(r"^(\d{4})$")
_MONTH_NAMES = {
    "jan": 1,
    "january": 1,
    "feb": 2,
    "february": 2,
    "mar": 3,
    "march": 3,
    "apr": 4,
    "april": 4,
    "may": 5,
    "jun": 6,
    "june": 6,
    "jul": 7,
    "july": 7,
    "aug": 8,
    "august": 8,
    "sep": 9,
    "sept": 9,
    "september": 9,
    "oct": 10,
    "october": 10,
    "nov": 11,
    "november": 11,
    "dec": 12,
    "december": 12,
}
_NAMED_MONTH_YEAR_RE = re.compile(r"^([A-Za-z]+)\s+(\d{4})$")
_NAMED_MDY_RE = re.compile(r"^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$")
_NAMED_DMY_RE = re.compile(r"^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$")

_PUBLICATION_META_KEYS = (
    "article:published_time",
    "og:article:published_time",
    "citation_publication_date",
    "citation_date",
    "prism.publicationdate",
    "publication_date",
    "dc.date.issued",
    "dcterms.issued",
    "dc.date",
    "datepublished",
    "pubdate",
    "publishdate",
    "sailthru.date",
    "parsely-pub-date",
    "date",
)
_DOI_META_KEYS = ("citation_doi", "prism.doi", "dc.identifier", "dc.identifier.doi", "doi")
_ARXIV_META_KEYS = ("citation_arxiv_id",)
#: Explicit publication keys in ``origin`` (never ``created_at`` or ``fetched_at``).
_EXPLICIT_ORIGIN_PUB_KEYS = ("publication_date", "published_at", "published")


def parse_partial_date(
    raw: str | None,
    *,
    origin: KbPublicationOrigin = "page",
    evidence_url: str | None = None,
) -> KbPublicationDate | None:
    """Parse a date string into ``KbPublicationDate`` without inventing month or day."""
    if not raw or not isinstance(raw, str):
        return None
    text = raw.strip()
    if not text:
        return None

    match_day = _DAY_RE.match(text)
    if match_day:
        year, month, day = (
            int(match_day.group(1)),
            int(match_day.group(2)),
            int(match_day.group(3)),
        )
        if 1 <= year <= 9999:
            try:
                parsed = date(year, month, day)
                return KbPublicationDate(
                    year=year,
                    month=month,
                    date=parsed,
                    precision="day",
                    origin=origin,
                    evidence_url=evidence_url,
                )
            except ValueError:
                return None

    match_month = _MONTH_RE.match(text)
    if match_month:
        year, month = int(match_month.group(1)), int(match_month.group(2))
        if 1 <= year <= 9999 and 1 <= month <= 12:
            return KbPublicationDate(
                year=year,
                month=month,
                date=None,
                precision="month",
                origin=origin,
                evidence_url=evidence_url,
            )

    match_year = _YEAR_RE.match(text)
    if match_year:
        year = int(match_year.group(1))
        if 1 <= year <= 9999:
            return KbPublicationDate(
                year=year,
                month=None,
                date=None,
                precision="year",
                origin=origin,
                evidence_url=evidence_url,
            )

    match_mdy = _NAMED_MDY_RE.match(text)
    if match_mdy:
        month_num = _MONTH_NAMES.get(match_mdy.group(1).lower().rstrip("."))
        day, year = int(match_mdy.group(2)), int(match_mdy.group(3))
        if month_num is not None and 1 <= year <= 9999:
            try:
                parsed = date(year, month_num, day)
                return KbPublicationDate(
                    year=year,
                    month=month_num,
                    date=parsed,
                    precision="day",
                    origin=origin,
                    evidence_url=evidence_url,
                )
            except ValueError:
                return None

    match_dmy = _NAMED_DMY_RE.match(text)
    if match_dmy:
        day = int(match_dmy.group(1))
        month_num = _MONTH_NAMES.get(match_dmy.group(2).lower().rstrip("."))
        year = int(match_dmy.group(3))
        if month_num is not None and 1 <= year <= 9999:
            try:
                parsed = date(year, month_num, day)
                return KbPublicationDate(
                    year=year,
                    month=month_num,
                    date=parsed,
                    precision="day",
                    origin=origin,
                    evidence_url=evidence_url,
                )
            except ValueError:
                return None

    match_my = _NAMED_MONTH_YEAR_RE.match(text)
    if match_my:
        month_num = _MONTH_NAMES.get(match_my.group(1).lower().rstrip("."))
        year = int(match_my.group(2))
        if month_num is not None and 1 <= year <= 9999:
            return KbPublicationDate(
                year=year,
                month=month_num,
                date=None,
                precision="month",
                origin=origin,
                evidence_url=evidence_url,
            )

    return None


def _clean_doi(value: str | None) -> str | None:
    if not value or not isinstance(value, str):
        return None
    text = value.strip()
    if text.lower().startswith("doi:"):
        text = text[4:].strip()
    via_url = doi_of(text)
    if via_url:
        return via_url
    match = _DOI_TEXT_RE.search(text)
    if match:
        return match.group(1).rstrip(".,;)/").lower()
    return None


def _extract_arxiv(value: str | None) -> tuple[str, str | None] | None:
    if not value or not isinstance(value, str):
        return None
    text = value.strip()
    url_match = _ARXIV_URL_RE.search(text)
    if url_match:
        arxiv_id = url_match.group(1)
        version = url_match.group(2).lower() if url_match.group(2) else None
        return arxiv_id, version
    id_match = _ARXIV_ID_RE.search(text)
    if id_match:
        arxiv_id = id_match.group(1)
        version = id_match.group(2).lower() if id_match.group(2) else None
        return arxiv_id, version
    return None


def _read_original_html(record: MaterialRecord, library_root: Path | None) -> Any | None:
    if library_root is None:
        return None
    html_path = library_root / record.rel_dir / SERVICE_DIR / "original.html"
    try:
        raw_bytes = html_path.read_bytes()
    except OSError:
        return None
    if not raw_bytes.strip():
        return None
    text = decode_html(raw_bytes, None)
    try:
        return lxml.html.document_fromstring(text)
    except (etree.ParserError, ValueError):
        return None


def extract_science_ref(
    record: MaterialRecord,
    library_root: Path | None,
    fragments_text: Sequence[str] = (),
) -> ScienceRef:
    """Extract DOI and/or arXiv ID (+ version) from a material's origin, saved HTML, or early fragments."""
    origin = record.origin if isinstance(record.origin, dict) else {}
    doi: str | None = _clean_doi(str(origin.get("doi"))) if origin.get("doi") else None
    arxiv_id: str | None = None
    version: str | None = (
        str(origin["version"]) if isinstance(origin.get("version"), str) else None
    )

    if isinstance(origin.get("arxiv_id"), str):
        parsed_arxiv = _extract_arxiv(str(origin["arxiv_id"]))
        if parsed_arxiv:
            arxiv_id, ver = parsed_arxiv
            version = version or ver

    for url_key in ("final_url", "url"):
        raw_url = origin.get(url_key)
        if isinstance(raw_url, str) and raw_url:
            if doi is None:
                doi = doi_of(raw_url) or _clean_doi(raw_url)
            if arxiv_id is None:
                parsed_arxiv = _extract_arxiv(raw_url)
                if parsed_arxiv:
                    arxiv_id, ver = parsed_arxiv
                    version = version or ver

    if doi is None or arxiv_id is None:
        doc = _read_original_html(record, library_root)
        if doc is not None:
            for meta in doc.iter("meta"):
                key = (meta.get("name") or meta.get("property") or meta.get("itemprop") or "").strip().lower()
                content = (meta.get("content") or "").strip()
                if not content:
                    continue
                if doi is None and key in _DOI_META_KEYS:
                    doi = _clean_doi(content)
                if arxiv_id is None and key in _ARXIV_META_KEYS:
                    parsed_arxiv = _extract_arxiv(content)
                    if parsed_arxiv:
                        arxiv_id, ver = parsed_arxiv
                        version = version or ver

    if doi is None or arxiv_id is None:
        for fragment in fragments_text:
            if doi is None:
                doi = _clean_doi(fragment)
            if arxiv_id is None:
                parsed_arxiv = _extract_arxiv(fragment)
                if parsed_arxiv:
                    arxiv_id, ver = parsed_arxiv
                    version = version or ver
            if doi is not None and arxiv_id is not None:
                break

    return ScienceRef(
        material_id=record.id,
        doi=doi,
        arxiv_id=arxiv_id,
        version=version,
    )


def _json_ld_dates(node: Any) -> list[str]:
    found: list[str] = []
    if isinstance(node, dict):
        for key in ("datePublished", "dateCreated"):
            val = node.get(key)
            if isinstance(val, str) and val.strip():
                found.append(val.strip())
        for child in node.values():
            if isinstance(child, (dict, list)):
                found.extend(_json_ld_dates(child))
    elif isinstance(node, list):
        for item in node:
            found.extend(_json_ld_dates(item))
    return found


def extract_local_publication(
    record: MaterialRecord,
    library_root: Path | None,
) -> KbPublicationDate:
    """Extract publication date from explicit origin publication fields or saved HTML page metadata.

    Never uses ``created_at`` or ``fetched_at`` (import timestamps are not publication dates).
    """
    origin = record.origin if isinstance(record.origin, dict) else {}
    evidence_url: str | None = None
    for url_key in ("final_url", "url"):
        val = origin.get(url_key)
        if isinstance(val, str) and val.strip():
            evidence_url = val.strip()
            break

    for pub_key in _EXPLICIT_ORIGIN_PUB_KEYS:
        raw_val = origin.get(pub_key)
        if isinstance(raw_val, str):
            parsed = parse_partial_date(raw_val, origin="page", evidence_url=evidence_url)
            if parsed is not None:
                return parsed

    doc = _read_original_html(record, library_root)
    if doc is None:
        return UNKNOWN_PUBLICATION

    meta_by_key: dict[str, str] = {}
    for element in doc.iter("meta"):
        key = (
            element.get("property")
            or element.get("name")
            or element.get("itemprop")
            or ""
        ).strip().lower()
        content = (element.get("content") or "").strip()
        if key and content and key not in meta_by_key:
            meta_by_key[key] = content

    for key in _PUBLICATION_META_KEYS:
        if key in meta_by_key:
            parsed = parse_partial_date(meta_by_key[key], origin="page", evidence_url=evidence_url)
            if parsed is not None:
                return parsed

    for script in doc.iter("script"):
        stype = (script.get("type") or "").strip().lower()
        if stype == "application/ld+json" and script.text:
            try:
                payload = json.loads(script.text)
            except ValueError:
                continue
            for candidate in _json_ld_dates(payload):
                parsed = parse_partial_date(candidate, origin="page", evidence_url=evidence_url)
                if parsed is not None:
                    return parsed

    for time_el in doc.iter("time"):
        itemprop = (time_el.get("itemprop") or time_el.get("property") or "").strip().lower()
        has_pubdate = time_el.get("pubdate") is not None or itemprop in (
            "datepublished",
            "article:published_time",
        )
        if has_pubdate:
            dt_attr = (time_el.get("datetime") or time_el.text_content() or "").strip()
            parsed = parse_partial_date(dt_attr, origin="page", evidence_url=evidence_url)
            if parsed is not None:
                return parsed

    return UNKNOWN_PUBLICATION


def publication_bounds(pub: KbPublicationDate) -> tuple[date, date] | None:
    """Return the ``(earliest_possible_date, latest_possible_date)`` for a known publication date."""
    if pub.precision == "unknown" or pub.year is None:
        return None
    if pub.precision == "day" and pub.date is not None:
        return pub.date, pub.date
    if pub.precision == "month" and pub.month is not None:
        last_day = calendar.monthrange(pub.year, pub.month)[1]
        return date(pub.year, pub.month, 1), date(pub.year, pub.month, last_day)
    return date(pub.year, 1, 1), date(pub.year, 12, 31)


def publication_in_window(pub: KbPublicationDate, window: KbDateWindow) -> bool:
    """True when ``pub`` is known and provably falls within ``[window.from_date, window.to_date]``."""
    bounds = publication_bounds(pub)
    if bounds is None:
        return False
    low_date, high_date = bounds
    if window.from_date is not None and low_date < window.from_date:
        return False
    return not (window.to_date is not None and high_date > window.to_date)


def publication_sort_key(pub: KbPublicationDate, created_at: str) -> tuple[int, int, int, str]:
    """Key for sorting dated materials newest first."""
    year = pub.year or 0
    month = pub.month if pub.month is not None else (pub.date.month if pub.date is not None else 0)
    day = pub.date.day if pub.date is not None else 0
    return (year, month, day, created_at)
