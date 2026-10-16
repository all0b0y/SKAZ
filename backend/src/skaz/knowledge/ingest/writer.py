"""Writing one ingest result into the library (runs in a worker thread, under the write lock).

Order: concept pages, clean-up of concept pages this material no longer
contributes to, the Notes page (which links its concepts), then the index of
every touched page, ``Wiki/index.md`` and ``Wiki/log.md``.

Every page write re-reads the file (external edits are detected and marked
first) and replaces it only if it is still the bytes that were read
(``Library.rewrite_page``); a concurrent edit makes SKAZ read again rather
than overwrite.
"""
from __future__ import annotations

import threading
from collections import Counter
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field, replace
from pathlib import Path

from ..errors import KnowledgeError, NameRejected, NameTaken
from ..ids import new_id, utc_now
from ..index import indexer
from ..index.scanner import read_page
from ..library.fsio import write_atomic
from ..library.library import Library
from ..library.names import validate_name
from ..markdown.page import Block, PageDocument, PageFormatError, PageMeta, parse_page, render_page
from ..service import KnowledgeService
from .checks import CheckedBlock, connection_complete
from .drafts import ConceptDraft, DraftSection, file_name
from .pages import (
    ConceptUpdate,
    NoteSection,
    PageRef,
    SourceRef,
    build_note,
    description,
    is_empty_orphan,
    match_key,
    merge_concept,
    new_concept,
    render_statement,
    set_note_concepts,
    strip_material,
)

MAX_WRITE_ATTEMPTS = 3
INDEX_TITLES: dict[str, dict[str, str]] = {
    "en": {"concept": "Concepts", "note": "Notes", "folder": "Folder overviews", "analysis": "Analyses"},
    "ru": {"concept": "Понятия", "note": "Конспекты", "folder": "Обзоры папок", "analysis": "Разборы"},
}
LOG_TEXT: dict[str, dict[str, str]] = {
    "en": {"notes_new": "Notes written", "notes_updated": "Notes rewritten", "added": "concepts added",
           "updated": "concepts updated", "removed": "concepts left without a source removed",
           "from": "from"},
    "ru": {"notes_new": "конспект написан", "notes_updated": "конспект переписан", "added": "новые понятия",
           "updated": "дополнены понятия", "removed": "удалены понятия без источников", "from": "из"},
}


class PageConflict(KnowledgeError):
    status_code = 409


@dataclass(frozen=True)
class ConceptTarget:
    draft: ConceptDraft
    #: Existing page chosen by matching; ``None`` = a new page.
    page_id: str | None


@dataclass
class WritePlan:
    material_id: str
    rel_dir: str | None
    language: str
    sections: list[DraftSection]
    concepts: list[ConceptTarget]


@dataclass
class WriteResult:
    note_page_id: str = ""
    note_created: bool = False
    created: list[str] = field(default_factory=list)
    updated: list[str] = field(default_factory=list)
    #: Existing concept pages that received new blocks: page id → new block ids (for W2).
    new_blocks: dict[str, list[str]] = field(default_factory=dict)
    #: Concept pages removed because nothing supports them any more (QA C7).
    removed: list[str] = field(default_factory=list)
    dropped: Counter[str] = field(default_factory=Counter)
    blocks_written: int = 0
    journal: list[str] = field(default_factory=list)


class _Resolver:
    """Page titles → wiki links: this run's concepts first, then existing concept pages by title/alias.

    Only concept pages: a link resolved here can be the second side of a
    connection, and an analysis is never a source (decision 8) — nor are a
    Notes page or a folder overview, which only restate their materials.
    """

    def __init__(self, kb: KnowledgeService) -> None:
        self.refs: dict[str, PageRef] = {}
        for record in kb.pages(kind="concept"):
            ref = PageRef(record.rel_path.removesuffix(".md"), record.title, record.id)
            for name in (record.title, record.original or "", *record.aliases):
                if name.strip():
                    self.refs.setdefault(match_key(name), ref)

    def add(self, keys: set[str], ref: PageRef) -> None:
        for key in keys:
            self.refs[key] = ref

    def __call__(self, title: str) -> PageRef | None:
        return self.refs.get(match_key(title))


def _source_ref(library: Library, material_id: str, rel_dir: str | None) -> SourceRef:
    files = library.read_material(material_id, hint=rel_dir)
    return SourceRef(
        material_id=material_id, folder_name=files.directory.parent.name, title=files.title,
        file_stem=files.source_path.stem,
        start_ms={fragment.seg: fragment.start_ms for fragment in files.fragments},
        page={fragment.seg: fragment.page for fragment in files.fragments},
    )


def _rewrite(library: Library, path: Path, build: Callable[[PageDocument], PageDocument | None]) -> bool:
    """Apply ``build`` to the current file; ``False`` if it had nothing to change."""
    for _attempt in range(MAX_WRITE_ATTEMPTS):
        read_page(library, path)  # marks externally edited blocks as the user's first
        data = path.read_bytes()
        document = parse_page(data.decode("utf-8"))
        updated = build(document)
        if updated is None:
            return False
        text = render_page(updated)
        if text.encode("utf-8") == data:
            return False
        if library.rewrite_page(path, data, text):
            return True
    raise PageConflict(f"“{path.stem}” kept changing while SKAZ was writing it. Retry when it is saved.")


class WikiWriter:
    def __init__(self, kb: KnowledgeService, lock: threading.Lock) -> None:
        self.kb = kb
        self.lock = lock

    def write(self, plan: WritePlan) -> WriteResult:
        with self.lock:
            return self._write(plan)

    # -- helpers ------------------------------------------------------------

    def _folders_of(self, sources: Sequence[str]) -> tuple[str, ...]:
        folders: dict[str, None] = {}
        for material_id in sources:
            record = self.kb.material_repo.get(material_id)
            if record is not None:
                folders.setdefault(record.folder_id, None)
        return tuple(folders)

    def _folders_body(self, meta: PageMeta) -> str | None:
        by_folder: dict[str, list[str]] = {}
        for material_id in meta.sources:
            record = self.kb.material_repo.get(material_id)
            if record is None:
                continue
            by_folder.setdefault(record.folder_id, []).append(
                f"[[{record.source_file.removesuffix('.md')}|{record.title}]]")
        lines = []
        for folder_id, links in by_folder.items():
            folder = self.kb.folder_repo.get(folder_id)
            name = folder.name if folder else folder_id
            lines.append(f"{name}: {', '.join(links)}")
        return "; ".join(lines) if lines else None

    def _statements(self, blocks: Sequence[CheckedBlock], source: SourceRef, resolve: _Resolver,
                    result: WriteResult, *, exclude: str | None = None) -> list[Block]:
        rendered = []
        for block in blocks:
            links = [ref for ref in (resolve(title) for title in block.links)
                     if ref is not None and ref.target != exclude]
            links = list({ref.target: ref for ref in links}.values())
            if not connection_complete(block, links):
                result.dropped["connection_one_side"] += 1
                continue
            rendered.append(render_statement(block, source, links))
        return rendered

    def _index_page(self, library: Library, path: Path) -> None:
        indexer.put_page(self.kb.db, read_page(library, path))

    # -- the write ----------------------------------------------------------

    def _write(self, plan: WritePlan) -> WriteResult:
        library = self.kb.require()
        result = WriteResult()
        source = _source_ref(library, plan.material_id, plan.rel_dir)
        resolve = _Resolver(self.kb)
        concept_dir = library.page_directory("concept")
        concept_dir.mkdir(parents=True, exist_ok=True)

        # Final page for every concept: an existing page, or a new file name.
        targets: list[tuple[ConceptTarget, PageRef, Path]] = []
        for target in plan.concepts:
            record = self.kb.page_repo.get(target.page_id) if target.page_id else None
            if record is not None:
                path = library.root / record.rel_path
                ref = PageRef(record.rel_path.removesuffix(".md"), record.title, record.id)
            else:
                try:
                    name = validate_name(file_name(target.draft.display_title))
                except NameRejected:
                    result.journal.append(f"A concept was skipped: its name can't be a file name "
                                          f"(“{target.draft.display_title[:60]}”).")
                    result.dropped["concept_bad_name"] += 1
                    continue
                path = concept_dir / f"{name}.md"
                ref = PageRef(library.relative(path).removesuffix(".md"), name)
            resolve.add(target.draft.keys(), ref)
            targets.append((target, ref, path))

        touched: list[Path] = []
        written_refs: list[PageRef] = []
        for target, ref, path in targets:
            draft = target.draft
            blocks = self._statements(draft.blocks, source, resolve, result, exclude=ref.target)
            if not any(block.kind == "from_source" for block in blocks):
                result.dropped["concept_without_source"] += 1
                continue
            related = [found for found in (resolve(title) for title in draft.related)
                       if found is not None and found.target != ref.target]
            update = ConceptUpdate(plan.material_id, blocks, draft.all_aliases(), related)
            existed = path.exists()
            page_id = self._write_concept(library, path, draft, update, plan.language, result)
            if page_id is None:
                continue
            touched.append(path)
            result.blocks_written += len(blocks)
            written_refs.append(replace(ref, page_id=page_id))
            if existed:
                result.updated.append(draft.display_title)
                result.new_blocks[page_id] = [block.id for block in blocks]
            else:
                result.created.append(draft.display_title)

        # Concept pages this material contributed to before but not in this run.
        written_ids = {ref.page_id for ref in written_refs}
        for record in self.kb.pages(kind="concept"):
            if plan.material_id not in record.sources or record.id in written_ids:
                continue
            path = library.root / record.rel_path

            def cleanup(document: PageDocument) -> PageDocument | None:
                _stripped, removed = strip_material(document, plan.material_id)
                if not removed:
                    return None
                return merge_concept(document, None, material_id=plan.material_id,
                                     folders_of=self._folders_of, folders_body=self._folders_body)

            try:
                if _rewrite(library, path, cleanup):
                    touched.append(path)
            except (OSError, PageFormatError, UnicodeDecodeError):
                result.journal.append(f"“{record.title}” could not be updated; it was left as it was.")

        # The Notes page.
        sections = []
        for section in plan.sections:
            blocks = self._statements(section.blocks, source, resolve, result)
            if blocks:
                sections.append(NoteSection(section.title, tuple(blocks)))
                result.blocks_written += len(blocks)
        note_path, created = self._write_note(library, plan, source, sections, written_refs)
        result.note_created = created
        touched.append(note_path)

        for path in dict.fromkeys(touched):
            self._index_page(library, path)
        # Concept pages left with nothing — no source, no statement, no words of the user (QA C7):
        # they go, as on Delete, instead of staying as empty pages in the list and the graph.
        for record in self.kb.pages(kind="concept"):
            if record.id in written_ids or record.sources:
                continue
            path = library.root / record.rel_path
            try:
                read_page(library, path)  # an outside edit makes a block the user's first
                data = path.read_bytes()
                if not is_empty_orphan(parse_page(data.decode("utf-8"))):
                    continue
                if path.read_bytes() != data:
                    continue  # changed meanwhile: the next pass decides
                path.unlink()
            except (OSError, PageFormatError, UnicodeDecodeError):
                continue
            with self.kb.db.write() as connection:
                connection.execute("DELETE FROM pages WHERE id = ?", (record.id,))
                connection.execute("DELETE FROM wiki_checked WHERE page_id = ?", (record.id,))
            result.removed.append(record.title)

        note_record = next((page for page in self.kb.pages(kind="note")
                            if page.rel_path == library.relative(note_path)), None)
        result.note_page_id = note_record.id if note_record else ""
        self._write_index(library, plan.language)
        self._append_log(library, plan.language, source, result)
        return result

    def _write_concept(self, library: Library, path: Path, draft: ConceptDraft, update: ConceptUpdate,
                       language: str, result: WriteResult) -> str | None:
        def build(document: PageDocument) -> PageDocument:
            return merge_concept(document, update, material_id=update.material_id,
                                 folders_of=self._folders_of, folders_body=self._folders_body)

        if path.exists():
            try:
                _rewrite(library, path, build)
                return parse_page(path.read_text(encoding="utf-8")).meta.skaz_id
            except (PageFormatError, UnicodeDecodeError):
                result.journal.append(
                    f"“{path.stem}” exists but is not a SKAZ page; the concept was skipped.")
                result.dropped["concept_name_taken"] += 1
                return None
        meta = PageMeta(skaz_id=new_id("pg"), kind="concept", title=path.stem,
                        original=draft.original if draft.display_title != draft.title else None,
                        language=language)
        try:
            library.create_page(build(new_concept(meta)))
        except NameTaken:
            if path.exists():  # created by a parallel writer between the check and now: merge into it
                return self._write_concept(library, path, draft, update, language, result)
            result.journal.append(f"“{path.stem}” clashes with another page name; the concept was skipped.")
            result.dropped["concept_name_taken"] += 1
            return None
        return meta.skaz_id

    def _note_path(self, library: Library, plan: WritePlan, source: SourceRef) -> Path | None:
        for record in self.kb.pages(kind="note"):
            if plan.material_id in record.sources:
                path = library.root / record.rel_path
                if path.is_file():
                    return path
        return None

    def _write_note(self, library: Library, plan: WritePlan, source: SourceRef,
                    sections: Sequence[NoteSection], concepts: Sequence[PageRef]) -> tuple[Path, bool]:
        meta = PageMeta(skaz_id=new_id("pg"), kind="note", title=source.title, language=plan.language,
                        folders=self._folders_of([plan.material_id]), sources=(plan.material_id,))
        refs = [PageRef(ref.target, ref.title) for ref in concepts]

        def build(document: PageDocument | None) -> PageDocument:
            note = build_note(document, meta, sections)
            return set_note_concepts(note, refs)

        path = self._note_path(library, plan, source)
        if path is not None:
            _rewrite(library, path, build)
            return path, False
        note_dir = library.page_directory("note")
        note_dir.mkdir(parents=True, exist_ok=True)
        document = build(None)
        for title in (source.title, f"{source.title} ({source.folder_name})"):
            try:
                created = library.create_page(replace(document, meta=replace(document.meta, title=title)))
            except NameTaken:
                continue
            return created, True
        raise NameTaken("A Notes page with this material's name already exists. "
                        "Rename the material and retry.")

    def refresh_index(self, language: str) -> None:
        """Rewrite ``Wiki/index.md`` from the page index (W2: after pages are edited or removed)."""
        self._write_index(self.kb.require(), language)

    def _write_index(self, library: Library, language: str) -> None:
        labels = INDEX_TITLES.get(language, INDEX_TITLES["en"])
        lines = ["# Index", ""]
        for kind in ("concept", "note", "folder", "analysis"):
            pages = self.kb.pages(kind=kind)
            if not pages:
                continue
            lines.append(f"## {labels[kind]}")
            lines.append("")
            for page in pages:
                blocks = self.kb.page_repo.blocks(page.id)
                first = next((block.text for block in blocks if block.kind == "from_source"), "")
                summary = description(first)
                link = f"[[{page.rel_path.removesuffix('.md')}|{page.title}]]"
                lines.append(f"- {link} — {summary}" if summary else f"- {link}")
            lines.append("")
        write_atomic(library.wiki_dir / "index.md", ("\n".join(lines).rstrip() + "\n").encode("utf-8"))

    def _append_log(self, library: Library, language: str, source: SourceRef, result: WriteResult) -> None:
        text = LOG_TEXT.get(language, LOG_TEXT["en"])
        stamp = utc_now().replace("T", " ").removesuffix("Z")[:16] + " UTC"
        parts = [text["notes_new"] if result.note_created else text["notes_updated"]]
        if result.created:
            parts.append(f"{text['added']}: {', '.join(result.created)}")
        if result.updated:
            parts.append(f"{text['updated']}: {', '.join(result.updated)}")
        if result.removed:
            parts.append(f"{text['removed']}: {', '.join(result.removed)}")
        material = f"[[Materials/{source.folder_name}/{source.title}/{source.file_stem}|{source.title}]]"
        line = f"- {stamp} — {'; '.join(parts)} — {text['from']} {material}\n"
        path = library.wiki_dir / "log.md"
        try:
            current = path.read_text(encoding="utf-8")
        except FileNotFoundError:
            current = "# Log\n"
        if not current.endswith("\n"):
            current += "\n"
        lines = current.rstrip("\n").splitlines()
        if lines and lines[-1].startswith("#"):
            current = current.rstrip("\n") + "\n\n"
        write_atomic(path, (current + line).encode("utf-8"))
