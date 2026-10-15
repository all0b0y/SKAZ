"""The index rebuild scales linearly, and FTS rows follow their fragments/blocks by rowid.

A full rescan used to delete each material's and page's FTS rows by an UNINDEXED
column (``DELETE FROM fragments_fts WHERE material_id = ?``): a scan of the whole
FTS table per object, so a rebuild was quadratic (1000 materials × 300 fragments
+ 3000 pages took ~50 s, past Electron's health wait).
"""
from __future__ import annotations

import sqlite3
import time
from pathlib import Path
from types import SimpleNamespace

from skaz.knowledge.index import indexer
from skaz.knowledge.index.scanner import IndexedBlock, ScannedMaterial, ScannedPage, ScanResult
from skaz.knowledge.index.search import search
from skaz.knowledge.library.library import FolderEntry, MaterialFiles
from skaz.knowledge.markdown.page import PageMeta
from skaz.knowledge.markdown.source import Fragment, MaterialManifest
from skaz.knowledge.store.database import KnowledgeDatabase
from skaz.knowledge.store.schema import apply_schemas, core

_TEXT = "Entropy is a measure of the number of microscopic configurations of a system. " * 3
_STAMP = "2026-01-01T00:00:00Z"


def synthetic_scan(materials: int, fragments: int, pages: int, *, blocks: int = 10) -> ScanResult:
    result = ScanResult()
    inbox = FolderEntry("fld-inbox", "Inbox", True, _STAMP, Path("/lib/Materials/Inbox"))
    result.folders.append(inbox)
    result.folder_paths[inbox.id] = "Materials/Inbox"
    for i in range(materials):
        manifest = MaterialManifest(id=f"mat-{i}", kind="audio", status="ready", title=f"Lecture {i}",
                                    folder=inbox.id, created_at=_STAMP)
        rows = [Fragment(seg=j + 1, text=f"m{i}f{j} {_TEXT}", start_ms=j * 1000, end_ms=j * 1000 + 900)
                for j in range(fragments)]
        directory = Path(f"/lib/Materials/Inbox/Lecture {i}")
        files = MaterialFiles(manifest, f"Lecture {i}", inbox.id, directory, directory / f"Lecture {i}.md",
                              rows)
        result.materials.append(ScannedMaterial(files, f"Materials/Inbox/Lecture {i}",
                                                f"Materials/Inbox/Lecture {i}/Lecture {i}.md"))
    for i in range(pages):
        source = f"mat-{i % max(materials, 1)}"
        meta = PageMeta(skaz_id=f"pg-{i}", kind="concept", title=f"Concept {i}", language="en",
                        sources=(source,))
        parts = tuple(IndexedBlock(f"c-{i}-{k}", k, "Agent explanation", "explanation", "agent", "h",
                                   f"p{i}b{k} {_TEXT}", True, ((source, 1, None),)) for k in range(blocks))
        result.pages.append(ScannedPage(meta, f"Concept {i}", f"Wiki/Concepts/Concept {i}.md", "sha", parts))
    return result


def _rebuild_seconds(tmp_path: Path, name: str, scan: ScanResult) -> float:
    db = KnowledgeDatabase(tmp_path / f"{name}.sqlite3")
    try:
        indexer.replace_index(db, scan)  # the full index exists, as at every start after the first
        best = float("inf")
        for _ in range(2):
            started = time.perf_counter()
            indexer.replace_index(db, scan)
            best = min(best, time.perf_counter() - started)
        return best
    finally:
        db.close()


def test_full_rebuild_is_roughly_linear(tmp_path: Path) -> None:
    small = _rebuild_seconds(tmp_path, "small", synthetic_scan(50, 200, 150))
    large = _rebuild_seconds(tmp_path, "large", synthetic_scan(200, 200, 600))
    print(f"\nrebuild 50x200+150: {small:.2f} s, 200x200+600: {large:.2f} s, ratio {large / small:.2f}")
    # Four times the library: ~4x when linear; the quadratic delete gave ~10x at these sizes.
    assert large / small < 6.5


def _fts_rows(db: KnowledgeDatabase, table: str) -> int:
    with db.read() as connection:
        return int(connection.execute(f"SELECT count(*) FROM {table}").fetchone()[0])


def test_fts_rows_share_the_rowid_and_leave_with_their_rows(tmp_path: Path) -> None:
    db = KnowledgeDatabase(tmp_path / "k.sqlite3")
    try:
        scan = synthetic_scan(3, 4, 3, blocks=2)
        indexer.replace_index(db, scan)
        with db.read() as connection:
            mismatched = connection.execute(
                "SELECT count(*) FROM fragments_fts f JOIN fragments x ON x.rowid = f.rowid "
                "WHERE x.material_id != f.material_id OR x.seg != f.seg").fetchone()[0]
            assert mismatched == 0
        assert (_fts_rows(db, "fragments_fts"), _fts_rows(db, "blocks_fts")) == (12, 6)
        indexer.put_material(db, scan.materials[0])  # re-index one: no duplicate FTS rows
        indexer.put_page(db, scan.pages[0])
        assert (_fts_rows(db, "fragments_fts"), _fts_rows(db, "blocks_fts")) == (12, 6)
        with db.write() as connection:  # a page and a material deleted directly
            connection.execute("DELETE FROM pages WHERE id = 'pg-1'")
            connection.execute("DELETE FROM materials WHERE id = 'mat-1'")
        assert (_fts_rows(db, "fragments_fts"), _fts_rows(db, "blocks_fts")) == (8, 4)
        assert [hit.material_id for hit in search(db, "m0f1").fragments] == ["mat-0"]
        indexer.delete_folder(db, "fld-inbox")  # by cascade: folder → materials → fragments
        assert _fts_rows(db, "fragments_fts") == 0
        assert search(db, "m0f1").fragments == ()
    finally:
        db.close()


def test_core_v2_index_upgrades_to_rowid_keyed_fts(tmp_path: Path) -> None:
    connection = sqlite3.connect(tmp_path / "knowledge.sqlite3")
    connection.execute("PRAGMA foreign_keys=ON")
    v2 = SimpleNamespace(NAME="core", VERSION=2, SQL=core.SQL.replace(core.TRIGGERS, ""))
    apply_schemas(connection, [v2])
    connection.executescript("""
        INSERT INTO folders(id, name, rel_path, created_at)
            VALUES ('fld-1', 'Inbox', 'Materials/Inbox', 'now');
        INSERT INTO materials(id, folder_id, kind, status, title, rel_dir, source_file, created_at)
            VALUES ('mat-1', 'fld-1', 'text', 'ready', 'T', 'Materials/Inbox/T', 'Materials/Inbox/T/T.md',
                    'now');
        INSERT INTO fragments(material_id, seg, ordinal, text) VALUES ('mat-1', 1, 1, 'alpha photon');
        INSERT INTO fragments(material_id, seg, ordinal, text) VALUES ('mat-1', 2, 2, 'beta neutrino');
        INSERT INTO pages(id, kind, title, rel_path, language, file_sha256, indexed_at)
            VALUES ('pg-1', 'note', 'T', 'Wiki/Notes/T.md', 'en', 'abc', 'now');
        INSERT INTO blocks(page_id, block_id, ordinal, kind, owner, hash, text, marked)
            VALUES ('pg-1', 'c-1', 1, 'explanation', 'agent', 'h', '**gamma** quark', 1);
        -- v2 wrote FTS rows with their own rowids, in any order, sometimes twice
        INSERT INTO fragments_fts(rowid, text, material_id, seg) VALUES (90, 'beta neutrino', 'mat-1', 2);
        INSERT INTO fragments_fts(rowid, text, material_id, seg) VALUES (91, 'alpha photon', 'mat-1', 1);
        INSERT INTO blocks_fts(rowid, text, page_id, block_id) VALUES (50, 'gamma quark', 'pg-1', 'c-1');
        INSERT INTO blocks_fts(rowid, text, page_id, block_id) VALUES (51, 'gamma quark', 'pg-1', 'c-1');
    """)
    connection.commit()
    apply_schemas(connection, [core])
    connection.commit()
    assert connection.execute(
        "SELECT count(*) FROM fragments_fts f JOIN fragments x ON x.rowid = f.rowid AND x.seg = f.seg"
    ).fetchone()[0] == 2
    assert connection.execute(
        "SELECT f.text FROM blocks_fts f JOIN blocks b ON b.rowid = f.rowid").fetchall() == [("gamma quark",)]
    assert connection.execute("SELECT count(*) FROM blocks_fts").fetchone()[0] == 1
    connection.execute("DELETE FROM materials WHERE id = 'mat-1'")
    connection.execute("DELETE FROM pages WHERE id = 'pg-1'")
    assert connection.execute("SELECT count(*) FROM fragments_fts").fetchone()[0] == 0
    assert connection.execute("SELECT count(*) FROM blocks_fts").fetchone()[0] == 0
    connection.close()
