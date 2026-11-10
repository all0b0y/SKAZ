"""A library material as the science bases know it: its DOI, arXiv id and — only from its link — version.

User decision (B6): a new arXiv version is looked for only when the material's own link names the
version the user has (``arxiv.org/abs/2401.01234v2``). An id without a version says nothing about which
version the copy is, so no "v3 is out" is claimed for it. Nothing else about the material leaves SKAZ.
"""

from __future__ import annotations

import re
from collections.abc import Iterator

from ..science.protocols import ScienceRef
from ..sources.duplicates import doi_of
from ..store.records import MaterialRecord

#: ``arxiv.org/{abs,pdf,html}/<id>[vN][.pdf]``: new-style (2401.01234) and old-style (hep-th/9901001) ids.
_ARXIV_LINK = re.compile(
    r"^https?://(?:www\.|export\.)?arxiv\.org/(?P<kind>abs|pdf|html)/"
    r"(?P<id>\d{4}\.\d{4,5}|[a-z][a-z.-]*(?:\.[A-Z]{2})?/\d{7})(?P<version>v\d+)?(?P<tail>(?:\.pdf)?/?)$",
    re.IGNORECASE,
)
_ARXIV_ID = re.compile(
    r"^(?:arxiv:)?(\d{4}\.\d{4,5}|[a-z][a-z.-]*(?:\.[A-Z]{2})?/\d{7})(?:v\d+)?$", re.IGNORECASE
)
_DOI = re.compile(r"^10\.\d{4,9}/\S+$")


def _links(record: MaterialRecord) -> Iterator[str]:
    origin = record.origin or {}
    for key in ("url", "final_url"):
        value = origin.get(key)
        if isinstance(value, str) and value.strip():
            yield value.strip()


def science_ref(record: MaterialRecord) -> ScienceRef | None:
    """``None`` when the material names neither a DOI nor an arXiv id (recordings, lectures, web pages)."""
    origin = record.origin or {}
    doi: str | None = None
    raw_doi = origin.get("doi")
    if isinstance(raw_doi, str) and _DOI.match(raw_doi.strip()):
        doi = raw_doi.strip().lower()
    arxiv_id: str | None = None
    version: str | None = None
    for link in _links(record):
        doi = doi or doi_of(link)
        match = _ARXIV_LINK.match(link)
        if match is not None and arxiv_id is None:
            arxiv_id = match.group("id")
            version = match.group("version").lower() if match.group("version") else None
    raw_arxiv = origin.get("arxiv_id")
    if arxiv_id is None and isinstance(raw_arxiv, str):
        found = _ARXIV_ID.match(raw_arxiv.strip())
        arxiv_id = found.group(1) if found else None  # an id alone: no version is claimed
    if doi is None and arxiv_id is None:
        return None
    return ScienceRef(material_id=record.id, doi=doi, arxiv_id=arxiv_id, version=version)


def versioned_link(record: MaterialRecord, version: str) -> str | None:
    """The material's own arXiv link with ``version`` in place of the one it names; ``None`` without one.

    "Replace with vN" adds exactly what the user added before (the abstract page, the PDF or the HTML
    paper), only newer, through the same link intake.
    """
    if not re.fullmatch(r"v\d+", version):
        return None
    for link in _links(record):
        match = _ARXIV_LINK.match(link)
        if match is not None and match.group("version"):
            return f"https://arxiv.org/{match.group('kind').lower()}/{match.group('id')}{version}{match.group('tail')}"
    return None
