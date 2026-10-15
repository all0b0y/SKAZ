"""Schema registry: every area owns a module with ``NAME``, ``VERSION`` and ``SQL``.

Modules apply in registry order. A fresh database runs ``SQL`` (idempotent
``CREATE … IF NOT EXISTS``) and records ``VERSION``. An existing database at a
lower version runs the module's ``UPGRADES[v]`` for every ``v`` above the
stored version, in order; a missing step or a database newer than this build
is refused rather than guessed. Areas add their module to ``MODULES`` (one
line, append-only) and never edit another area's module.
"""
from __future__ import annotations

import sqlite3
from collections.abc import Mapping, Sequence
from typing import Protocol

from . import core, decisions, ingest, service, speech


class SchemaModule(Protocol):
    @property
    def NAME(self) -> str: ...
    @property
    def VERSION(self) -> int: ...
    @property
    def SQL(self) -> str: ...


class SchemaError(RuntimeError):
    pass


#: Registry order is application order. Append new area modules at the end.
MODULES: tuple[SchemaModule, ...] = (core, service, ingest, decisions, speech)

_VERSIONS_SQL = """
CREATE TABLE IF NOT EXISTS schema_versions (
    name    TEXT PRIMARY KEY,
    version INTEGER NOT NULL CHECK (version >= 1)
);
"""


def applied_versions(connection: sqlite3.Connection) -> dict[str, int]:
    connection.executescript(_VERSIONS_SQL)
    return {row[0]: int(row[1]) for row in connection.execute("SELECT name, version FROM schema_versions")}


def apply_schemas(connection: sqlite3.Connection, modules: Sequence[SchemaModule] = MODULES) -> None:
    """Bring every module to its version. Caller commits; DDL errors propagate."""
    names = [module.NAME for module in modules]
    if len(set(names)) != len(names):
        raise SchemaError("Schema module names must be unique.")
    current = applied_versions(connection)
    for module in modules:
        stored = current.get(module.NAME)
        if stored is None:
            connection.executescript(module.SQL)
        elif stored > module.VERSION:
            raise SchemaError(
                f"The knowledge database was written by a newer SKAZ ({module.NAME} v{stored})."
            )
        elif stored < module.VERSION:
            upgrades: Mapping[int, str] = getattr(module, "UPGRADES", {})
            for version in range(stored + 1, module.VERSION + 1):
                if version not in upgrades:
                    raise SchemaError(f"No upgrade path for {module.NAME} to v{version}.")
                connection.executescript(upgrades[version])
        else:
            continue
        connection.execute(
            "INSERT INTO schema_versions(name, version) VALUES (?, ?) "
            "ON CONFLICT(name) DO UPDATE SET version = excluded.version",
            (module.NAME, module.VERSION),
        )
