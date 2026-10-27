"""FTS5 search over fragments and blocks (``unicode61 remove_diacritics 2``), plus titles/aliases.

User input is never passed to FTS5 as query syntax: it is split into word
tokens, each quoted and prefix-matched, all required. Snippets come back as
parts (``text``, ``match``) so a client never has to render HTML.
"""
from __future__ import annotations

import logging
import re
import sqlite3
import unicodedata
from collections.abc import Collection
from dataclasses import dataclass

from ..logsafe import error_note
from ..markdown.text import name_key
from ..store.database import KnowledgeDatabase

logger = logging.getLogger(__name__)

_TOKEN = re.compile(r"\w+")
_OPEN, _CLOSE = "\x02", "\x03"
MAX_TOKENS = 12


@dataclass(frozen=True)
class SnippetPart:
    text: str
    match: bool


@dataclass(frozen=True)
class FragmentHit:
    material_id: str
    material_title: str
    material_kind: str
    seg: int
    start_ms: int | None
    page: int | None
    snippet: tuple[SnippetPart, ...]


@dataclass(frozen=True)
class BlockHit:
    page_id: str
    page_title: str
    page_kind: str
    block_id: str
    kind: str
    owner: str
    snippet: tuple[SnippetPart, ...]


@dataclass(frozen=True)
class PageHit:
    id: str
    title: str
    kind: str
    matched_alias: str | None


@dataclass(frozen=True)
class SearchResults:
    query: str
    fragments: tuple[FragmentHit, ...] = ()
    blocks: tuple[BlockHit, ...] = ()
    pages: tuple[PageHit, ...] = ()
    #: The full-text index failed (locked or damaged): the results are not "nothing found".
    degraded: bool = False


def fts_query(query: str) -> str | None:
    tokens = _TOKEN.findall(unicodedata.normalize("NFC", query))[:MAX_TOKENS]
    if not tokens:
        return None
    return " ".join(f'"{token}"*' for token in tokens)


def snippet_parts(marked: str) -> tuple[SnippetPart, ...]:
    parts: list[SnippetPart] = []
    for index, piece in enumerate(re.split(f"[{_OPEN}{_CLOSE}]", marked)):
        if piece:
            parts.append(SnippetPart(piece, match=index % 2 == 1))
    return tuple(parts)


def _id_filter(column: str, only: Collection[str] | None, excluded: Collection[str]) -> tuple[str, list[str]]:
    """``AND`` clauses keeping ``column`` inside ``only`` (``None``: any) and outside ``excluded``."""
    sql, params = "", []
    if only is not None:
        sql += f" AND {column} IN ({','.join('?' for _ in only) or 'NULL'})"
        params += list(only)
    if excluded:
        sql += f" AND {column} NOT IN ({','.join('?' for _ in excluded)})"
        params += list(excluded)
    return sql, params


def search(db: KnowledgeDatabase, query: str, *, limit: int = 20, only: Collection[str] | None = None,
           excluded: Collection[str] = ()) -> SearchResults:
    """``only`` / ``excluded``: material and page ids a chat's sources allow (N7-4), applied before the
    ranking cut so a chosen source outside the library's top hits is still found (Q1 n78 M-1)."""
    expression = fts_query(query)
    if expression is None:
        return SearchResults(query=query)
    fragment_sql, fragment_params = _id_filter("fragments_fts.material_id", only, excluded)
    block_sql, block_params = _id_filter("blocks_fts.page_id", only, excluded)
    with db.read() as connection:
        try:
            fragment_rows = connection.execute(
                "SELECT fragments_fts.material_id AS material_id, fragments_fts.seg AS seg, "
                f"snippet(fragments_fts, 0, '{_OPEN}', '{_CLOSE}', '…', 24) AS marked, "
                "m.title AS title, m.kind AS kind, x.start_ms AS start_ms, x.page AS page "
                "FROM fragments_fts JOIN materials m ON m.id = fragments_fts.material_id "
                "JOIN fragments x ON x.material_id = fragments_fts.material_id AND x.seg = fragments_fts.seg "
                f"WHERE fragments_fts MATCH ?{fragment_sql} ORDER BY rank LIMIT ?",
                (expression, *fragment_params, limit),
            ).fetchall()
            block_rows = connection.execute(
                "SELECT blocks_fts.page_id AS page_id, blocks_fts.block_id AS block_id, "
                f"snippet(blocks_fts, 0, '{_OPEN}', '{_CLOSE}', '…', 24) AS marked, "
                "p.title AS title, p.kind AS page_kind, b.kind AS kind, b.owner AS owner "
                "FROM blocks_fts JOIN pages p ON p.id = blocks_fts.page_id "
                "JOIN blocks b ON b.page_id = blocks_fts.page_id AND b.block_id = blocks_fts.block_id "
                f"WHERE blocks_fts MATCH ?{block_sql} ORDER BY rank LIMIT ?",
                (expression, *block_params, limit),
            ).fetchall()
        except sqlite3.OperationalError as error:
            # L1: a broken or busy index used to look exactly like "no matches", with no trace.
            logger.warning("Full-text search failed: %s", error_note(error))
            return SearchResults(query=query, degraded=True)
        pages = _pages(connection, query, limit, only, excluded)
    return SearchResults(
        query=query,
        fragments=tuple(
            FragmentHit(row["material_id"], row["title"], row["kind"], int(row["seg"]), row["start_ms"],
                        row["page"], snippet_parts(row["marked"]))
            for row in fragment_rows
        ),
        blocks=tuple(
            BlockHit(row["page_id"], row["title"], row["page_kind"], row["block_id"], row["kind"],
                     row["owner"], snippet_parts(row["marked"]))
            for row in block_rows
        ),
        pages=pages,
    )


def _pages(connection: sqlite3.Connection, query: str, limit: int, only: Collection[str] | None = None,
           excluded: Collection[str] = ()) -> tuple[PageHit, ...]:
    key = name_key(query.strip())
    if not key:
        return ()
    hits: dict[str, PageHit] = {}
    for row in connection.execute("SELECT id, title, kind FROM pages ORDER BY title COLLATE NOCASE"):
        if key in name_key(row["title"]):
            hits[row["id"]] = PageHit(row["id"], row["title"], row["kind"], None)
    for row in connection.execute(
        "SELECT p.id, p.title, p.kind, a.alias, a.alias_key FROM aliases a JOIN pages p ON p.id = a.page_id"
    ):
        if key in row["alias_key"] and row["id"] not in hits:
            hits[row["id"]] = PageHit(row["id"], row["title"], row["kind"], row["alias"])
    kept = [hit for page_id, hit in hits.items()
            if page_id not in excluded and (only is None or page_id in only)]
    return tuple(kept[:limit])
