"""Review 0.3.1 (C-06, C-10): the wiki_execution schema re-runs after an interrupted first start,
and the budget lookup by root is indexed."""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from types import SimpleNamespace

from skaz.knowledge.ingest.execution import ExecutionScope, ProcessingProfile, new_execution
from skaz.knowledge.ingest.jobs import JobRepository
from skaz.knowledge.store.database import KnowledgeDatabase
from skaz.knowledge.store.schema import MODULES, wiki_execution

PROFILE = ProcessingProfile("codex", "m", None, "ru")
#: ``wiki_execution`` as v3 shipped it (0.3.1 before the review): the root only inside ``data``.
V3 = SimpleNamespace(NAME="wiki_execution", VERSION=3, SQL="""
CREATE TABLE IF NOT EXISTS wiki_execution (
    job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
    data TEXT NOT NULL
);
""" + wiki_execution.UPGRADES[2] + wiki_execution.UPGRADES[3])


def _spent_row(db: KnowledgeDatabase, job_id: str, root: str, characters: int) -> None:
    data = json.loads(new_execution(PROFILE, job_id, root))
    data["totals"] = {"instruction_characters": characters, "completed_calls": 1}
    with db.write() as connection:
        connection.execute("INSERT INTO jobs(id,kind,target_id,state,created_at,updated_at) "
                           "VALUES (?,'ingest','m','done','t','t')", (job_id,))
        connection.execute("INSERT INTO wiki_execution(job_id, data) VALUES (?, ?)",
                           (job_id, json.dumps(data)))


def _forget_version(path: Path, name: str) -> None:
    connection = sqlite3.connect(path)
    with connection:
        connection.execute("DELETE FROM schema_versions WHERE name = ?", (name,))
    connection.close()


def test_a_first_start_killed_before_the_version_row_opens_again(tmp_path: Path) -> None:
    """The process dies after a module's tables were created but before its version row."""
    path = tmp_path / "knowledge.sqlite3"
    KnowledgeDatabase(path).close()
    for module in MODULES:
        if module.NAME in ("wiki_execution", "wiki_connections", "chats", "study", "web_search"):
            _forget_version(path, module.NAME)
    reopened = KnowledgeDatabase(path)
    try:
        assert reopened.schema_versions() == {module.NAME: module.VERSION for module in MODULES}
    finally:
        reopened.close()


def test_the_budget_of_a_root_is_read_by_index_and_counts_jobs_from_before_the_upgrade(
        tmp_path: Path) -> None:
    """C-10: ``spent()`` runs before every wiki call; it must not scan and parse every job ever run."""
    path = tmp_path / "knowledge.sqlite3"
    older = KnowledgeDatabase(path, modules=tuple(V3 if m.NAME == "wiki_execution" else m for m in MODULES))
    _spent_row(older, "job-root", "job-root", 100)
    _spent_row(older, "job-child", "job-root", 20)
    _spent_row(older, "job-other", "job-other", 5000)
    older.close()
    db = KnowledgeDatabase(path)
    try:
        child = JobRepository(db).create("m", profile=PROFILE, root_job_id="job-root")
        with db.write() as connection:  # the new job is charged too
            data = json.loads(connection.execute("SELECT data FROM wiki_execution WHERE job_id = ?",
                                                 (child.id,)).fetchone()[0])
            data["totals"] = {"message_characters": 3}
            connection.execute("UPDATE wiki_execution SET data = ? WHERE job_id = ?",
                               (json.dumps(data), child.id))
        statements: list[str] = []
        with db.read() as connection:
            connection.set_trace_callback(statements.append)
        try:
            spent = ExecutionScope(db, child.id, "job-root", PROFILE, budget=1000).spent()
        finally:
            with db.read() as connection:
                connection.set_trace_callback(None)
        assert spent == (123, 2)
        with db.read() as connection:
            plans = [" ".join(str(row[3]) for row in connection.execute(f"EXPLAIN QUERY PLAN {sql}"))
                     for sql in statements if sql.lstrip().upper().startswith("SELECT")]
        assert plans and all("SCAN wiki_execution" not in plan for plan in plans), plans
    finally:
        db.close()
