"""Real process-death recovery through HTTP and isolated filesystem boundaries."""
from __future__ import annotations

import subprocess
import sys
from dataclasses import replace
from pathlib import Path

import httpx
import pytest
from starlette.testclient import TestClient

from audiohelper.app import create_app
from audiohelper.config import AppConfig
from audiohelper.secrets import MemorySecretStore
from tests.conftest import FakeHttp
from tests.test_native_live_ws import AUTH
from tests.test_session_files_api import seed_note

# No graceful cleanup: terminate immediately after a real publication syscall.
CRASH_WRITER = r'''
import ctypes
import os
import sqlite3
import stat
import sys
from pathlib import Path
from starlette.testclient import TestClient
from audiohelper.app import create_app
from audiohelper.config import AppConfig
from audiohelper.secrets import MemorySecretStore
from tests.conftest import FakeHttp

phase = sys.argv[4]
native_connect = sqlite3.connect
class CrashConnection(sqlite3.Connection):
    crash_on_commit = False
    def execute(self, sql, *args, **kwargs):
        if phase == "manifest" and sql.startswith("INSERT OR REPLACE INTO file_projections"):
            self.crash_on_commit = True
        if phase == "note_commit" and sql.lstrip().startswith("UPDATE notes SET"):
            self.crash_on_commit = True
        return super().execute(sql, *args, **kwargs)
    def commit(self):
        super().commit()
        if self.crash_on_commit:
            os._exit(73)
def connect(*args, **kwargs):
    return native_connect(*args, **kwargs, factory=CrashConnection)
sqlite3.connect = connect
config = AppConfig(token="test-token", data_dir=Path(sys.argv[1]), session_files_root=Path(sys.argv[2]))
app = create_app(config, secret_store=MemorySecretStore(), http_client=FakeHttp().client())
with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as http:
    native_library = ctypes.CDLL
    native_fsync = os.fsync
    def crash_fsync(descriptor):
        native_fsync(descriptor)
        if phase == "prepared" and stat.S_ISREG(os.fstat(descriptor).st_mode):
            os._exit(73)
    def crash_library(*args, **kwargs):
        library = native_library(*args, **kwargs)
        symbol = "renameatx_np" if sys.platform == "darwin" else "renameat2"
        rename = getattr(library, symbol)
        def crash_rename(*values):
            result = rename(*values)
            if result == 0 and phase != "manifest":
                os.fsync(values[0])
                os._exit(73)
            return result
        setattr(library, symbol, crash_rename)
        return library
    # Also catches the old hardlink publication, exposing its stranded nlink=2.
    native_link = os.link
    def crash_link(*args, **kwargs):
        native_link(*args, **kwargs)
        os.fsync(kwargs["dst_dir_fd"])
        os._exit(73)
    ctypes.CDLL = crash_library
    os.link = crash_link
    os.fsync = crash_fsync
    auth = {"Authorization": "Bearer test-token"}
    if phase == "note_commit":
        response = http.patch(f"/sessions/{sys.argv[3]}/notes/{sys.argv[5]}", headers=auth,
                              json={"expected_revision": 1, "content": "Durable edit before crash"})
    else:
        response = http.post(f"/sessions/{sys.argv[3]}/files", headers=auth)
    raise RuntimeError(f"Crash boundary not reached: {response.status_code}")
'''


@pytest.fixture
def config(tmp_path: Path) -> AppConfig:
    return replace(AppConfig(token="test-token", data_dir=tmp_path / "data"),
                   session_files_root=tmp_path / "files")


def open_client(config: AppConfig, outbound: FakeHttp) -> TestClient:
    return TestClient(create_app(config, secret_store=MemorySecretStore(), http_client=outbound.client()),
                      base_url="http://127.0.0.1", client=("127.0.0.1", 50000), headers=AUTH)


@pytest.mark.parametrize("phase", ["first", "exchange", "conflict", "prepared", "manifest"])
def test_process_death_at_publication_is_reported_and_retry_preserves_files(
    config: AppConfig, outbound: FakeHttp, phase: str,
) -> None:
    assert config.session_files_root is not None
    with open_client(config, outbound) as http:
        sid = http.post("/sessions", json={"title": "Before crash"}).json()["id"]
        directory = config.session_files_root / "Ungrouped" / sid
        if phase != "first":
            assert http.post(f"/sessions/{sid}/files").json()["state"] == "ready"
        http.patch(f"/sessions/{sid}", json={"title": "After crash"}).raise_for_status()
        if phase == "conflict":
            (directory / "Transcript.md").write_text("External author version")
    child = subprocess.run(
        [sys.executable, "-c", CRASH_WRITER,
         str(config.data_dir), str(config.session_files_root), sid, phase],
        capture_output=True, text=True, timeout=20, cwd=Path(__file__).resolve().parents[1],
    )
    assert child.returncode == 73, child.stderr
    before = {p.name: p.read_bytes() for p in directory.iterdir()}
    with open_client(config, outbound) as http:
        recovered = http.get(f"/sessions/{sid}/files").json()
        assert recovered["state"] in ("pending", "conflict"), recovered
        assert {p.name: p.read_bytes() for p in directory.iterdir()} == before
        if phase not in ("first", "manifest"):
            assert recovered["conflicts"]
        result = http.post(f"/sessions/{sid}/files").json()
        assert result["state"] in ("ready", "conflict"), result
        for name, body in before.items():
            if phase == "prepared" and name == "Transcript.md":
                continue  # the manifest still owns the old canonical version
            assert (directory / name).read_bytes() == body
        assert "After crash" in (directory / result["files"][0]["path"]).read_text()
        again = http.post(f"/sessions/{sid}/files").json()
        assert again["conflicts"] == result["conflicts"]
        after_retry = {p.name: p.read_bytes() for p in directory.iterdir()}
    with open_client(config, outbound) as http:
        status = http.get(f"/sessions/{sid}/files").json()
        assert status["state"] == result["state"]
        assert status["conflicts"] == result["conflicts"]
        assert {p.name: p.read_bytes() for p in directory.iterdir()} == after_retry
        assert http.get(f"/sessions/{sid}").json()["session"]["title"] == "After crash"
    assert outbound.requests == []


def test_restart_invalidates_projection_when_source_changed_before_export(
    config: AppConfig, outbound: FakeHttp,
) -> None:
    with open_client(config, outbound) as http:
        sid = http.post("/sessions", json={"title": "Projected"}).json()["id"]
        assert http.post(f"/sessions/{sid}/files").json()["state"] == "ready"
        http.patch(f"/sessions/{sid}", json={"title": "Not projected"}).raise_for_status()
    assert config.session_files_root is not None
    target = config.session_files_root / "Ungrouped" / sid / "Transcript.md"
    original = target.read_bytes()
    with open_client(config, outbound) as http:
        assert http.get(f"/sessions/{sid}/files").json()["state"] == "pending"
        assert target.read_bytes() == original
        assert http.post(f"/sessions/{sid}/files").json()["state"] == "ready"
        assert "Not projected" in target.read_text()
    assert outbound.requests == []


async def test_note_commit_before_process_death_is_recoverable_without_generation(
    client: httpx.AsyncClient, config: AppConfig, outbound: FakeHttp,
) -> None:
    sid, nid = await seed_note(client, outbound)
    assert config.session_files_root is not None
    target = config.session_files_root / "Ungrouped" / sid / f"Note-{nid}.md"
    original = target.read_bytes()
    child = subprocess.run(
        [sys.executable, "-c", CRASH_WRITER,
         str(config.data_dir), str(config.session_files_root), sid, "note_commit", nid],
        capture_output=True, text=True, timeout=20, cwd=Path(__file__).resolve().parents[1],
    )
    assert child.returncode == 73, child.stderr
    outbound.requests.clear()
    with open_client(config, outbound) as http:
        assert http.get(f"/sessions/{sid}/files").json()["state"] == "pending"
        note = http.get(f"/sessions/{sid}/notes").json()["notes"][0]
        assert note["content"] == "Durable edit before crash"
        assert note["revision"] == 2
        assert target.read_bytes() == original
        assert http.post(f"/sessions/{sid}/files").json()["state"] == "ready"
        assert "Durable edit before crash" in target.read_text()
    assert outbound.requests == []


@pytest.mark.parametrize("kind", ["symlink", "hardlink", "directory"])
def test_restart_rejects_unsafe_recovery_artifact_without_following_or_deleting(
    config: AppConfig, outbound: FakeHttp, tmp_path: Path, kind: str,
) -> None:
    with open_client(config, outbound) as http:
        sid = http.post("/sessions", json={"title": "Safe"}).json()["id"]
        assert http.post(f"/sessions/{sid}/files").json()["state"] == "ready"
    assert config.session_files_root is not None
    directory = config.session_files_root / "Ungrouped" / sid
    artifact = directory / f"Transcript.recovery-{'a' * 32}.md"
    outside = tmp_path / "outside.md"
    outside.write_text("Private external data")
    if kind == "symlink":
        artifact.symlink_to(outside)
    elif kind == "hardlink":
        artifact.hardlink_to(outside)
    else:
        artifact.mkdir()
    original = (directory / "Transcript.md").read_bytes()
    with open_client(config, outbound) as http:
        for response in (http.get(f"/sessions/{sid}/files"), http.post(f"/sessions/{sid}/files")):
            assert response.json()["state"] == "error"
            assert "Private" not in response.text
            assert str(outside) not in response.text
        assert (directory / "Transcript.md").read_bytes() == original
        assert outside.read_text() == "Private external data"
        assert artifact.exists()


def test_startup_does_not_create_directories_or_scan_unknown_sessions(
    config: AppConfig, outbound: FakeHttp,
) -> None:
    assert config.session_files_root is not None
    with open_client(config, outbound) as http:
        sid = http.post("/sessions", json={"title": "Not exported"}).json()["id"]
    with open_client(config, outbound) as http:
        assert http.get(f"/sessions/{sid}/files").json()["state"] == "pending"
        assert not config.session_files_root.exists()
    unknown = config.session_files_root / "Ungrouped" / ("b" * 32)
    unknown.mkdir(parents=True)
    artifact = unknown / f"Transcript.recovery-{'c' * 32}.md"
    artifact.write_text("Unrelated external file")
    with open_client(config, outbound) as http:
        assert http.get(f"/sessions/{sid}/files").json()["state"] == "pending"
        assert artifact.read_text() == "Unrelated external file"
        assert not (unknown.parent / sid).exists()
