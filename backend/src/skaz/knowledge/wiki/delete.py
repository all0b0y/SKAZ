"""Deleting a material with a preview of what happens to the wiki (decision 7, API-B2 §2.3).

The preview and the deletion are one plan: statements resting only on the
material go, statements other sources confirm stay without its citation, a
page left without any source goes unless the user wrote something on it, and
the user's notes are never touched. The deletion is all-or-nothing as far as
the file system allows: the material folder and removed pages are first moved
aside (one rename each), changed pages are replaced only if unchanged since
they were planned, and any failure puts everything back.
"""

from __future__ import annotations

import os
import shutil
from dataclasses import dataclass, field, replace
from pathlib import Path
from uuid import uuid4

from ..errors import KnowledgeError, NotFound
from ..ids import utc_now
from ..index.scanner import read_page
from ..library.fsio import fsync_dir, write_atomic
from ..library.layout import STAGING_PATH
from ..library.library import Library
from ..markdown.page import PageDocument, PageFormatError, parse_page, render_page
from ..service import KnowledgeService
from .graph import NAV_IDS, GraphIndex
from .nav import refresh_concept_nav
from .pages_io import PageChanging, forget_material, forget_page, is_user_part, reindex, user_parts
from .retract import retract_material, strip_links

LOG_DELETED = {"en": "Material deleted", "ru": "Материал удалён"}
LOG_GONE = {"en": "Material removed outside SKAZ", "ru": "Материал удалён вне SKAZ"}
LOG_PAGE_DELETED = {"en": "Page deleted", "ru": "Страница удалена"}
LOG_PAGE_RENAMED = {"en": "Page renamed", "ru": "Страница переименована"}


class StillRecording(KnowledgeError):
    status_code = 409

    def __init__(self) -> None:
        super().__init__("This material is still being recorded. Stop the recording first.")


class MaterialBusy(KnowledgeError):
    status_code = 409


@dataclass(frozen=True)
class PageRefView:
    id: str
    kind: str
    title: str


@dataclass
class PagePlan:
    ref: PageRefView
    path: Path
    original: bytes
    #: ``None``: the page goes.
    text: str | None
    removed: list[str]
    kept: list[str]
    user_parts: int


@dataclass
class DeletePlan:
    material_id: str
    title: str
    rel_dir: str
    pages: list[PagePlan] = field(default_factory=list)
    connections_removed: int = 0
    #: The material folder is already gone (removed outside SKAZ, QA C21): only the wiki is cleaned.
    folder_gone: bool = False

    @property
    def claims_removed(self) -> int:
        return sum(len(page.removed) for page in self.pages)

    @property
    def claims_kept(self) -> int:
        return sum(len(page.kept) for page in self.pages)

    @property
    def pages_changed(self) -> list[PageRefView]:
        return [page.ref for page in self.pages if page.text is not None]

    @property
    def pages_removed(self) -> list[PageRefView]:
        return [page.ref for page in self.pages if page.text is None]

    @property
    def user_notes_kept(self) -> int:
        return sum(page.user_parts for page in self.pages)


def _affected_pages(kb: KnowledgeService, material_id: str) -> list[str]:
    with kb.db.read() as connection:
        rows = connection.execute(
            "SELECT page_id FROM page_sources WHERE material_id = ? UNION "
            "SELECT DISTINCT page_id FROM citations WHERE material_id = ?",
            (material_id, material_id),
        ).fetchall()
    return sorted({row[0] for row in rows})


def _explanations_of(kb: KnowledgeService, page_id: str, removed: set[str]) -> set[str]:
    """Disagreement notes whose side is being removed go with it."""
    with kb.db.read() as connection:
        rows = connection.execute(
            "SELECT block_a, block_b, explanation_id FROM wiki_discrepancies WHERE page_id = ?",
            (page_id,),
        ).fetchall()
    return {
        row["explanation_id"]
        for row in rows
        if row["explanation_id"] and (row["block_a"] in removed or row["block_b"] in removed)
    }


def _plan_page(
    kb: KnowledgeService,
    library: Library,
    page_id: str,
    material_id: str,
    rel_dir: str,
    gone_links: frozenset[str] = frozenset(),
) -> PagePlan | None:
    record = kb.page_repo.get(page_id)
    if record is None:
        return None
    path = library.root / record.rel_path
    try:
        read_page(library, path)  # an edit made outside SKAZ makes that block the user's first
        original = path.read_bytes()
        document = parse_page(original.decode("utf-8"))
    except (OSError, PageFormatError, UnicodeDecodeError):
        return None
    updated, retraction = retract_material(document, material_id, rel_dir)
    extra = _explanations_of(kb, page_id, set(retraction.removed))
    if extra:
        updated, retraction = retract_material(document, material_id, rel_dir, also=extra)
    # Links to the pages that go with the material (its Notes, concepts left without a source).
    updated, _unlinked = strip_links(updated, gone_links)
    if updated.meta.kind == "concept":
        updated = refresh_concept_nav(kb, updated, exclude={material_id})
    else:
        sources = tuple(source for source in updated.meta.sources if source != material_id)
        updated = replace(updated, meta=replace(updated.meta, sources=sources))
        if not sources:
            updated = _without_agent_nav(updated)
    kept_user = user_parts(updated)
    removed_page = not updated.meta.sources and kept_user == 0
    text = None if removed_page else render_page(updated)
    if text is not None and text.encode("utf-8") == original:
        return None
    ref = PageRefView(record.id, record.kind, record.title)
    return PagePlan(ref, path, original, text, retraction.removed, retraction.kept, kept_user)


def _without_agent_nav(document: PageDocument) -> PageDocument:
    parts = [
        part
        for part in document.parts
        if not (getattr(part, "id", None) in NAV_IDS and not is_user_part(part))
    ]
    return replace(document, parts=parts)


def plan_delete(kb: KnowledgeService, graph: GraphIndex, material_id: str) -> DeletePlan:
    record = kb.material_repo.get(material_id)
    if record is None:
        raise NotFound("Material not found.")
    return plan_cleanup(kb, graph, material_id, record.title, record.rel_dir)


def plan_cleanup(
    kb: KnowledgeService, graph: GraphIndex, material_id: str, title: str, rel_dir: str, *,
    folder_gone: bool = False,
) -> DeletePlan:
    """The delete plan by id, title and folder — also for a material whose folder is already gone."""
    library = kb.require()
    plan = DeletePlan(material_id, title, rel_dir, folder_gone=folder_gone)
    affected = _affected_pages(kb, material_id)
    first: dict[str, PagePlan] = {}
    for page_id in affected:
        page = _plan_page(kb, library, page_id, material_id, rel_dir)
        if page is not None:
            first[page_id] = page
    gone_pages = {page_id for page_id, page in first.items() if page.text is None}
    # Second pass (QA C18): every page that links to a page that goes loses those links too —
    # "Materials in order" of the folder overview, "Related", agent connections.
    gone_links = frozenset(
        rel.removesuffix(".md")
        for rel in (getattr(kb.page_repo.get(page_id), "rel_path", None) for page_id in gone_pages)
        if rel
    )
    linking = {edge.source for edge in graph.edges() if edge.target in gone_pages} - gone_pages
    for page_id in sorted(set(affected) | linking):
        if page_id in gone_pages:
            plan.pages.append(first[page_id])
            continue
        page = _plan_page(kb, library, page_id, material_id, rel_dir, gone_links)
        if page is not None:
            plan.pages.append(page)
    gone_blocks = {(page.ref.id, block) for page in plan.pages for block in page.removed}
    plan.connections_removed = sum(
        1
        for edge in graph.edges()
        if edge.source in gone_pages
        or edge.target in gone_pages
        or (edge.page_id, edge.block_id) in gone_blocks
    )
    return plan


def execute_delete(kb: KnowledgeService, plan: DeletePlan) -> None:
    """Carry the plan out; on any failure nothing is left half done (files are put back)."""
    library = kb.require()
    directory = library.root / plan.rel_dir
    if plan.folder_gone:
        if directory.exists():
            raise PageChanging("The material's folder is back in the library. Nothing was cleaned up.")
    elif not directory.is_dir():
        raise NotFound("The material's folder is missing. Rescan the library.")
    area = library.root / STAGING_PATH / f"delete-{uuid4().hex}"
    area.mkdir(parents=True)
    moved: list[tuple[Path, Path]] = []
    rewritten: list[PagePlan] = []
    try:
        if not plan.folder_gone:
            aside = area / "material"
            os.rename(directory, aside)
            moved.append((directory, aside))
            fsync_dir(directory.parent)
        for number, page in enumerate(plan.pages):
            if page.text is None:
                if page.path.read_bytes() != page.original:
                    raise PageChanging(
                        f"“{page.ref.title}” changed while the material was being deleted. "
                        "Nothing was deleted; retry."
                    )
                target = area / f"page-{number}.md"
                os.rename(page.path, target)
                moved.append((page.path, target))
            else:
                if not library.rewrite_page(page.path, page.original, page.text):
                    raise PageChanging(
                        f"“{page.ref.title}” changed while the material was being deleted. "
                        "Nothing was deleted; retry."
                    )
                rewritten.append(page)
    except BaseException:
        for page in rewritten:
            write_atomic(page.path, page.original)
        for origin, aside in reversed(moved):
            os.rename(aside, origin)
        shutil.rmtree(area, ignore_errors=True)
        raise
    shutil.rmtree(area, ignore_errors=True)
    forget_material(kb.db, plan.material_id)
    for page in plan.pages:
        if page.text is None:
            forget_page(kb.db, page.ref.id)
        else:
            reindex(kb, library, page.path)
    with kb.db.write() as connection:
        connection.execute(
            "DELETE FROM wiki_discrepancies WHERE block_a LIKE ? OR block_b LIKE ?",
            (f"c-{plan.material_id.removeprefix('mat-')}-%",) * 2,
        )
        # C1-a: concept pages left with fewer statements wait for the next connection run (after any
        # ingest, the background run or "Find connections"); their old checks no longer match anyway.
        now = utc_now()
        connection.executemany(
            "INSERT OR IGNORE INTO wiki_connection_pending(page_id, added_at) VALUES (?, ?)",
            [(page.ref.id, now) for page in plan.pages
             if page.text is not None and page.ref.kind == "concept"],
        )


def append_page_log(library: Library, language: str, title: str, *, renamed: bool = False) -> None:
    """A line in ``Wiki/log.md`` for a page the user deleted or renamed (B20)."""
    labels = LOG_PAGE_RENAMED if renamed else LOG_PAGE_DELETED
    _append(library, labels.get(language, labels["en"]), title)


def append_log(library: Library, language: str, title: str, *, outside: bool = False) -> None:
    labels = LOG_GONE if outside else LOG_DELETED
    _append(library, labels.get(language, labels["en"]), title)


def _append(library: Library, label: str, title: str) -> None:
    stamp = utc_now().replace("T", " ").removesuffix("Z")[:16] + " UTC"
    path = library.wiki_dir / "log.md"
    try:
        current = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        current = "# Log\n"
    if not current.endswith("\n"):
        current += "\n"
    if current.rstrip("\n").splitlines()[-1:] and current.rstrip("\n").splitlines()[-1].startswith("#"):
        current = current.rstrip("\n") + "\n\n"
    write_atomic(path, (current + f"- {stamp} — {label}: {title}\n").encode("utf-8"))
