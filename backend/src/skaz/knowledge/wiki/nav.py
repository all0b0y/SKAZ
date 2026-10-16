"""Code-written navigation of concept pages ("In folders"), shared by delete and move.

Same format as ingest (W1 ``WikiWriter``): folders derived from the page's
sources, each with links to its materials.
"""

from __future__ import annotations

from collections.abc import Collection, Sequence
from dataclasses import replace

from ..ingest.pages import NAV_FOLDERS_ID, set_nav, spaced
from ..markdown.page import PageDocument, PageMeta
from ..service import KnowledgeService


def folders_of(
    kb: KnowledgeService, sources: Sequence[str], *, exclude: Collection[str] = ()
) -> tuple[str, ...]:
    folders: dict[str, None] = {}
    for material_id in sources:
        record = kb.material_repo.get(material_id) if material_id not in exclude else None
        if record is not None:
            folders.setdefault(record.folder_id, None)
    return tuple(folders)


def folders_body(kb: KnowledgeService, meta: PageMeta, *, exclude: Collection[str] = ()) -> str | None:
    by_folder: dict[str, list[str]] = {}
    for material_id in meta.sources:
        record = kb.material_repo.get(material_id) if material_id not in exclude else None
        if record is None:
            continue
        by_folder.setdefault(record.folder_id, []).append(
            f"[[{record.source_file.removesuffix('.md')}|{record.title}]]"
        )
    lines = []
    for folder_id, links in by_folder.items():
        folder = kb.folder_repo.get(folder_id)
        lines.append(f"{folder.name if folder else folder_id}: {', '.join(links)}")
    return "; ".join(lines) if lines else None


def refresh_concept_nav(
    kb: KnowledgeService, document: PageDocument, *, exclude: Collection[str] = ()
) -> PageDocument:
    """Sources without ``exclude``, folders from the sources, and the "In folders" block."""
    meta = document.meta
    sources = tuple(source for source in meta.sources if source not in exclude)
    meta = replace(meta, sources=sources, folders=folders_of(kb, sources, exclude=exclude))
    parts = list(document.parts)
    set_nav(parts, NAV_FOLDERS_ID, "folders", meta.language or "en", folders_body(kb, meta, exclude=exclude))
    return replace(document, meta=meta, parts=spaced(parts))
