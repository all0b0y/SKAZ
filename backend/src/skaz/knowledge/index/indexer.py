"""Write scan results into the index tables (full rebuild or one object at a time)."""
from __future__ import annotations

import json
import sqlite3
from collections.abc import Sequence

from ..ids import utc_now
from ..markdown.page import plain_text
from ..markdown.source import Fragment
from ..markdown.text import name_key
from ..store.database import KnowledgeDatabase
from .scanner import KnownPaths, ScannedMaterial, ScannedPage, ScanResult, ScanStopped, StopCheck

#: Tables rebuilt from files, children first (the FTS tables before their rows, so the delete
#: triggers find nothing left to drop). Corrections and edges belong to their areas, which rebuild
#: them from their own files after a scan.
_REBUILT = ("blocks_fts", "fragments_fts", "citations", "blocks", "aliases", "page_folders", "page_sources",
            "pages", "fragments", "materials", "folders")


def known_paths(db: KnowledgeDatabase) -> KnownPaths:
    with db.read() as connection:
        return KnownPaths(
            folders={row[0]: row[1] for row in connection.execute("SELECT id, rel_path FROM folders")},
            materials={row[0]: row[1] for row in connection.execute("SELECT id, rel_dir FROM materials")},
            pages={row[0]: row[1] for row in connection.execute("SELECT id, rel_path FROM pages")},
        )


def replace_index(db: KnowledgeDatabase, result: ScanResult, *, stop: StopCheck | None = None) -> None:
    """Make the index equal to a COMPLETE scan; one transaction, so readers never see half.

    ``stop()`` returning ``True`` between objects (SKAZ is closing) rolls the whole rebuild back.
    """
    with db.write() as connection:
        for table in _REBUILT:
            connection.execute(f"DELETE FROM {table}")
        for folder in result.folders:
            _put_folder(connection, folder.id, folder.name, result.folder_paths[folder.id], folder.system,
                        folder.created_at)
        for material in result.materials:
            if stop is not None and stop():
                raise ScanStopped
            _put_material(connection, material)
        for page in result.pages:
            if stop is not None and stop():
                raise ScanStopped
            _put_page(connection, page)


def put_folder(db: KnowledgeDatabase, folder_id: str, name: str, rel_path: str, system: bool,
               created_at: str) -> None:
    with db.write() as connection:
        _put_folder(connection, folder_id, name, rel_path, system, created_at)
        # Materials inside a renamed folder moved with it.
        for row in connection.execute("SELECT id, rel_dir, source_file FROM materials WHERE folder_id = ?",
                                      (folder_id,)).fetchall():
            directory = row["rel_dir"].rsplit("/", 1)[-1]
            source = row["source_file"].rsplit("/", 1)[-1]
            connection.execute("UPDATE materials SET rel_dir = ?, source_file = ? WHERE id = ?",
                               (f"{rel_path}/{directory}", f"{rel_path}/{directory}/{source}", row["id"]))


def delete_folder(db: KnowledgeDatabase, folder_id: str) -> None:
    with db.write() as connection:
        connection.execute("DELETE FROM folders WHERE id = ?", (folder_id,))


def put_material(db: KnowledgeDatabase, material: ScannedMaterial) -> None:
    with db.write() as connection:
        _put_material(connection, material)


def append_fragments(db: KnowledgeDatabase, material_id: str, fragments: Sequence[Fragment]) -> bool:
    """Index fragments appended after the indexed ones (cost ∝ new fragments).

    Returns ``False`` without writing when the material is not indexed yet;
    the caller then indexes the whole material with ``put_material``. The rows
    come from files the caller already wrote durably, so the commit skips the
    full disk flush (the startup scan rebuilds anything a power loss drops).
    """
    with db.write_rebuildable() as connection:
        if connection.execute("SELECT 1 FROM materials WHERE id = ?", (material_id,)).fetchone() is None:
            return False
        last = connection.execute("SELECT COALESCE(MAX(ordinal), 0) FROM fragments WHERE material_id = ?",
                                  (material_id,)).fetchone()[0]
        for ordinal, fragment in enumerate(fragments, start=int(last) + 1):
            _insert_fragment(connection, material_id, ordinal, fragment)
        return True


def put_page(db: KnowledgeDatabase, page: ScannedPage) -> None:
    with db.write() as connection:
        _put_page(connection, page)


def _put_folder(connection: sqlite3.Connection, folder_id: str, name: str, rel_path: str, system: bool,
                created_at: str) -> None:
    connection.execute("DELETE FROM folders WHERE rel_path = ? AND id != ?", (rel_path, folder_id))
    connection.execute(
        "INSERT INTO folders(id, name, rel_path, system, created_at) VALUES (?, ?, ?, ?, ?) "
        "ON CONFLICT(id) DO UPDATE SET name = excluded.name, rel_path = excluded.rel_path, "
        "system = excluded.system",
        (folder_id, name, rel_path, int(system), created_at),
    )


def _put_material(connection: sqlite3.Connection, material: ScannedMaterial) -> None:
    files = material.files
    manifest = files.manifest
    material_id = manifest.id
    # FTS rows go with their fragments (trigger ``fragments_fts_forget``, by rowid).
    connection.execute("DELETE FROM materials WHERE rel_dir = ? AND id != ?", (material.rel_dir, material_id))
    connection.execute("DELETE FROM fragments WHERE material_id = ?", (material_id,))
    connection.execute(
        "INSERT INTO materials(id, folder_id, kind, status, title, rel_dir, source_file, origin, languages, "
        "created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET "
        "folder_id = excluded.folder_id, kind = excluded.kind, status = excluded.status, "
        "title = excluded.title, rel_dir = excluded.rel_dir, source_file = excluded.source_file, "
        "origin = excluded.origin, languages = excluded.languages",
        (material_id, files.folder_id, manifest.kind, manifest.status, files.title, material.rel_dir,
         material.source_file,
         json.dumps(manifest.origin.model_dump(), ensure_ascii=False) if manifest.origin else None,
         json.dumps(manifest.languages, ensure_ascii=False), manifest.created_at),
    )
    for ordinal, fragment in enumerate(files.fragments, start=1):
        _insert_fragment(connection, material_id, ordinal, fragment)


def _insert_fragment(connection: sqlite3.Connection, material_id: str, ordinal: int,
                     fragment: Fragment) -> None:
    cursor = connection.execute(
        "INSERT INTO fragments(material_id, seg, ordinal, text, start_ms, end_ms, speaker, page, idx, role, "
        "level) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (material_id, fragment.seg, ordinal, fragment.text, fragment.start_ms, fragment.end_ms,
         fragment.speaker, fragment.page, fragment.index, fragment.role, fragment.level),
    )
    connection.execute("INSERT INTO fragments_fts(rowid, text, material_id, seg) VALUES (?, ?, ?, ?)",
                       (cursor.lastrowid, fragment.text, material_id, fragment.seg))


def _put_page(connection: sqlite3.Connection, page: ScannedPage) -> None:
    meta = page.meta
    # Blocks go by cascade, their FTS rows with them (trigger ``blocks_fts_forget``, by rowid).
    connection.execute("DELETE FROM pages WHERE rel_path = ? AND id != ?", (page.rel_path, meta.skaz_id))
    connection.execute("DELETE FROM pages WHERE id = ?", (meta.skaz_id,))
    connection.execute(
        "INSERT INTO pages(id, kind, title, rel_path, original, language, file_sha256, indexed_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (meta.skaz_id, meta.kind, page.title, page.rel_path, meta.original, meta.language, page.file_sha256,
         utc_now()),
    )
    for folder_id in dict.fromkeys(meta.folders):
        connection.execute("INSERT INTO page_folders(page_id, folder_id) VALUES (?, ?)",
                           (meta.skaz_id, folder_id))
    for material_id in dict.fromkeys(meta.sources):
        connection.execute("INSERT INTO page_sources(page_id, material_id) VALUES (?, ?)",
                           (meta.skaz_id, material_id))
    seen_aliases: set[str] = set()
    for alias in (meta.original or "", *meta.aliases):
        key = name_key(alias.strip())
        if key and key not in seen_aliases:
            seen_aliases.add(key)
            connection.execute("INSERT INTO aliases(page_id, alias, alias_key) VALUES (?, ?, ?)",
                               (meta.skaz_id, alias.strip(), key))
    seen_blocks: set[str] = set()
    for block in page.blocks:
        if block.block_id in seen_blocks:
            continue  # a duplicated block id (copy-paste in an editor): the first one is indexed
        seen_blocks.add(block.block_id)
        cursor = connection.execute(
            "INSERT INTO blocks(page_id, block_id, ordinal, section, kind, owner, hash, text, marked) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (meta.skaz_id, block.block_id, block.ordinal, block.section, block.kind, block.owner, block.hash,
             block.text, int(block.marked)),
        )
        connection.execute("INSERT INTO blocks_fts(rowid, text, page_id, block_id) VALUES (?, ?, ?, ?)",
                           (cursor.lastrowid, plain_text(block.text), meta.skaz_id, block.block_id))
        for ordinal, (material_id, seg, quote) in enumerate(block.cites, start=1):
            connection.execute(
                "INSERT INTO citations(page_id, block_id, ordinal, material_id, seg, quote) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (meta.skaz_id, block.block_id, ordinal, material_id, seg, quote),
            )
