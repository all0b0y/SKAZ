"""Generated Notes retain the source revision they actually read, not finish-time state."""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

from skaz import note_store
from skaz import repository as repo
from skaz.agent.codex_runtime import CodexRuntime
from skaz.codex_schemas import CodexSettings
from skaz.db import Database
from skaz.gateways.codex_rpc import CodexRpc
from skaz.schemas import Segment


@pytest.mark.parametrize("changed_during_generation", [False, True])
async def test_generated_note_tracks_its_snapshot_revision(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, changed_during_generation: bool,
) -> None:
    db = Database(tmp_path / "source.sqlite")
    sid = repo.create_session(db, "Authored evidence").id
    repo.replace_chunk_segments(db, sid, 0, [
        Segment(id="first", start_ms=0, end_ms=1000, text="Original source."),
    ])
    service = CodexRuntime(db, tmp_path / "codex")
    fixture = Path(__file__).parent / "fixtures/codex_runtime_server.py"
    # External subprocess boundary: hold the authored provider before it consumes tools.
    release = tmp_path / "release"
    monkeypatch.setattr(service.connection, "rpc", lambda: CodexRpc(
        (sys.executable, str(fixture)), cwd=tmp_path, env={"FIXTURE_RELEASE": str(release)},
    ))
    service.connection.view.update(status="connected", models=[{"id": "fixture", "efforts": ["high"]}])
    try:
        await service.configure(CodexSettings(notes_enabled=True, notes_model="fixture", notes_effort="high"))
        with db.read() as c:
            revision = note_store.source_revision(c, sid)
        task = await service.notes(sid, "Russian", "detailed")
        async with asyncio.timeout(5):
            while service.queue.get(task["id"]).status != "running":
                await asyncio.sleep(0.01)
        if changed_during_generation:
            repo.replace_chunk_segments(db, sid, 1, [
                Segment(id="later", start_ms=2000, end_ms=3000, text="New source after snapshot."),
            ])
        release.touch()
        await service.dispatcher.idle()
        service._finalize(service.queue.get(task["id"]))
        note = note_store.list_notes(db, sid)[0]
        assert note.source_revision == revision
        assert note.stale is changed_during_generation
        assert note.citations[0].text.strip() == "Original source."
    finally:
        release.touch()
        await service.close()
        db.close()
