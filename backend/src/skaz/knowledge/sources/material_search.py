"""⌘K over materials and the per-section counts (API-B2 §1.2).

Materials are found by title: every word of the query must occur in the
title (case- and NFC-insensitive), shown with the matches marked. The counts
are totals per ⌘K section, not the length of the returned lists:

* ``wiki`` — pages whose title/alias or text matches;
* ``materials`` — materials whose title or text matches;
* ``chats`` — chats whose title or messages contain every word (the chat list
  itself is ``GET /kb/chats?q=``, area C1).
"""
from __future__ import annotations

import re
import sqlite3
import unicodedata
from dataclasses import dataclass

from ..index.search import SnippetPart, fts_query
from ..markdown.text import name_key
from ..store.database import KnowledgeDatabase

_TOKEN = re.compile(r"\w+")
MAX_TOKENS = 12
#: Counting stops here (the UI shows "1000+"-like totals as plain numbers).
COUNT_CAP = 1000


@dataclass(frozen=True)
class MaterialHit:
    id: str
    title: str
    kind: str
    folder_id: str
    folder_name: str
    created_at: str
    snippet: tuple[SnippetPart, ...]


@dataclass(frozen=True)
class SearchCounts:
    wiki: int
    materials: int
    chats: int


def tokens(query: str) -> list[str]:
    return [name_key(token) for token in _TOKEN.findall(unicodedata.normalize("NFC", query))[:MAX_TOKENS]]


def title_snippet(title: str, words: list[str]) -> tuple[SnippetPart, ...]:
    """The title split into parts, with every occurrence of a query word marked."""
    folded = name_key(title)
    if len(folded) != len(title):  # casefold changed the length (e.g. "ß"): no safe offsets
        return (SnippetPart(title, False),)
    marked = [False] * len(title)
    for word in words:
        for match in re.finditer(re.escape(word), folded):
            for index in range(match.start(), match.end()):
                marked[index] = True
    parts: list[SnippetPart] = []
    start = 0
    for index in range(1, len(title) + 1):
        if index == len(title) or marked[index] != marked[start]:
            parts.append(SnippetPart(title[start:index], marked[start]))
            start = index
    return tuple(parts)


def _title_matches(title: str, words: list[str]) -> bool:
    folded = name_key(title)
    return all(word in folded for word in words)


def search_materials(db: KnowledgeDatabase, query: str, *, limit: int) -> tuple[list[MaterialHit], set[str]]:
    """Up to ``limit`` title hits (newest first) and the ids of *all* materials whose title matches."""
    words = tokens(query)
    if not words:
        return [], set()
    with db.read() as connection:
        rows = connection.execute(
            "SELECT m.id, m.title, m.kind, m.folder_id, m.created_at, f.name AS folder_name "
            "FROM materials m JOIN folders f ON f.id = m.folder_id ORDER BY m.created_at DESC, m.rowid DESC"
        ).fetchall()
    matched = [row for row in rows if _title_matches(row["title"], words)]
    hits = [MaterialHit(row["id"], row["title"], row["kind"], row["folder_id"], row["folder_name"],
                        row["created_at"], title_snippet(row["title"], words)) for row in matched[:limit]]
    return hits, {row["id"] for row in matched}


def _distinct(connection: sqlite3.Connection, sql: str, parameters: tuple[object, ...]) -> set[str]:
    try:
        return {row[0] for row in connection.execute(sql, parameters)}
    except sqlite3.OperationalError:
        return set()


def _page_titles(connection: sqlite3.Connection, query: str) -> set[str]:
    """Pages whose title or alias contains the query (the rule of the index search's page hits)."""
    key = name_key(query.strip())
    if not key:
        return set()
    found = {row["id"] for row in connection.execute("SELECT id, title FROM pages")
             if key in name_key(row["title"])}
    found |= {row["page_id"] for row in connection.execute("SELECT page_id, alias_key FROM aliases")
              if key in row["alias_key"]}
    return found


def counts(db: KnowledgeDatabase, query: str, *, material_titles: set[str]) -> SearchCounts:
    """Totals per ⌘K section. ``material_titles``: materials already found by title."""
    words = tokens(query)
    expression = fts_query(query)
    if not words or expression is None:
        return SearchCounts(0, 0, 0)
    with db.read() as connection:
        page_ids = _page_titles(connection, query)
        fragment_materials = _distinct(
            connection, "SELECT DISTINCT material_id FROM fragments_fts WHERE fragments_fts MATCH ? LIMIT ?",
            (expression, COUNT_CAP))
        block_pages = _distinct(
            connection, "SELECT DISTINCT page_id FROM blocks_fts WHERE blocks_fts MATCH ? LIMIT ?",
            (expression, COUNT_CAP))
        chats = _chat_count(connection, words)
    return SearchCounts(
        wiki=min(COUNT_CAP, len(page_ids | block_pages)),
        materials=min(COUNT_CAP, len(material_titles | fragment_materials)),
        chats=chats,
    )


def _chat_count(connection: sqlite3.Connection, words: list[str]) -> int:
    """Chats whose title or messages contain every word (case-folded, compared in Python)."""
    found = 0
    try:  # the chats tables belong to area C1 and may not exist (yet) in this library
        for chat in connection.execute("SELECT id, title FROM chats").fetchall():
            if _title_matches(chat["title"], words):
                found += 1
            else:
                texts = [name_key(row[0] or "") for row in connection.execute(
                    "SELECT content FROM messages WHERE chat_id = ?", (chat["id"],))]
                if all(any(word in text for text in texts) for word in words):
                    found += 1
            if found >= COUNT_CAP:
                break
    except sqlite3.OperationalError:
        return found
    return found
