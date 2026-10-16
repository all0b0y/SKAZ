"""What the wikilinks of a page's blocks point at (QA C1/C2): another page, a material, or nothing.

The page shows block text without the raw ``[[…]]``; a link the reader can follow needs the
target resolved the same way the graph does it (``graph.GraphIndex._derive``): by the path
inside the library, then — for a link typed by hand — by a page title that is unique.
Material links (``[[Materials/<Folder>/<Title>/<File>|…]]``) resolve to the material whose
folder holds that file. Citation links (``#^seg-N``) are not listed: the citations are the
block's footnotes.
"""

from __future__ import annotations

import re
import sqlite3
from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass

from ..markdown.text import name_key
from ..store.database import KnowledgeDatabase

_LINK = re.compile(r"\[\[([^\]|#\n]*)(#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\]")


@dataclass(frozen=True)
class LinkView:
    #: The link target as written (path without ``.md``, no ``#anchor``, no label).
    target: str
    page_id: str | None = None
    page_kind: str | None = None
    page_title: str | None = None
    material_id: str | None = None


def block_link_targets(text: str) -> list[str]:
    """Distinct non-citation link targets of a block, in order."""
    found: dict[str, None] = {}
    for match in _LINK.finditer(text):
        target, anchor = match.group(1).strip(), match.group(2) or ""
        if target and not anchor.startswith("#^seg-"):
            found.setdefault(target, None)
    return list(found)


class LinkResolver:
    def __init__(self, db: KnowledgeDatabase) -> None:
        with db.read() as connection:
            pages = connection.execute("SELECT id, kind, title, rel_path FROM pages").fetchall()
            materials = connection.execute("SELECT id, rel_dir FROM materials").fetchall()
        self._by_path = {row["rel_path"].removesuffix(".md"): row for row in pages}
        titles: dict[str, list[sqlite3.Row]] = defaultdict(list)
        for row in pages:
            titles[name_key(row["title"])].append(row)
        self._by_title = {key: rows[0] for key, rows in titles.items() if len(rows) == 1}
        self._materials = {name_key(row["rel_dir"]): row["id"] for row in materials}

    def resolve(self, target: str) -> LinkView:
        page = self._by_path.get(target)
        if page is None and target.startswith("Materials/"):
            folder = target.rsplit("/", 1)[0]
            material = self._materials.get(name_key(folder)) or self._materials.get(name_key(target))
            return LinkView(target, material_id=material)
        if page is None:
            page = self._by_title.get(name_key(target.rsplit("/", 1)[-1]))
        if page is None:
            return LinkView(target)
        return LinkView(target, page_id=page["id"], page_kind=page["kind"], page_title=page["title"])

    def links(self, text: str) -> list[LinkView]:
        return [self.resolve(target) for target in block_link_targets(text)]

    def for_blocks(self, items: Iterable[tuple[str, str]]) -> dict[str, list[LinkView]]:
        """``{block_id: links}`` for ``(block_id, text)`` pairs; blocks without links are left out."""
        out: dict[str, list[LinkView]] = {}
        for block_id, text in items:
            found = self.links(text)
            if found:
                out[block_id] = found
        return out
