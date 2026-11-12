"""Usage is service data: scans must not erase it or cascade-delete it."""
NAME = "material_activity"
VERSION = 1
SQL = """
CREATE TABLE IF NOT EXISTS material_activity (
    library_id TEXT NOT NULL,
    material_id TEXT NOT NULL,
    opened_at TEXT,
    keep_until TEXT,
    PRIMARY KEY (library_id, material_id)
);
"""
