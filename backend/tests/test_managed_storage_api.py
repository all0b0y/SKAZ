"""Physical storage through HTTP and real filesystem/SQLite boundaries."""
from __future__ import annotations


import os
import subprocess
import sys
from dataclasses import replace
from pathlib import Path

import httpx
import pytest

from audiohelper.config import AppConfig
from tests.conftest import FakeHttp, make_wav
from tests.test_session_files_recovery_api import open_client


@pytest.fixture
def config(tmp_path: Path) -> AppConfig:
    return replace(AppConfig(token="test-token", data_dir=tmp_path / "data"),
                   session_files_root=tmp_path / "files")


async def enable(client: httpx.AsyncClient) -> None:
    response = await client.post("/storage/layout")
    assert response.status_code == 200, response.text
    assert response.json()["enabled"]


async def seed(client: httpx.AsyncClient) -> tuple[str, bytes]:
    await enable(client)
    sid = (await client.post("/sessions", json={"title": "Original"})).json()["id"]
    body = make_wav(.1)
    result = await client.post(f"/sessions/{sid}/audio/store?sequence=0&start_ms=0&end_ms=100", content=body)
    assert result.status_code == 201, result.text
    result = await client.post(f"/sessions/{sid}/files")
    assert result.json()["state"] == "ready", result.text
    return sid, body


def groups(sid: str, *, grouped: bool = True) -> dict:
    return {"version": 1, "groups": [{"id": "a" * 32, "name": "Study", "tag": "study"}] if grouped else [],
            "membership": {sid: "a" * 32 if grouped else None}}


async def test_physical_groups_move_audio_and_delete_group_keeps_session(client, config):
    sid, body = await seed(client)
    source = config.session_files_root / "Ungrouped" / sid
    assert (source / "audio/000000.wav").read_bytes() == body
    assert not (config.audio_dir / sid).exists()
    result = await client.put("/storage/groups", json={"data": groups(sid), "expected_revision": 0})
    assert result.status_code == 200, result.text
    target = config.session_files_root / ("Group-" + "a" * 32) / sid
    assert not source.exists()
    assert (target / "audio/000000.wav").read_bytes() == body
    assert (await client.get(f"/sessions/{sid}/audio/0")).content == body
    assert (await client.post(f"/sessions/{sid}/files")).json()["state"] == "ready"
    result = await client.put("/storage/groups", json={"data": groups(sid, grouped=False), "expected_revision": 1})
    assert result.status_code == 200, result.text
    assert not target.parent.exists()
    assert (source / "audio/000000.wav").read_bytes() == body
    assert (await client.get(f"/sessions/{sid}")).status_code == 200


async def test_delete_removes_database_audio_and_journal(client, config):
    sid, _ = await seed(client)
    result = await client.delete(f"/sessions/{sid}")
    assert result.status_code == 200, result.text
    assert (await client.get(f"/sessions/{sid}")).status_code == 404
    assert not (config.session_files_root / "Ungrouped" / sid).exists()
    assert list((config.session_files_root / "Ungrouped").iterdir()) == []
    assert (await client.get("/storage/layout")).json()["pending"] is None


@pytest.mark.parametrize("kind", ["external", "unknown", "symlink", "hardlink"])
async def test_delete_preserves_unowned_audio_and_database(client, config, kind):
    sid, _ = await seed(client)
    directory = config.session_files_root / "Ungrouped" / sid
    original = directory / "audio/000000.wav"
    outside = config.data_dir / "external.wav"
    outside.write_bytes(b"External original")
    if kind == "external":
        original.write_bytes(b"Modified")
    elif kind == "unknown":
        (directory / "personal.txt").write_text("Personal")
    else:
        original.unlink()
        if kind == "symlink":
            original.symlink_to(outside)
        else:
            original.hardlink_to(outside)
    response = await client.delete(f"/sessions/{sid}")
    assert response.status_code == 409
    assert str(config.data_dir) not in response.text
    assert (await client.get(f"/sessions/{sid}")).status_code == 200
    assert outside.read_bytes() == b"External original"
    assert directory.exists()


async def test_stale_groups_and_colliding_destination_do_not_move(client, config):
    sid, body = await seed(client)
    payload = {"data": groups(sid), "expected_revision": 4}
    assert (await client.put("/storage/groups", json=payload)).status_code == 409
    dest = config.session_files_root / ("Group-" + "a" * 32)
    dest.mkdir()
    (dest / "external.txt").write_text("Untouched")
    payload["expected_revision"] = 0
    response = await client.put("/storage/groups", json=payload)
    assert response.status_code == 409, response.text
    assert (dest / "external.txt").read_text() == "Untouched"
    assert (await client.get(f"/sessions/{sid}/audio/0")).content == body


async def test_switch_requires_empty_database_and_never_deletes_old_session(client):
    sid = (await client.post("/sessions", json={"title": "Keep me"})).json()["id"]
    assert (await client.post("/storage/layout")).status_code == 409
    assert (await client.get(f"/sessions/{sid}")).status_code == 200
    assert not (await client.get("/storage/layout")).json()["enabled"]


@pytest.mark.parametrize("boundary", ["move", "quarantine", "capture", "unlink", "db"])
def test_real_process_death_recovery(config, boundary):
    with open_client(config, FakeHttp()) as client:
        assert client.post("/storage/layout").status_code == 200
        sid = client.post("/sessions", json={"title": "Crash"}).json()["id"]
        body = make_wav(.1)
        assert client.post(f"/sessions/{sid}/audio/store?sequence=0&start_ms=0&end_ms=100", content=body).status_code == 201
        assert client.post(f"/sessions/{sid}/files").status_code == 200
    script = r'''
import os, sys
from pathlib import Path
from dataclasses import replace
from contextlib import contextmanager
from audiohelper.config import AppConfig
from audiohelper import managed_storage as storage
from tests.test_session_files_recovery_api import open_client
config = replace(AppConfig(token="test-token", data_dir=Path(sys.argv[1])), session_files_root=Path(sys.argv[2]))
sid, boundary = sys.argv[3:5]
from tests.conftest import FakeHttp
with open_client(config, FakeHttp()) as client:
    if boundary in ("move", "quarantine"):
        original = storage._rename
        def fail(*args, **kwargs):
            original(*args, **kwargs)
            os._exit(73)
        storage._rename = fail
    elif boundary == "capture":
        original = storage._rename_at
        def fail(*args, **kwargs):
            original(*args, **kwargs)
            os.fsync(args[0])
            os._exit(73)
        storage._rename_at = fail
    elif boundary == "unlink":
        original = os.unlink
        def fail(path, *args, **kwargs):
            original(path, *args, **kwargs)
            if str(path).endswith(".deleting"):
                os.fsync(kwargs["dir_fd"])
                os._exit(73)
        os.unlink = fail
    else:
        db = client.app.state.runtime.db
        original = db.write
        @contextmanager
        def fail():
            with original() as c:
                yield c
            with db.read() as c:
                deleted = c.execute("SELECT 1 FROM sessions WHERE id=?", (sid,)).fetchone() is None
            if deleted:
                os._exit(73)
        db.write = fail
    if boundary == "move":
        client.put("/storage/groups", json={"expected_revision": 0, "data": {"version": 1, "groups": [{"id": "a"*32,"name":"Study","tag":""}], "membership": {sid:"a"*32}}})
    else:
        client.delete("/sessions/"+sid)
'''
    result = subprocess.run([sys.executable, "-c", script, str(config.data_dir),
                             str(config.session_files_root), sid, boundary], capture_output=True, text=True,
                            env={**os.environ, "PYTHONPATH": str(Path(__file__).parents[1] / "src") + os.pathsep + str(Path(__file__).parents[1])}, timeout=30)
    assert result.returncode == 73, result.stderr
    with open_client(config, FakeHttp()) as client:
        assert client.get("/storage/layout").json()["pending"] is not None
        assert client.post("/sessions", json={"title": "Blocked"}).status_code == 409
        recovered = client.post("/storage/recover")
        assert recovered.status_code == 200, recovered.text
        assert client.get("/storage/layout").json()["pending"] is None
        if boundary == "move":
            assert client.get(f"/sessions/{sid}/audio/0").content == body
        else:
            assert client.get(f"/sessions/{sid}").status_code == 404
            assert list((config.session_files_root / "Ungrouped").iterdir()) == []
        assert client.post("/storage/recover").status_code == 200
