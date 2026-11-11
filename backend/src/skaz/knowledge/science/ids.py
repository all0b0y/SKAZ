"""Identifiers the science bases use, and SKAZ's own work ids built from them.

A ``KbScienceWork.id`` must match ``^[a-zA-Z0-9_-]+$``:

* OpenAlex works keep their id (``W2741809807``);
* arXiv works are ``arxiv-`` + the id with ``.`` → ``_`` and ``/`` → ``--`` (``arxiv-2401_01234``);
* Crossref-only works are ``doi-`` + a hash of the DOI (the DOI itself is ``provider_id``).

Taxonomy ids follow OpenAlex: ``domains-3``, ``fields-17``, ``subfields-1702``, topics ``T10181`` — the
same topic ids a work's ``topic_ids`` carry, so B4 can place a work by its topics.
"""

from __future__ import annotations

import hashlib
import re
from collections.abc import Mapping
from typing import Any, Literal

OPENALEX_PREFIX = "https://openalex.org/"
_OPENALEX_WORK = re.compile(r"^W\d{1,12}$")
_TOPIC = re.compile(r"^T\d{1,9}$")
_LEVEL_ID = re.compile(r"^(domains|fields|subfields)-(\d{1,9})$")
_DOI = re.compile(r"^10\.\d{4,9}/\S+$")
#: New-style ``2401.01234`` and old-style ``hep-th/9901001`` arXiv ids, with an optional version.
_ARXIV = re.compile(r"^(\d{4}\.\d{4,5}|[a-z][a-z.-]*(?:\.[A-Z]{2})?/\d{7})(v\d+)?$", re.IGNORECASE)
_ARXIV_URL = re.compile(r"arxiv\.org/(?:abs|pdf|html)/([^?#\s]+?)(?:\.pdf)?/?$", re.IGNORECASE)
_ARXIV_DOI = re.compile(r"^10\.48550/arxiv\.(.+)$", re.IGNORECASE)

TaxonomyLevel = Literal["domain", "field", "subfield", "topic"]
CHILD_LEVEL: dict[str, tuple[str, TaxonomyLevel]] = {
    "domains": ("fields", "field"),
    "fields": ("subfields", "subfield"),
    "subfields": ("topics", "topic"),
}
#: The OpenAlex filter naming a child's parent (``/fields?filter=domain.id:3``).
PARENT_FILTER = {"domains": "domain.id", "fields": "field.id", "subfields": "subfield.id"}


#: A work's place in the hierarchy (help.openalex.org/data/topics): any of its topics under this node.
WORK_SCOPE_FILTER = {
    "domains": "topics.domain.id",
    "fields": "topics.field.id",
    "subfields": "topics.subfield.id",
}


def scope_filter(value: str) -> tuple[str, str] | None:
    """A taxonomy id as the works filter that covers it: ``fields-17`` → ``("topics.field.id", "17")``,
    ``T10181`` → ``("topics.id", "T10181")``; ``None`` for anything else (free text)."""
    if is_topic_id(value):
        return "topics.id", value
    match = _LEVEL_ID.match(value)
    if match is None:
        return None
    return WORK_SCOPE_FILTER[match.group(1)], match.group(2)


def short_openalex(value: str | None) -> str | None:
    """``https://openalex.org/W1`` → ``W1``; ``None`` for anything else."""
    if not value:
        return None
    return value.removeprefix(OPENALEX_PREFIX).strip() or None


def is_openalex_work(value: str) -> bool:
    return bool(_OPENALEX_WORK.match(value))


def is_topic_id(value: str) -> bool:
    return bool(_TOPIC.match(value))


def normalize_doi(value: str | None) -> str | None:
    """A bare lower-case DOI (``10.1234/x``) from a DOI, a ``doi:`` or a ``doi.org`` link."""
    if not value:
        return None
    text = value.strip()
    for prefix in (
        "https://doi.org/",
        "http://doi.org/",
        "https://dx.doi.org/",
        "http://dx.doi.org/",
        "doi:",
    ):
        if text.lower().startswith(prefix):
            text = text[len(prefix) :]
            break
    text = text.strip().lower()
    return text if _DOI.match(text) else None


def split_arxiv(value: str | None) -> tuple[str, str | None] | None:
    """``(id, version)`` from an arXiv id, ``arxiv:`` id, arXiv link or arXiv DOI; ``None`` otherwise."""
    if not value:
        return None
    text = value.strip()
    if text.lower().startswith("arxiv:"):
        text = text[6:]
    if (doi := _ARXIV_DOI.match(normalize_doi(text) or "")) is not None:
        text = doi.group(1)
    elif (url := _ARXIV_URL.search(text)) is not None:
        text = url.group(1)
    match = _ARXIV.match(text)
    if match is None:
        return None
    return match.group(1), (match.group(2).lower() if match.group(2) else None)


def arxiv_work_id(arxiv_id: str) -> str:
    return "arxiv-" + arxiv_id.replace("/", "--").replace(".", "_")


def arxiv_of_work_id(work_id: str) -> str | None:
    if not work_id.startswith("arxiv-"):
        return None
    return work_id[6:].replace("--", "/").replace("_", ".")


def crossref_work_id(doi: str) -> str:
    return "doi-" + hashlib.sha256(doi.lower().encode()).hexdigest()[:24]


def taxonomy_id(value: str) -> str | None:
    """``https://openalex.org/fields/17`` → ``fields-17``; a topic → ``T10181``."""
    short = short_openalex(value)
    if short is None:
        return None
    if is_topic_id(short):
        return short
    if short.startswith("topics/"):
        rest = short.split("/", 1)[1]
        return rest if is_topic_id(rest) else None
    kind, _, number = short.partition("/")
    if kind in PARENT_FILTER and number.isdigit():
        return f"{kind}-{number}"
    return None


def parent_query(parent_id: str) -> tuple[str, str, TaxonomyLevel] | None:
    """For a parent node: the endpoint of its children, the filter naming it, and the children's level."""
    match = _LEVEL_ID.match(parent_id)
    if match is None:
        return None
    kind, number = match.group(1), match.group(2)
    endpoint, level = CHILD_LEVEL[kind]
    return endpoint, f"{PARENT_FILTER[kind]}:{number}", level


def mapping(value: Any) -> Mapping[str, Any]:
    """``value`` when it is a JSON object, else an empty one (provider answers are untrusted shapes)."""
    return value if isinstance(value, Mapping) else {}
