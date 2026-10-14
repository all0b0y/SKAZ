"""Index tables rebuilt from the library files (folders, materials, pages, blocks…)."""
from __future__ import annotations

NAME = "core"
VERSION = 1

_TOKENIZE = "tokenize='unicode61 remove_diacritics 2'"

SQL = f"""
CREATE TABLE IF NOT EXISTS folders (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    rel_path   TEXT NOT NULL UNIQUE,
    system     INTEGER NOT NULL DEFAULT 0 CHECK (system IN (0, 1)),
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS materials (
    id          TEXT PRIMARY KEY,
    folder_id   TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL,
    status      TEXT NOT NULL,
    title       TEXT NOT NULL,
    rel_dir     TEXT NOT NULL UNIQUE,
    source_file TEXT NOT NULL,
    origin      TEXT,
    languages   TEXT NOT NULL DEFAULT '[]',
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS materials_by_folder ON materials(folder_id, created_at);

CREATE TABLE IF NOT EXISTS fragments (
    material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
    seg         INTEGER NOT NULL CHECK (seg >= 1),
    ordinal     INTEGER NOT NULL,
    text        TEXT NOT NULL,
    start_ms    INTEGER,
    end_ms      INTEGER,
    speaker     TEXT,
    page        INTEGER,
    idx         INTEGER,
    PRIMARY KEY (material_id, seg)
);

CREATE VIRTUAL TABLE IF NOT EXISTS fragments_fts USING fts5(
    text, material_id UNINDEXED, seg UNINDEXED, {_TOKENIZE}
);

-- Recognition corrections (filled by the corrections area from corrections.json).
CREATE TABLE IF NOT EXISTS corrections (
    id          TEXT PRIMARY KEY,
    material_id TEXT NOT NULL,
    seg         INTEGER NOT NULL,
    before      TEXT NOT NULL,
    after       TEXT NOT NULL,
    reason      TEXT,
    confidence  REAL,
    state       TEXT NOT NULL,
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS corrections_by_fragment ON corrections(material_id, seg);

CREATE TABLE IF NOT EXISTS pages (
    id          TEXT PRIMARY KEY,
    kind        TEXT NOT NULL CHECK (kind IN ('concept', 'note', 'folder', 'analysis')),
    title       TEXT NOT NULL,
    rel_path    TEXT NOT NULL UNIQUE,
    original    TEXT,
    language    TEXT NOT NULL,
    file_sha256 TEXT NOT NULL,
    indexed_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS page_folders (
    page_id   TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    folder_id TEXT NOT NULL,
    PRIMARY KEY (page_id, folder_id)
);

CREATE TABLE IF NOT EXISTS page_sources (
    page_id     TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    material_id TEXT NOT NULL,
    PRIMARY KEY (page_id, material_id)
);

-- marked = 1: a SKAZ block with a marker; 0: unmarked user text (owner user, kind user_note).
CREATE TABLE IF NOT EXISTS blocks (
    page_id  TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    block_id TEXT NOT NULL,
    ordinal  INTEGER NOT NULL,
    section  TEXT,
    kind     TEXT NOT NULL CHECK (kind IN ('from_source', 'connection', 'explanation', 'user_note')),
    owner    TEXT NOT NULL CHECK (owner IN ('agent', 'user', 'user_edited')),
    hash     TEXT NOT NULL,
    text     TEXT NOT NULL,
    marked   INTEGER NOT NULL CHECK (marked IN (0, 1)),
    PRIMARY KEY (page_id, block_id)
);

CREATE VIRTUAL TABLE IF NOT EXISTS blocks_fts USING fts5(
    text, page_id UNINDEXED, block_id UNINDEXED, {_TOKENIZE}
);

CREATE TABLE IF NOT EXISTS citations (
    page_id     TEXT NOT NULL,
    block_id    TEXT NOT NULL,
    ordinal     INTEGER NOT NULL,
    material_id TEXT NOT NULL,
    seg         INTEGER NOT NULL,
    PRIMARY KEY (page_id, block_id, ordinal),
    FOREIGN KEY (page_id, block_id) REFERENCES blocks(page_id, block_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS citations_by_fragment ON citations(material_id, seg);

-- Graph edges (filled by the connections area).
CREATE TABLE IF NOT EXISTS edges (
    src_kind TEXT NOT NULL,
    src_id   TEXT NOT NULL,
    dst_kind TEXT NOT NULL,
    dst_id   TEXT NOT NULL,
    kind     TEXT NOT NULL,
    page_id  TEXT,
    block_id TEXT,
    PRIMARY KEY (src_kind, src_id, dst_kind, dst_id, kind)
);
CREATE INDEX IF NOT EXISTS edges_by_target ON edges(dst_kind, dst_id);

CREATE TABLE IF NOT EXISTS aliases (
    page_id   TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    alias     TEXT NOT NULL,
    alias_key TEXT NOT NULL,
    PRIMARY KEY (page_id, alias_key)
);
CREATE INDEX IF NOT EXISTS aliases_by_key ON aliases(alias_key);
"""
