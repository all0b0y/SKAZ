"""Managed physical storage on real filesystem/SQLite boundaries.

The layout, group and root-move routes of the old interface are gone. What
remains live is an install whose earlier version switched the physical layout on:
the recorder still creates sessions in it, the speech area deletes them, and an
operation interrupted by a crash is recovered when the app starts.
"""
from __future__ import annotations

import os
import subprocess
import sys
from dataclasses import replace
from pathlib import Path

import httpx
import pytest

from skaz.config import AppConfig
from skaz.managed_storage import StorageConflict
from tests.conftest import FakeHttp
from tests.sessions_support import adelete, create_session, runtime_of, session_gone
from tests.test_session_files_recovery_api import open_client


@pytest.fixture
def config(tmp_path: Path) -> AppConfig:
    return replace(AppConfig(token="test-token", data_dir=tmp_path / "data"),
                   session_files_root=tmp_path / "files")


def enable_managed(target: object) -> None:
    """The state an earlier version left after the user switched the physical layout on."""
    assert runtime_of(target).storage.enable()["enabled"]


def seed(target: object) -> str:
    enable_managed(target)
    sid = create_session(target, "Original")
    assert runtime_of(target).session_files.project(sid)["state"] == "ready"
    return sid


async def test_delete_removes_database_files_and_journal(
    client: httpx.AsyncClient, config: AppConfig,
) -> None:
    assert config.session_files_root is not None
    sid = seed(client)
    await adelete(client, sid)
    assert session_gone(client, sid)
    assert not (config.session_files_root / "Ungrouped" / sid).exists()
    assert list((config.session_files_root / "Ungrouped").iterdir()) == []
    assert runtime_of(client).storage.pending() is None


@pytest.mark.parametrize("kind", ["external", "unknown", "symlink", "hardlink"])
async def test_delete_preserves_unowned_text_and_database(
    client: httpx.AsyncClient, config: AppConfig, kind: str,
) -> None:
    assert config.session_files_root is not None
    sid = seed(client)
    directory = config.session_files_root / "Ungrouped" / sid
    original = directory / "Transcript.md"
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
    # Managed deletion refuses with StorageConflict (the app maps it to 409 for HTTP callers).
    with pytest.raises(StorageConflict) as refused:
        await adelete(client, sid)
    assert str(config.data_dir) not in str(refused.value)
    assert not session_gone(client, sid)
    assert outside.read_bytes() == b"External original"
    assert directory.exists()


@pytest.mark.parametrize("boundary", ["quarantine", "capture", "unlink", "db"])
def test_process_death_during_delete_is_recovered_at_the_next_start(config: AppConfig, boundary: str) -> None:
    assert config.session_files_root is not None
    with open_client(config, FakeHttp()) as client:
        sid = seed(client)
    script = r"""
import os, sys
from pathlib import Path
from dataclasses import replace
from contextlib import contextmanager
from skaz.config import AppConfig
from skaz.managed_storage import StorageConflict
from skaz import managed_storage as storage
from tests.sessions_support import delete
from tests.test_session_files_recovery_api import open_client
config = replace(
    AppConfig(token="test-token", data_dir=Path(sys.argv[1])),
    session_files_root=Path(sys.argv[2]),
)
sid, boundary = sys.argv[3:5]
from tests.conftest import FakeHttp
with open_client(config, FakeHttp()) as client:
    if boundary == "quarantine":
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
    delete(client, sid)
"""
    result = subprocess.run(
        [sys.executable, "-c", script, str(config.data_dir), str(config.session_files_root), sid, boundary],
        capture_output=True,
        text=True,
        env={
            **os.environ,
            "PYTHONPATH": str(Path(__file__).parents[1] / "src")
            + os.pathsep
            + str(Path(__file__).parents[1]),
        },
        timeout=30,
    )
    assert result.returncode == 73, result.stderr
    # Starting the app finishes the interrupted operation; nothing waits for a button any more.
    with open_client(config, FakeHttp()) as client:
        assert runtime_of(client).storage.pending() is None
        assert session_gone(client, sid)
        assert list((config.session_files_root / "Ungrouped").iterdir()) == []
        # New recordings are not blocked by the crash.
        assert not session_gone(client, create_session(client, "After the crash"))
