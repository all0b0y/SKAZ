"""WR1 (decision 9a): wiki checkpoints survive the startup scan; they go only with the material.

The scan rebuilds the index (``DELETE FROM materials``); a service table that cascaded from it lost
every kept answer on each app start, so "the finished items are kept: Retry continues" was false.
"""
from __future__ import annotations

import shutil
import sqlite3
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx

from skaz.knowledge.index import indexer
from skaz.knowledge.index.indexer import _REBUILT
from skaz.knowledge.ingest.checkpoints import Checkpoints
from skaz.knowledge.service import KnowledgeService
from skaz.knowledge.store.database import KnowledgeDatabase
from skaz.knowledge.store.schema import MODULES, wiki_execution
from skaz.knowledge.wiki.pages_io import forget_material
from tests.knowledge.ingest_support import add_material

PROFILE = "Codex · model-a · low"

#: ``wiki_execution`` v4 as 0.3.x/0.4.0 shipped it: the checkpoint head cascaded from ``materials``.
V4 = SimpleNamespace(NAME="wiki_execution", VERSION=4, SQL="""
CREATE TABLE IF NOT EXISTS wiki_execution (
    job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
    data TEXT NOT NULL,
    root_job_id TEXT
);
CREATE INDEX IF NOT EXISTS wiki_execution_by_root ON wiki_execution(root_job_id);
CREATE TABLE IF NOT EXISTS wiki_checkpoints (
    material_id TEXT PRIMARY KEY REFERENCES materials(id) ON DELETE CASCADE,
    fingerprint TEXT NOT NULL,
    finished_profile TEXT
);
CREATE TABLE IF NOT EXISTS wiki_checkpoint_answers (
    material_id TEXT NOT NULL REFERENCES wiki_checkpoints(material_id) ON DELETE CASCADE,
    step_key TEXT NOT NULL,
    response TEXT NOT NULL,
    created_at TEXT NOT NULL,
    profile TEXT,
    PRIMARY KEY(material_id, step_key)
);
""")


def _keep_answer(kb: KnowledgeService, material_id: str) -> Checkpoints:
    checkpoints = Checkpoints(kb.db, material_id, "rev", PROFILE)
    checkpoints.prepare()
    checkpoints.put("concepts-1", '{"concepts": [], "more": true}')
    return checkpoints


def _rows(db: KnowledgeDatabase, material_id: str) -> tuple[int, int]:
    with db.read() as connection:
        heads = connection.execute("SELECT COUNT(*) FROM wiki_checkpoints WHERE material_id=?",
                                   (material_id,)).fetchone()[0]
        answers = connection.execute("SELECT COUNT(*) FROM wiki_checkpoint_answers WHERE material_id=?",
                                     (material_id,)).fetchone()[0]
    return int(heads), int(answers)


def test_kept_answers_survive_the_startup_scan(ready: KnowledgeService) -> None:
    material_id = add_material(ready, "Физика", "Лекция 8")
    _keep_answer(ready, material_id)
    ready.rescan()  # what every app start does: a complete scan rebuilds the index
    assert ready.view().state == "ready"
    assert _rows(ready.db, material_id) == (1, 1)
    again = Checkpoints(ready.db, material_id, "rev", "DeepSeek · flash")
    again.prepare()
    assert again.get("concepts-1") is not None  # Retry (any model) continues from it


def test_kept_answers_survive_the_rebuild_itself_even_while_the_material_row_is_gone(
        ready: KnowledgeService) -> None:
    material_id = add_material(ready, "Физика", "Лекция 8")
    _keep_answer(ready, material_id)
    with ready.db.write() as connection:  # the scan's DELETE sequence, as verified on the user's copy
        for table in _REBUILT:
            connection.execute(f"DELETE FROM {table}")
    assert _rows(ready.db, material_id) == (1, 1)


def test_a_complete_scan_prunes_the_answers_of_a_material_that_is_gone(ready: KnowledgeService) -> None:
    kept = add_material(ready, "Физика", "Лекция 8")
    gone = add_material(ready, "Физика", "Лекция 9")
    _keep_answer(ready, kept)
    _keep_answer(ready, gone)
    record = ready.material_repo.get(gone)
    assert record is not None
    shutil.rmtree(ready.library_root / record.rel_dir)  # deleted in Finder while SKAZ was closed
    ready.rescan()
    assert _rows(ready.db, kept) == (1, 1)
    assert _rows(ready.db, gone) == (0, 0)


def test_a_partial_scan_prunes_nothing(ready: KnowledgeService) -> None:
    material_id = add_material(ready, "Физика", "Лекция 8")
    _keep_answer(ready, material_id)
    materials = ready.library_root / "Materials"
    materials.chmod(0)
    try:
        ready.rescan()  # iCloud still syncing / no permission: the material may be back next time
        assert ready.view().state == "unavailable"
    finally:
        materials.chmod(0o755)
    assert _rows(ready.db, material_id) == (1, 1)


def test_a_partial_rebuild_keeps_answers_of_materials_it_could_not_read(ready: KnowledgeService) -> None:
    material_id = add_material(ready, "Физика", "Лекция 8")
    _keep_answer(ready, material_id)
    record = ready.material_repo.get(material_id)
    assert record is not None
    result = SimpleNamespace(unreadable=(record.rel_dir,), folders=(), folder_paths={}, materials=(),
                             pages=())
    indexer.replace_index(ready.db, result)  # type: ignore[arg-type]
    assert _rows(ready.db, material_id) == (1, 1)


def test_deleting_the_material_deletes_its_answers(ready: KnowledgeService) -> None:
    material_id = add_material(ready, "Физика", "Лекция 8")
    _keep_answer(ready, material_id)
    forget_material(ready.db, material_id)  # the wiki's material deletion (wiki/delete.py)
    assert _rows(ready.db, material_id) == (0, 0)


async def test_deleting_a_failed_import_deletes_its_answers(kb_app: Any,
                                                            kb_client: httpx.AsyncClient) -> None:
    await kb_client.post("/kb/library", json={})
    runtime = kb_app.state.runtime
    material_id = add_material(runtime.kb, "Физика", "Лекция 8")
    _keep_answer(runtime.kb, material_id)
    record = runtime.kb.material_repo.get(material_id)
    assert record is not None
    runtime.kb_speech._remove_material(material_id, record.rel_dir)  # discard_failed_import's removal
    assert _rows(runtime.kb.db, material_id) == (0, 0)


def test_the_upgrade_keeps_existing_answers_and_drops_the_cascade(tmp_path: Path) -> None:
    path = tmp_path / "knowledge.sqlite3"
    older = KnowledgeDatabase(path, modules=tuple(V4 if m.NAME == "wiki_execution" else m for m in MODULES))
    with older.write() as connection:
        connection.execute("INSERT INTO folders(id,name,rel_path,system,created_at) "
                           "VALUES ('fld-1','F','Materials/F',0,'t')")
        connection.execute("INSERT INTO materials(id,folder_id,kind,status,title,rel_dir,source_file,"
                           "created_at) VALUES ('mat-1','fld-1','pdf','ready','T','Materials/F/T',"
                           "'Materials/F/T/source.md','t')")
        connection.execute("INSERT INTO wiki_checkpoints(material_id,fingerprint,finished_profile) "
                           "VALUES ('mat-1','rev',NULL)")
        connection.execute("INSERT INTO wiki_checkpoint_answers(material_id,step_key,response,created_at,"
                           "profile) VALUES ('mat-1','k','{}','t','P')")
    older.close()
    db = KnowledgeDatabase(path)
    try:
        assert db.schema_versions()["wiki_execution"] == wiki_execution.VERSION
        assert _rows(db, "mat-1") == (1, 1)
        with db.write() as connection:
            connection.execute("DELETE FROM materials")
        assert _rows(db, "mat-1") == (1, 1)
        with db.write() as connection:  # the head still takes its answers with it
            connection.execute("DELETE FROM wiki_checkpoints WHERE material_id='mat-1'")
        assert _rows(db, "mat-1") == (0, 0)
    finally:
        db.close()


def test_the_upgrade_runs_again_after_a_start_killed_before_its_version_row(tmp_path: Path) -> None:
    path = tmp_path / "knowledge.sqlite3"
    KnowledgeDatabase(path, modules=tuple(V4 if m.NAME == "wiki_execution" else m for m in MODULES)).close()
    KnowledgeDatabase(path).close()
    connection = sqlite3.connect(path)
    with connection:
        connection.execute("UPDATE schema_versions SET version = 4 WHERE name = 'wiki_execution'")
    connection.close()
    db = KnowledgeDatabase(path)
    try:
        assert db.schema_versions()["wiki_execution"] == wiki_execution.VERSION
    finally:
        db.close()


def test_no_service_table_cascades_from_a_table_the_scan_rebuilds() -> None:
    """Class fix: anything not rebuilt from files must not vanish when the index is rebuilt."""
    db = KnowledgeDatabase(":memory:")
    try:
        with db.read() as connection:
            tables = [row[0] for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table'")]
            offending = [
                (table, reference["table"])
                for table in tables if table not in _REBUILT
                for reference in connection.execute(f'PRAGMA foreign_key_list("{table}")')
                if reference["table"] in _REBUILT and reference["on_delete"].upper() == "CASCADE"
            ]
    finally:
        db.close()
    assert offending == []
