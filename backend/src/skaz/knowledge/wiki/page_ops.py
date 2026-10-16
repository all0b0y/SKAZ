"""Rename and delete a wiki page from its ⋯ menu (decision B20).

* Rename: the file gets the new name in its folder (name rules as for materials; a taken name
  is refused, never replaced), its title follows, and every ``[[link]]`` to it in the wiki is
  rewritten — by path (``[[Wiki/Concepts/Old|…]]``) or by a hand-typed name (``[[Old]]``); a
  label that was the old name becomes the new one. All under the library write lock, all or
  nothing: a page that changed meanwhile puts everything back.
* Delete: a preview first — which pages link to it and how many links get unlinked (an inline
  link keeps its words, a list item of the code-written navigation goes), how many of the
  user's own notes are on the page (they go with it). Sources are never touched. The deletion
  is all or nothing like the rename.
"""

from __future__ import annotations

import os
import re
import shutil
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from pathlib import Path
from uuid import uuid4

from ..errors import NameTaken, NotFound
from ..library.fsio import fsync_dir, write_atomic
from ..library.layout import STAGING_PATH
from ..library.library import Library
from ..library.names import validate_name
from ..markdown.page import Block, PageDocument, Part, RawText, parse_page, render_page
from ..markdown.text import name_key
from ..service import KnowledgeService
from .graph import GraphIndex
from .pages_io import PageChanging, forget_page, is_user_part, page_path, reindex, user_parts
from .retract import LIST_BLOCKS, _strip_inline, _strip_list

_LINK = re.compile(r"\[\[([^\]|#\n]*)(#[^\]|\n]*)?(?:\|([^\]\n]*))?\]\]")


@dataclass(frozen=True)
class PageRef:
    id: str
    kind: str
    title: str


@dataclass
class _Rewrite:
    ref: PageRef
    path: Path
    original: bytes
    text: str
    links: int = 0
    in_user_text: int = 0


@dataclass
class PageDeletePlan:
    page: PageRef
    path: Path
    original: bytes
    linking: list[_Rewrite] = field(default_factory=list)
    #: The user's own notes / edited statements on the page itself (deleted with it).
    user_notes: int = 0
    #: Materials the page cites: they stay in the library.
    sources: list[tuple[str, str]] = field(default_factory=list)

    @property
    def links_unlinked(self) -> int:
        return sum(item.links for item in self.linking)


class _Target:
    """Which written link targets point at one page: its path, or its bare name when unique."""

    def __init__(self, kb: KnowledgeService, page_id: str) -> None:
        record = kb.page_repo.get(page_id)
        if record is None:
            raise NotFound("Page not found.")
        self.record = record
        self.path = record.rel_path.removesuffix(".md")
        self.name = name_key(Path(record.rel_path).stem)
        with kb.db.read() as connection:
            rows = connection.execute("SELECT id, title, rel_path FROM pages").fetchall()
        self._paths = {row["rel_path"].removesuffix(".md") for row in rows}
        self._unique = sum(1 for row in rows if name_key(row["title"]) == self.name) == 1

    def matches(self, written: str) -> bool:
        target = written.strip()
        if target == self.path:
            return True
        if target in self._paths:
            return False  # another page's own path
        return self._unique and name_key(target.rsplit("/", 1)[-1]) == self.name


def _linking_pages(kb: KnowledgeService, graph: GraphIndex, page_id: str) -> list[str]:
    edges = graph.edges()
    return sorted({edge.source for edge in edges if edge.target == page_id and edge.source != page_id})


def _read(
    library: Library, kb: KnowledgeService, page_id: str
) -> tuple[PageRef, Path, bytes, PageDocument] | None:
    record = kb.page_repo.get(page_id)
    if record is None:
        return None
    path = library.root / record.rel_path
    try:
        original = path.read_bytes()
        document = parse_page(original.decode("utf-8"))
    except (OSError, UnicodeDecodeError, ValueError):
        return None
    return PageRef(record.id, record.kind, record.title), path, original, document


def _rewrite_text(text: str, change: Callable[[re.Match[str]], str | None]) -> tuple[str, int]:
    count = 0

    def sub(match: re.Match[str]) -> str:
        nonlocal count
        replaced = change(match)
        if replaced is None:
            return match.group(0)
        count += 1
        return replaced

    return _LINK.sub(sub, text), count


def _map_parts(
    document: PageDocument, *, agent: Callable[[Block], Block | None], user: Callable[[str], tuple[str, int]]
) -> tuple[PageDocument, int, int]:
    """Apply ``agent`` to the agent's untouched blocks and ``user`` to the user's words."""
    parts: list[Part] = []
    changed = in_user = 0
    for part in document.parts:
        if isinstance(part, Block) and not is_user_part(part):
            updated = agent(part)
            if updated is not part:
                changed += 1
            if updated is not None:
                parts.append(updated)
        elif isinstance(part, Block):
            body, count = user(part.body)
            if count:
                changed += count
                in_user += count
                # Never re-marked: a block edited outside SKAZ stays the user's (its hash keeps saying so).
                part = replace(part, body=body, raw=None)
            parts.append(part)
        elif isinstance(part, RawText):
            text, count = user(part.text)
            changed += count
            in_user += count
            parts.append(RawText(text) if count else part)
        else:
            parts.append(part)
    return replace(document, parts=parts), changed, in_user


# -- rename ---------------------------------------------------------------------------------------


def rename_page(kb: KnowledgeService, graph: GraphIndex, page_id: str, title: str) -> Path:
    """Rename the page and rewrite every link to it; returns the new path. Caller holds the write lock."""
    clean = validate_name(title)
    target = _Target(kb, page_id)
    library, path = page_path(kb, page_id)
    new_path = path.with_name(f"{clean}.md")
    old_stem = path.stem
    if new_path.name == path.name:
        return path
    if name_key(new_path.name) != name_key(path.name) and new_path.exists():
        raise NameTaken("A page with this name already exists here. Choose another name.")
    new_link = f"{Path(target.path).parent.as_posix()}/{clean}"

    def relink(match: re.Match[str]) -> str | None:
        written, anchor, label = match.group(1), match.group(2) or "", match.group(3)
        if not target.matches(written):
            return None
        where = new_link if "/" in written.strip() else clean
        if label is None:
            return f"[[{where}{anchor}]]"
        shown = clean if name_key(label.strip()) == name_key(old_stem) else label
        return f"[[{where}{anchor}|{shown}]]"

    def agent_block(block: Block) -> Block:
        body, count = _rewrite_text(block.body, relink)
        return replace(block, body=body, raw=None).remarked() if count else block

    plans: list[_Rewrite] = []
    for other in _linking_pages(kb, graph, page_id):
        read = _read(library, kb, other)
        if read is None:
            continue
        ref, other_path, original, document = read
        updated, count, in_user = _map_parts(
            document, agent=agent_block, user=lambda text: _rewrite_text(text, relink)
        )
        if count:
            plans.append(_Rewrite(ref, other_path, original, render_page(updated), count, in_user))
    original = path.read_bytes()
    own, _count, _user = _map_parts(
        parse_page(original.decode("utf-8")), agent=agent_block, user=lambda text: _rewrite_text(text, relink)
    )
    own = replace(own, meta=replace(own.meta, title=clean))
    own_text = render_page(own)

    renamed = library.rename_page(path, clean)
    done: list[_Rewrite] = []
    try:
        if not library.rewrite_page(renamed, original, own_text):
            raise PageChanging(
                f"“{old_stem}” changed while it was being renamed. Nothing was renamed; retry."
            )
        for plan in plans:
            if not library.rewrite_page(plan.path, plan.original, plan.text):
                raise PageChanging(f"“{plan.ref.title}” changed while links to the page were being updated. "
                                   "Nothing was renamed; retry.")
            done.append(plan)
    except BaseException:
        for plan in done:
            write_atomic(plan.path, plan.original)
        write_atomic(renamed, original)
        os.rename(renamed, path)
        fsync_dir(path.parent)
        raise
    reindex(kb, library, renamed)
    for plan in plans:
        reindex(kb, library, plan.path)
    return renamed


# -- delete ---------------------------------------------------------------------------------------


def plan_page_delete(kb: KnowledgeService, graph: GraphIndex, page_id: str) -> PageDeletePlan:
    target = _Target(kb, page_id)
    library, path = page_path(kb, page_id)
    original = path.read_bytes()
    document = parse_page(original.decode("utf-8"))
    plan = PageDeletePlan(PageRef(target.record.id, target.record.kind, target.record.title), path, original,
                          user_notes=user_parts(document))
    for material_id in target.record.sources:
        material = kb.material_repo.get(material_id)
        if material is not None:
            plan.sources.append((material.id, material.title))

    def unlink_user(text: str) -> tuple[str, int]:
        # The user's words keep their text: the link becomes its label (or the page name).
        return _rewrite_text(text, lambda m: (m.group(3) or m.group(1).strip().rsplit("/", 1)[-1])
                             if target.matches(m.group(1)) else None)

    for other in _linking_pages(kb, graph, page_id):
        read = _read(library, kb, other)
        if read is None:
            continue
        ref, other_path, other_original, other_document = read
        counted = 0

        def unlink_agent(block: Block) -> Block | None:
            nonlocal counted
            written = {m.group(1).strip() for m in _LINK.finditer(block.body) if target.matches(m.group(1))}
            if not written:
                return block
            counted += sum(1 for m in _LINK.finditer(block.body) if target.matches(m.group(1)))
            strip = _strip_list if block.id in LIST_BLOCKS else _strip_inline
            body = strip(block.body, written)
            if not body.strip():
                return None  # a navigation list that only pointed here goes
            return Block.create(block.id, block.kind, body, cites=block.cites, owner="agent")

        updated, _changed, in_user = _map_parts(other_document, agent=unlink_agent, user=unlink_user)
        links = counted + in_user
        if links:
            rewritten = render_page(updated)
            plan.linking.append(_Rewrite(ref, other_path, other_original, rewritten, links, in_user))
    return plan


def execute_page_delete(kb: KnowledgeService, plan: PageDeletePlan) -> None:
    """Carry the plan out: the page moves aside, linking pages are rewritten, any failure puts all back."""
    library = kb.require()
    area = library.root / STAGING_PATH / f"delete-page-{uuid4().hex}"
    area.mkdir(parents=True)
    aside = area / "page.md"
    moved = False
    done: list[_Rewrite] = []
    try:
        if plan.path.read_bytes() != plan.original:
            raise PageChanging(
                f"“{plan.page.title}” changed since the preview. Nothing was deleted; look again."
            )
        os.rename(plan.path, aside)
        moved = True
        for item in plan.linking:
            if not library.rewrite_page(item.path, item.original, item.text):
                raise PageChanging(
                    f"“{item.ref.title}” changed since the preview. Nothing was deleted; look again."
                )
            done.append(item)
    except BaseException:
        for item in done:
            write_atomic(item.path, item.original)
        if moved:
            os.rename(aside, plan.path)
        shutil.rmtree(area, ignore_errors=True)
        raise
    fsync_dir(plan.path.parent)
    shutil.rmtree(area, ignore_errors=True)
    forget_page(kb.db, plan.page.id)
    with kb.db.write() as connection:
        connection.execute("DELETE FROM wiki_discrepancies WHERE page_id = ?", (plan.page.id,))
    for item in plan.linking:
        reindex(kb, library, item.path)
