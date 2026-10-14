"""Read the library files into index rows; detect external edits of SKAZ blocks.

Rules (FILESYSTEM-LIBRARY-SPEC 2, 7, 9, 12, 16, 20, 22, 26–28):

* Only objects with our markers are read: folders with ``.skaz/folder.json``,
  materials with ``.skaz/material.json``, pages with ``skaz_id``/``kind``
  frontmatter. Anything else is neither shown nor touched.
* A damaged marker makes that one object unconnectable; it is skipped.
* Any ``OSError`` while walking aborts the scan (``LibraryUnavailable``):
  an incomplete walk must never shrink the index.
* Names on disk win (Finder renames/moves are accepted); ids come from markers.
* The same id in several places: the previously indexed path wins; without
  one, a single candidate is used and several candidates are all skipped.
* A SKAZ block whose text no longer matches its ``hash`` was edited outside:
  an agent block becomes ``user_edited``. Only the marker line is rewritten.
"""
from __future__ import annotations

import hashlib
import os
from collections import defaultdict
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import TypeVar

from ..errors import LibraryUnavailable, NotFound
from ..library.layout import WIKI_SUBDIRS
from ..library.library import FolderEntry, Library, MaterialFiles
from ..markdown.page import Block, PageFormatError, PageMeta, UserParagraph, parse_page, render_page
from ..markdown.text import block_hash


@dataclass(frozen=True)
class ScannedMaterial:
    files: MaterialFiles
    rel_dir: str
    source_file: str


@dataclass(frozen=True)
class IndexedBlock:
    block_id: str
    ordinal: int
    section: str | None
    kind: str
    owner: str
    hash: str
    text: str
    marked: bool
    cites: tuple[tuple[str, int], ...] = ()


@dataclass(frozen=True)
class ScannedPage:
    meta: PageMeta
    #: The file name without ``.md``: a Finder rename is accepted as the title.
    title: str
    rel_path: str
    file_sha256: str
    blocks: tuple[IndexedBlock, ...]
    edited_blocks: tuple[str, ...] = ()


@dataclass
class ScanResult:
    folders: list[FolderEntry] = field(default_factory=list)
    folder_paths: dict[str, str] = field(default_factory=dict)
    materials: list[ScannedMaterial] = field(default_factory=list)
    pages: list[ScannedPage] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class KnownPaths:
    """Paths of the previous index, used to resolve duplicate ids."""

    folders: Mapping[str, str] = field(default_factory=dict)
    materials: Mapping[str, str] = field(default_factory=dict)
    pages: Mapping[str, str] = field(default_factory=dict)


T = TypeVar("T")


def _pick(candidates: Mapping[str, Sequence[T]], known: Mapping[str, str],
          path_of: Callable[[T], str], skipped: list[str]) -> list[T]:
    chosen = []
    for object_id, items in candidates.items():
        if len(items) == 1:
            chosen.append(items[0])
            continue
        previous = [item for item in items if path_of(item) == known.get(object_id)]
        if len(previous) == 1:
            chosen.append(previous[0])
        else:
            skipped.extend(path_of(item) for item in items)
    return chosen


def read_page(library: Library, path: Path) -> ScannedPage:
    """Parse one page; rewrite marker lines of externally edited blocks.

    Raises ``PageFormatError``/``UnicodeDecodeError`` for files that are not
    SKAZ pages, ``OSError`` for read failures.
    """
    data = path.read_bytes()
    document = parse_page(data.decode("utf-8"))
    edited = []
    for block in document.blocks():
        if not block.hash_matches():
            owner = "user_edited" if block.owner == "agent" else block.owner
            document = document.with_block(block.remarked(owner=owner))
            edited.append(block.id)
    if edited and library.rewrite_page(path, data, render_page(document)):
        data = path.read_bytes()
    blocks = []
    for ordinal, entry in enumerate(document.entries(), start=1):
        item = entry.item
        if isinstance(item, Block):
            blocks.append(IndexedBlock(
                block_id=item.id, ordinal=ordinal, section=entry.section, kind=item.kind, owner=item.owner,
                hash=item.hash, text=item.body, marked=True,
                cites=tuple((cite.material_id, cite.seg) for cite in item.cites),
            ))
        else:
            assert isinstance(item, UserParagraph)
            blocks.append(IndexedBlock(
                block_id=item.id, ordinal=ordinal, section=entry.section, kind="user_note", owner="user",
                hash=block_hash(item.text), text=item.text, marked=False,
            ))
    return ScannedPage(
        meta=document.meta, title=path.name.removesuffix(".md"), rel_path=library.relative(path),
        file_sha256=hashlib.sha256(data).hexdigest(), blocks=tuple(blocks), edited_blocks=tuple(edited),
    )


def scan_library(library: Library, known: KnownPaths | None = None) -> ScanResult:
    known = known or KnownPaths()
    result = ScanResult()
    try:
        _scan(library, known, result)
    except OSError as error:
        where = error.filename or library.root
        raise LibraryUnavailable(
            f"SKAZ couldn't read the whole library ({where}). Nothing was removed from the list."
        ) from error
    return result


def _scan(library: Library, known: KnownPaths, result: ScanResult) -> None:
    if not library.materials_dir.is_dir() or not library.wiki_dir.is_dir():
        raise LibraryUnavailable(f"The library layout is incomplete: {library.root}")

    folders_by_id: dict[str, list[FolderEntry]] = defaultdict(list)
    for entry in library.folders():
        folders_by_id[entry.id].append(entry)
    result.folders = _pick(folders_by_id, known.folders, lambda e: library.relative(e.path), result.skipped)
    result.folder_paths = {entry.id: library.relative(entry.path) for entry in result.folders}

    materials_by_id: dict[str, list[ScannedMaterial]] = defaultdict(list)
    for folder in result.folders:
        for name in sorted(os.listdir(folder.path)):
            directory = folder.path / name
            if name.startswith(".") or not directory.is_dir():
                continue
            if not (directory / ".skaz" / "material.json").is_file():
                continue
            try:
                files = library.load_material(directory, folder.id)
            except (ValueError, NotFound, UnicodeDecodeError):
                result.skipped.append(library.relative(directory))
                continue
            materials_by_id[files.manifest.id].append(ScannedMaterial(
                files, library.relative(directory), library.relative(files.source_path),
            ))
    result.materials = _pick(materials_by_id, known.materials, lambda m: m.rel_dir, result.skipped)

    pages_by_id: dict[str, list[ScannedPage]] = defaultdict(list)
    for subdir in WIKI_SUBDIRS.values():
        directory = library.wiki_dir / subdir
        if not directory.is_dir():
            continue
        for name in sorted(os.listdir(directory)):
            path = directory / name
            if name.startswith(".") or not name.endswith(".md") or not path.is_file():
                continue
            try:
                page = read_page(library, path)
            except (PageFormatError, UnicodeDecodeError):
                continue  # not a SKAZ page: neither shown nor touched
            pages_by_id[page.meta.skaz_id].append(page)
    result.pages = _pick(pages_by_id, known.pages, lambda p: p.rel_path, result.skipped)
