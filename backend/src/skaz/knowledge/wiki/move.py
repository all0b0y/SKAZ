"""Renaming and moving a material (API-B2 §1.3, FILESYSTEM-LIBRARY-SPEC 14–15, 34).

The files move first (``Library.move_material``: all or nothing). Then every
page that cites the material gets its wikilinks rebuilt *by id*: a citation's
marker names ``material id : seg``, so each link to one of those fragments is
re-rendered from the material's current folder/title — the marker is the
truth, the link only its presentation. Concept pages also refresh their
"In folders" navigation, and the material's Notes page follows the new title
when that name is free.
"""

from __future__ import annotations

import re
from dataclasses import replace

from ..errors import KnowledgeError, NameRejected, NameTaken, NotFound
from ..index import indexer
from ..index.scanner import ScannedMaterial
from ..ingest.pages import SourceRef
from ..library.library import Library, MaterialFiles
from ..markdown.page import Block, PageDocument, Part, RawText
from ..service import KnowledgeService
from .nav import refresh_concept_nav
from .pages_io import forget_page, reindex, rewrite

_SOURCE_LINK = re.compile(r"\[\[(Materials/[^\]|#\n]*)#\^seg-(\d+)\|[^\]\n]*\]\]")
_MATERIAL_LINK = re.compile(r"\[\[(Materials/[^\]|#\n]*)\|([^\]\n]*)\]\]")


class MaterialRecording(KnowledgeError):
    status_code = 409

    def __init__(self) -> None:
        super().__init__(
            "This material is still being recorded. Stop the recording before renaming or moving it."
        )


def source_ref(library: Library, files: MaterialFiles) -> SourceRef:
    return SourceRef(
        material_id=files.manifest.id,
        folder_name=files.directory.parent.name,
        title=files.title,
        file_stem=files.source_path.stem,
        start_ms={fragment.seg: fragment.start_ms for fragment in files.fragments},
        page={fragment.seg: fragment.page for fragment in files.fragments},
    )


def relink_body(
    body: str, ref: SourceRef, segs: set[int], old_target: str | None, *, only_material: bool
) -> str:
    """Re-render links to this material's fragments (and plain links to the material) from ``ref``."""
    new_target = f"Materials/{ref.folder_name}/{ref.title}/{ref.file_stem}"

    def fragment_link(match: re.Match[str]) -> str:
        seg = int(match.group(2))
        if seg in segs and (only_material or match.group(1) == old_target):
            return ref.link(seg)
        return match.group(0)

    def material_link(match: re.Match[str]) -> str:
        if old_target is not None and match.group(1) == old_target:
            return f"[[{new_target}|{ref.title}]]"
        return match.group(0)

    return _MATERIAL_LINK.sub(material_link, _SOURCE_LINK.sub(fragment_link, body))


def relink_document(document: PageDocument, ref: SourceRef, old_target: str | None) -> PageDocument:
    parts: list[Part] = []
    for part in document.parts:
        if isinstance(part, Block):
            segs = {cite.seg for cite in part.cites if cite.material_id == ref.material_id}
            only = bool(segs) and all(cite.material_id == ref.material_id for cite in part.cites)
            body = relink_body(part.body, ref, segs, old_target, only_material=only)
            if body != part.body:
                part = replace(part, body=body, raw=None).remarked()
        elif isinstance(part, RawText) and old_target is not None:
            text = relink_body(part.text, ref, set(), old_target, only_material=False)
            if text != part.text:
                part = RawText(text)
        parts.append(part)
    return replace(document, parts=parts)


def _pages_of(kb: KnowledgeService, material_id: str) -> list[str]:
    with kb.db.read() as connection:
        rows = connection.execute(
            "SELECT page_id FROM page_sources WHERE material_id = ? UNION "
            "SELECT DISTINCT page_id FROM citations WHERE material_id = ?",
            (material_id, material_id),
        ).fetchall()
    return sorted({row[0] for row in rows})


def move_material(
    kb: KnowledgeService, material_id: str, *, title: str | None, folder_id: str | None
) -> list[str]:
    """Rename/move; returns the journal (plain words) of what could not follow."""
    record = kb.material_repo.get(material_id)
    if record is None:
        raise NotFound("Material not found.")
    if record.status == "recording":
        raise MaterialRecording()
    library = kb.require()
    old_files = library.read_material(material_id, hint=record.rel_dir)
    old_target = library.relative(old_files.source_path).removesuffix(".md")
    files = library.move_material(material_id, title=title, folder_id=folder_id, hint=record.rel_dir)
    indexer.put_material(
        kb.db, ScannedMaterial(files, library.relative(files.directory), library.relative(files.source_path))
    )
    new_target = library.relative(files.source_path).removesuffix(".md")
    journal: list[str] = []
    if new_target == old_target and files.folder_id == old_files.folder_id:
        return journal
    ref = source_ref(library, files)
    folder_changed = files.folder_id != old_files.folder_id
    for page_id in _pages_of(kb, material_id):
        page = kb.page_repo.get(page_id)
        if page is None:
            continue
        path = library.root / page.rel_path

        def build(document: PageDocument) -> PageDocument:
            updated = relink_document(document, ref, old_target)
            if updated.meta.kind == "concept" and folder_changed:
                updated = refresh_concept_nav(kb, updated)
            elif updated.meta.kind == "note" and folder_changed and updated.meta.sources == (material_id,):
                updated = replace(updated, meta=replace(updated.meta, folders=(files.folder_id,)))
            return updated

        try:
            rewrite(library, path, build)
            reindex(kb, library, path)
        except (KnowledgeError, OSError, UnicodeDecodeError, ValueError):
            journal.append(f"“{page.title}” could not be updated; its links are rebuilt on the next change.")
    if title is not None:
        journal.extend(_rename_note(kb, library, material_id, files.title))
    return journal


def _rename_note(kb: KnowledgeService, library: Library, material_id: str, title: str) -> list[str]:
    note = next((page for page in kb.pages(kind="note") if page.sources == (material_id,)), None)
    if note is None or note.title == title:
        return []
    path = library.root / note.rel_path
    try:
        target = library.rename_page(path, title)
    except (NameTaken, NameRejected, OSError):
        return [f"The Notes page keeps its name “{note.title}”: “{title}” is taken in the wiki."]
    forget_page(kb.db, note.id)
    try:
        rewrite(library, target, lambda document: replace(document, meta=replace(document.meta, title=title)))
    finally:
        reindex(kb, library, target)
    return []
