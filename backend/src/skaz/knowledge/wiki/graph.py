"""Graph edges (table ``edges``) and the graph view (decision 5, API-B2 §2.5).

Edges are derived from the page index — every wikilink from one page to
another is a ``link``; a link inside an agent ``connection`` statement (not the
code-written navigation blocks) is a ``connection``. The table is rebuilt from
the blocks whenever the set of indexed page files changed (cheap check by the
pages' file hashes), so it is always reproducible from the library files.
"""

from __future__ import annotations

import hashlib
import re
import threading
from collections import defaultdict
from dataclasses import dataclass

from ..ingest.pages import NAV_CONCEPTS_ID, NAV_FOLDERS_ID, NAV_RELATED_ID
from ..markdown.text import name_key
from ..store.database import KnowledgeDatabase

_WIKILINK = re.compile(r"\[\[([^\]|#\n]*)(?:#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\]")
NAV_IDS = frozenset({NAV_CONCEPTS_ID, NAV_FOLDERS_ID, NAV_RELATED_ID})
#: A node is a hub (labelled at rest) from this degree on, or when among the best-connected tenth.
HUB_DEGREE = 6
MIN_HUB_DEGREE = 3


@dataclass(frozen=True)
class Edge:
    source: str
    target: str
    kind: str
    page_id: str | None
    block_id: str | None


@dataclass(frozen=True)
class Node:
    id: str
    kind: str
    title: str
    folder_ids: tuple[str, ...]
    degree: int
    hub: bool


@dataclass(frozen=True)
class Graph:
    nodes: list[Node]
    edges: list[tuple[Edge, bool]]


def link_targets(text: str) -> list[str]:
    """Wikilink targets in a block (paths without ``.md`` or bare names), in order."""
    return [match.group(1).strip() for match in _WIKILINK.finditer(text) if match.group(1).strip()]


class GraphIndex:
    def __init__(self, db: KnowledgeDatabase) -> None:
        self.db = db
        self._signature: str | None = None
        self._lock = threading.Lock()
        #: (the connection's change counter, the signature computed at it).
        self._computed: tuple[int, str] | None = None

    def signature(self) -> str:
        """Changes whenever any indexed page file changes.

        The background tick asks every 2 s: the pages are hashed again only after the index
        changed at all (the database connection's change counter), not on every tick.
        """
        with self.db.read() as connection:
            counter = connection.total_changes
            if self._computed is not None and self._computed[0] == counter:
                return self._computed[1]
            digest = hashlib.sha256()
            for row in connection.execute("SELECT id, file_sha256 FROM pages ORDER BY id"):
                digest.update(f"{row[0]}:{row[1]};".encode())
            self._computed = (counter, digest.hexdigest())
            return self._computed[1]

    def refresh(self, *, force: bool = False) -> bool:
        """Rebuild ``edges`` when pages changed; returns whether it was rebuilt."""
        with self._lock:
            signature = self.signature()
            if not force and signature == self._signature:
                return False
            edges = self._derive()
            with self.db.write_rebuildable() as connection:
                connection.execute("DELETE FROM edges")
                connection.executemany(
                    "INSERT OR IGNORE INTO edges(src_kind, src_id, dst_kind, dst_id, kind, page_id, "
                    "block_id) VALUES ('page', ?, 'page', ?, ?, ?, ?)",
                    [(edge.source, edge.target, edge.kind, edge.page_id, edge.block_id) for edge in edges],
                )
            self._signature = signature
            return True

    def _derive(self) -> list[Edge]:
        with self.db.read() as connection:
            pages = connection.execute("SELECT id, title, rel_path FROM pages").fetchall()
            blocks = connection.execute(
                "SELECT page_id, block_id, kind, owner, text FROM blocks ORDER BY page_id, ordinal"
            ).fetchall()
        by_path = {row["rel_path"].removesuffix(".md"): row["id"] for row in pages}
        titles: dict[str, list[str]] = defaultdict(list)
        for row in pages:
            titles[name_key(row["title"])].append(row["id"])
        edges: dict[tuple[str, str, str], Edge] = {}
        for row in blocks:
            source = row["page_id"]
            agent_link = row["kind"] == "connection" and row["block_id"] not in NAV_IDS
            kind = "connection" if agent_link else "link"
            for target in link_targets(row["text"]):
                page_id = by_path.get(target)
                if page_id is None:
                    named = titles.get(name_key(target.rsplit("/", 1)[-1]), [])
                    page_id = named[0] if len(named) == 1 else None
                if page_id is None or page_id == source:
                    continue
                key = (source, page_id, kind)
                if key not in edges:
                    edges[key] = Edge(source, page_id, kind, source, row["block_id"])
        return list(edges.values())

    def edges(self) -> list[Edge]:
        self.refresh()
        with self.db.read() as connection:
            rows = connection.execute(
                "SELECT src_id, dst_id, kind, page_id, block_id FROM edges WHERE src_kind = 'page' "
                "AND dst_kind = 'page' ORDER BY src_id, dst_id, kind"
            ).fetchall()
        return [Edge(row[0], row[1], row[2], row[3], row[4]) for row in rows]

    def graph(self, folder_id: str | None = None) -> Graph:
        edges = self.edges()
        with self.db.read() as connection:
            pages = connection.execute(
                # Decks and tests are study material, not knowledge pages: not in the graph (0.3.1 S).
                "SELECT id, kind, title FROM pages WHERE kind NOT IN ('deck', 'test') "
                "ORDER BY title COLLATE NOCASE"
            ).fetchall()
            folders: dict[str, list[str]] = defaultdict(list)
            for row in connection.execute("SELECT page_id, folder_id FROM page_folders ORDER BY rowid"):
                folders[row[0]].append(row[1])
        included = {row["id"] for row in pages if folder_id is None or folder_id in folders[row["id"]]}
        kept = [edge for edge in edges if edge.source in included and edge.target in included]
        degree: dict[str, set[str]] = defaultdict(set)
        for edge in kept:
            degree[edge.source].add(edge.target)
            degree[edge.target].add(edge.source)
        degrees = sorted((len(neighbours) for neighbours in degree.values()), reverse=True)
        top = degrees[max(len(degrees) // 10 - 1, 0)] if degrees else 0
        nodes = []
        for row in pages:
            if row["id"] not in included:
                continue
            count = len(degree[row["id"]])
            hub = count >= HUB_DEGREE or (count >= MIN_HUB_DEGREE and count >= top)
            nodes.append(Node(row["id"], row["kind"], row["title"], tuple(folders[row["id"]]), count, hub))
        return Graph(
            nodes, [(edge, not set(folders[edge.source]) & set(folders[edge.target])) for edge in kept]
        )

    def neighbours(self, page_id: str) -> tuple[list[str], list[str]]:
        """(related, mentioned_in): pages it links/connects to; pages linking here that aren't related."""
        related: dict[str, None] = {}
        mentioned: dict[str, None] = {}
        for edge in self.edges():
            if edge.source == page_id:
                related.setdefault(edge.target, None)
            elif edge.target == page_id:
                if edge.kind == "connection":
                    related.setdefault(edge.source, None)
                else:
                    mentioned.setdefault(edge.source, None)
        return list(related), [item for item in mentioned if item not in related]

    def connected(self, page_id: str, other: str) -> bool:
        return any(
            edge.kind == "connection" and {edge.source, edge.target} == {page_id, other}
            for edge in self.edges()
        )
