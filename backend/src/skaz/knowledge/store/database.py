"""One SQLite connection behind a lock, in the same shape as the legacy ``db.Database``.

Deliberately not a subclass: the legacy class executes the legacy schema.
"""
from __future__ import annotations

import sqlite3
import threading
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from pathlib import Path

from .schema import MODULES, SchemaModule, applied_versions, apply_schemas

KNOWLEDGE_DB_NAME = "knowledge.sqlite3"


class KnowledgeDatabase:
    def __init__(self, path: Path | str, *, modules: Sequence[SchemaModule] = MODULES) -> None:
        self._lock = threading.RLock()
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._connection = sqlite3.connect(str(path), check_same_thread=False)
        self._connection.row_factory = sqlite3.Row
        try:
            with self._lock:
                self._connection.execute("PRAGMA journal_mode=WAL")
                self._connection.execute("PRAGMA synchronous=FULL")
                self._connection.execute("PRAGMA fullfsync=ON")
                self._connection.execute("PRAGMA foreign_keys=ON")
                apply_schemas(self._connection, modules)
                self._connection.commit()
        except BaseException:
            self._connection.close()
            raise

    @contextmanager
    def write(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            try:
                yield self._connection
                self._connection.commit()
            except BaseException:
                self._connection.rollback()
                raise

    @contextmanager
    def read(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            yield self._connection

    def schema_versions(self) -> dict[str, int]:
        with self._lock:
            return applied_versions(self._connection)

    def close(self) -> None:
        with self._lock:
            self._connection.close()
