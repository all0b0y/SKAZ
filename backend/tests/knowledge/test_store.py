"""Knowledge database: its own file, WAL, foreign keys, versioned schema modules."""
from __future__ import annotations

import sqlite3
from pathlib import Path
from types import SimpleNamespace

import pytest

from skaz.knowledge.store.database import KnowledgeDatabase
from skaz.knowledge.store.schema import MODULES, SchemaError


def test_new_database_is_a_separate_file_with_core_tables(tmp_path: Path) -> None:
    db = KnowledgeDatabase(tmp_path / "knowledge.sqlite3")
    try:
        with db.read() as connection:
            assert connection.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
            assert connection.execute("PRAGMA foreign_keys").fetchone()[0] == 1
            names = {row[0] for row in connection.execute("SELECT name FROM sqlite_master")}
        for table in ("folders", "materials", "fragments", "fragments_fts", "corrections", "pages",
                      "blocks", "blocks_fts", "citations", "edges", "aliases", "notifications",
                      "jobs", "chats", "messages", "settings", "library_state"):
            assert table in names, table
        assert db.schema_versions() == {module.NAME: module.VERSION for module in MODULES}
        assert not (tmp_path / "skaz.sqlite3").exists()
    finally:
        db.close()


def test_reopening_is_idempotent_and_keeps_rows(tmp_path: Path) -> None:
    path = tmp_path / "knowledge.sqlite3"
    db = KnowledgeDatabase(path)
    with db.write() as connection:
        connection.execute("INSERT INTO settings(key, value) VALUES ('wiki_language', '\"ru\"')")
    db.close()
    again = KnowledgeDatabase(path)
    try:
        with again.read() as connection:
            assert connection.execute("SELECT value FROM settings").fetchone()[0] == '"ru"'
    finally:
        again.close()


def test_area_modules_apply_in_order_and_upgrade(tmp_path: Path) -> None:
    path = tmp_path / "knowledge.sqlite3"
    v1 = SimpleNamespace(NAME="area", VERSION=1, SQL="CREATE TABLE IF NOT EXISTS area_items(id TEXT);")
    KnowledgeDatabase(path, modules=(*MODULES, v1)).close()
    v2 = SimpleNamespace(NAME="area", VERSION=2, SQL=v1.SQL,
                         UPGRADES={2: "ALTER TABLE area_items ADD COLUMN label TEXT;"})
    db = KnowledgeDatabase(path, modules=(*MODULES, v2))
    try:
        with db.read() as connection:
            columns = [row[1] for row in connection.execute("PRAGMA table_info(area_items)")]
        assert columns == ["id", "label"]
        assert db.schema_versions()["area"] == 2
    finally:
        db.close()


def test_newer_schema_than_this_build_is_refused(tmp_path: Path) -> None:
    path = tmp_path / "knowledge.sqlite3"
    KnowledgeDatabase(path).close()
    connection = sqlite3.connect(path)
    connection.execute("UPDATE schema_versions SET version = 99 WHERE name = 'core'")
    connection.commit()
    connection.close()
    with pytest.raises(SchemaError):
        KnowledgeDatabase(path)


def test_missing_upgrade_step_is_refused_not_guessed(tmp_path: Path) -> None:
    path = tmp_path / "knowledge.sqlite3"
    v1 = SimpleNamespace(NAME="area", VERSION=1, SQL="CREATE TABLE IF NOT EXISTS area_items(id TEXT);")
    KnowledgeDatabase(path, modules=(*MODULES, v1)).close()
    v3 = SimpleNamespace(NAME="area", VERSION=3, SQL=v1.SQL, UPGRADES={3: "SELECT 1;"})
    with pytest.raises(SchemaError):
        KnowledgeDatabase(path, modules=(*MODULES, v3))


def test_failed_write_rolls_back(tmp_path: Path) -> None:
    db = KnowledgeDatabase(tmp_path / "knowledge.sqlite3")
    try:
        with pytest.raises(sqlite3.IntegrityError), db.write() as connection:
            connection.execute("INSERT INTO settings(key, value) VALUES ('a', '1')")
            connection.execute("INSERT INTO settings(key, value) VALUES ('a', '2')")
        with db.read() as connection:
            assert connection.execute("SELECT COUNT(*) FROM settings").fetchone()[0] == 0
    finally:
        db.close()
