"""Exact duplicates before ingest (N2 decision 2(1)): the same DOI, address or file already in the library.

A duplicate is found by code before anything is stored or sent to an agent, so a second add
neither makes a second material nor starts ingest (no budget spent): the add answers with the
material that is already there ("This is already in your library · Open it").

What counts as the same (deliberately conservative — a near-miss is a new material, never a
wrong "you have this"):

* **Address** (``url_key``): scheme and host compared case-insensitively, a default port, a
  ``#fragment`` and one trailing ``/`` of the path ignored; the query is kept, the scheme is kept
  (``http`` and ``https`` stay different pages).
* **DOI** (``doi_of``): a ``doi.org`` link or a publisher path ``…/doi/[abs|full|pdf/]10.…``;
  DOIs are case-insensitive. There is no separate DOI import: a DOI arrives as a link.
* **Content** (``content_hash``): SHA-256 of the file's bytes (or of a fetched PDF/page), kept in
  the material's origin (``origin.sha256``) from now on. Materials added before that are compared
  through the original kept in their ``.skaz/`` folder — only when its size is the same, so no
  other file is read.
"""

from __future__ import annotations

import hashlib
import re
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Literal
from urllib.parse import unquote, urlsplit, urlunsplit

from ..library.layout import SERVICE_DIR
from ..service import KnowledgeService
from ..store.records import MaterialRecord

DuplicateReason = Literal["doi", "url", "content"]
_ORDER: tuple[DuplicateReason, ...] = ("doi", "url", "content")
_DOI_HOSTS = frozenset({"doi.org", "dx.doi.org", "www.doi.org"})
_DOI = re.compile(r"^(10\.\d{4,9}/\S+)$")
_PUBLISHER_DOI = re.compile(r"/doi/(?:abs/|full/|pdf/|epdf/)?(10\.\d{4,9}/[^?#\s]+)", re.IGNORECASE)
_CHUNK = 1 << 20


@dataclass(frozen=True)
class Duplicate:
    material_id: str
    title: str
    reason: DuplicateReason


def url_key(url: str | None) -> str | None:
    """The address compared for \"the same link\" (see the module note); ``None`` when it isn't one."""
    if not url:
        return None
    try:
        parts = urlsplit(url.strip())
        port = parts.port
    except ValueError:
        return None
    scheme = parts.scheme.lower()
    host = (parts.hostname or "").lower().rstrip(".")
    if scheme not in ("http", "https") or not host:
        return None
    if ":" in host:
        host = f"[{host}]"
    if port is not None and (scheme, port) not in (("http", 80), ("https", 443)):
        host = f"{host}:{port}"
    path = parts.path or "/"
    if len(path) > 1 and path.endswith("/"):
        path = path[:-1]
    return urlunsplit((scheme, host, path, parts.query, ""))


def doi_of(url: str | None) -> str | None:
    """The DOI a link names (lower case), else ``None``."""
    if not url:
        return None
    try:
        parts = urlsplit(url.strip())
    except ValueError:
        return None
    host = (parts.hostname or "").lower().rstrip(".")
    path = unquote(parts.path)
    found: str | None = None
    if host in _DOI_HOSTS:
        match = _DOI.match(path.lstrip("/"))
        found = match.group(1) if match else None
    else:
        match = _PUBLISHER_DOI.search(path)
        found = match.group(1) if match else None
    return found.rstrip("/").lower() if found else None


def content_hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def file_digest(path: Path) -> str:
    """SHA-256 of a file read in chunks (a long recording is never held in memory)."""
    return _file_hash(path)


def _file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(_CHUNK):
            digest.update(chunk)
    return digest.hexdigest()


def _origin_urls(record: MaterialRecord) -> list[str]:
    origin = record.origin or {}
    return [str(value) for value in (origin.get("url"), origin.get("final_url")) if value]


def _original_matches(kb: KnowledgeService, record: MaterialRecord, digest: str, size: int) -> bool:
    """A material from before ``origin.sha256``: its kept original, read only when the size matches."""
    try:
        directory = kb.require().root / record.rel_dir / SERVICE_DIR
        for path in directory.glob("original.*"):
            if path.is_file() and path.stat().st_size == size and _file_hash(path) == digest:
                return True
    except OSError:
        return False
    return False


def find_duplicate(kb: KnowledgeService, *, urls: Iterable[str | None] = (),
                   content: bytes | None = None, digest: str | None = None) -> Duplicate | None:
    """The material already in the library with the same DOI, address or content, if any.

    The whole library is searched (one library, whatever the folder). A DOI match wins over an
    address match, an address match over a content match. ``digest``: the content's SHA-256 when
    the caller hashed a large file itself (speech imports); then only stored hashes are compared.
    """
    wanted = [url for url in urls if url]
    dois = {doi for doi in map(doi_of, wanted) if doi}
    keys = {key for key in map(url_key, wanted) if key}
    if content is not None:
        digest = content_hash(content)
    records = kb.materials()
    by_reason: dict[DuplicateReason, MaterialRecord] = {}
    unhashed: list[MaterialRecord] = []
    for record in records:
        theirs = _origin_urls(record)
        if dois and dois & {doi for doi in map(doi_of, theirs) if doi}:
            by_reason.setdefault("doi", record)
        if keys and keys & {key for key in map(url_key, theirs) if key}:
            by_reason.setdefault("url", record)
        if digest is not None:
            stored = (record.origin or {}).get("sha256")
            if stored == digest:
                by_reason.setdefault("content", record)
            elif stored is None and (record.origin or {}).get("type") in ("file", "url"):
                unhashed.append(record)
    for reason in _ORDER:
        found = by_reason.get(reason)
        if found is not None:
            return Duplicate(found.id, found.title, reason)
    if digest is not None and content is not None:
        for record in unhashed:
            if _original_matches(kb, record, digest, len(content)):
                return Duplicate(record.id, record.title, "content")
    return None
