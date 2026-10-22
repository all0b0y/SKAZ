"""Job metadata survives a reopen; a pre-profile database keeps its old jobs."""
from __future__ import annotations

from pathlib import Path

from skaz.knowledge.ingest.execution import ProcessingProfile
from skaz.knowledge.ingest.jobs import JobRepository
from skaz.knowledge.store.database import KnowledgeDatabase
from skaz.knowledge.store.schema import MODULES


def test_older_database_gains_execution_metadata_without_rewriting_its_jobs(tmp_path: Path) -> None:
    path = tmp_path / "knowledge.sqlite3"
    older = KnowledgeDatabase(path, modules=tuple(m for m in MODULES if m.NAME != "wiki_execution"))
    with older.write() as connection:
        connection.execute(
            "INSERT INTO jobs(id,kind,target_id,state,created_at,updated_at) "
            "VALUES ('job-old','ingest','material-old','done','t','t')",
        )
        connection.execute("INSERT INTO ingest_jobs(job_id) VALUES ('job-old')")
    older.close()
    current = KnowledgeDatabase(path)
    try:
        jobs = JobRepository(current)
        old = jobs.get("job-old")
        assert old is not None and old.state == "done" and old.execution is None
        chosen = ProcessingProfile("codex", "selected-model", "high", "ru")
        queued = jobs.create("material-new", state="queued", profile=chosen)
    finally:
        current.close()
    reopened = KnowledgeDatabase(path)
    try:
        saved = JobRepository(reopened).get(queued.id)
        assert saved is not None and saved.state == "queued" and saved.execution is not None
        assert saved.execution.profile == ProcessingProfile("codex", "selected-model", "high", "ru")
        assert saved.execution.usage.calls == 0
    finally:
        reopened.close()
