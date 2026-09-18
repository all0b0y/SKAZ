"""Deletion uses real HTTP/disk and never treats a filename as ownership."""
from __future__ import annotations

import asyncio
import os
import subprocess
import sys
import threading
from dataclasses import replace
from pathlib import Path

import httpx
import pytest

from audiohelper import session_files
from audiohelper.config import AppConfig
from tests.conftest import FakeHttp
from tests.test_session_files_api import seed_note
from tests.test_session_files_recovery_api import open_client


@pytest.fixture
def config(tmp_path: Path) -> AppConfig:
    return replace(AppConfig(token="test-token", data_dir=tmp_path / "data"),
                   session_files_root=tmp_path / "files")


async def test_delete_removes_owned_markdown_and_primary_session(
    client: httpx.AsyncClient, config: AppConfig, outbound: FakeHttp,
) -> None:
    sid, _ = await seed_note(client, outbound)
    assert config.session_files_root is not None
    directory = config.session_files_root / "Ungrouped" / sid
    assert len(list(directory.iterdir())) == 2
    calls = len(outbound.requests)
    response = await client.delete(f"/sessions/{sid}")
    assert response.status_code == 200, response.text
    assert not directory.exists()
    assert (await client.get(f"/sessions/{sid}")).status_code == 404
    assert not (config.audio_dir / sid).exists()
    assert len(outbound.requests) == calls


@pytest.mark.parametrize("kind", ["external", "unknown", "recovery", "conflict", "symlink",
                                 "hardlink", "directory"])
async def test_delete_refuses_unowned_files_and_keeps_audio_notes_and_manifest(
    client: httpx.AsyncClient, config: AppConfig, outbound: FakeHttp, kind: str,
) -> None:
    sid, nid = await seed_note(client, outbound)
    assert config.session_files_root is not None
    directory = config.session_files_root / "Ungrouped" / sid
    canonical = directory / "Transcript.md"
    original = canonical.read_bytes()
    outside = config.data_dir / "external.md"
    outside.write_text("External bytes")
    if kind == "external":
        canonical.write_text("External bytes")
    elif kind in ("unknown", "recovery", "conflict"):
        name = "personal.txt" if kind == "unknown" else f"Transcript.{kind}-{'a' * 32}.md"
        (directory / name).write_text("External bytes")
    else:
        canonical.unlink()
        if kind == "symlink":
            canonical.symlink_to(outside)
        elif kind == "hardlink":
            canonical.hardlink_to(outside)
        else:
            canonical.mkdir()
    before = sorted(p.name for p in directory.iterdir())
    audio = (await client.get(f"/sessions/{sid}/audio/0")).content
    response = await client.delete(f"/sessions/{sid}")
    assert response.status_code == 409, response.text
    assert str(config.data_dir) not in response.text
    assert sorted(p.name for p in directory.iterdir()) == before
    assert outside.read_text() == "External bytes"
    assert (await client.get(f"/sessions/{sid}")).json()["notes_list"][0]["id"] == nid
    assert (await client.get(f"/sessions/{sid}/audio/0")).content == audio
    # Resolve only the test-owned obstacle; unchanged canonical is still owned.
    for path in directory.iterdir():
        if path.name not in ("Transcript.md", f"Note-{nid}.md"):
            path.unlink()
    if kind in ("external", "symlink", "hardlink", "directory"):
        if canonical.is_dir():
            canonical.rmdir()
        else:
            canonical.unlink()
        canonical.write_bytes(original)
    assert (await client.delete(f"/sessions/{sid}")).status_code == 200
    assert not directory.exists()


async def test_missing_file_during_cleanup_does_not_drop_primary_data(
    client: httpx.AsyncClient, config: AppConfig, outbound: FakeHttp,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sid, _ = await seed_note(client, outbound)
    assert config.session_files_root is not None
    directory = config.session_files_root / "Ungrouped" / sid
    original = session_files._rename_at
    external = directory / "late.txt"

    def vanish(fd: int, source: str, destination: str, *, exchange: bool) -> None:
        external.write_text("Must survive")
        os.unlink(source, dir_fd=fd)
        original(fd, source, destination, exchange=exchange)

    with monkeypatch.context() as patcher:
        patcher.setattr(session_files, "_rename_at", vanish)
        response = await client.delete(f"/sessions/{sid}")
    assert response.status_code == 409, response.text
    assert (await client.get(f"/sessions/{sid}")).status_code == 200
    assert (await client.get(f"/sessions/{sid}/audio/0")).status_code == 200
    assert external.read_text() == "Must survive"


@pytest.mark.parametrize("second_canonical", [False, True])
async def test_replacement_at_rename_boundary_is_preserved(
    client: httpx.AsyncClient, config: AppConfig, monkeypatch: pytest.MonkeyPatch,
    second_canonical: bool,
) -> None:
    sid = (await client.post("/sessions", json={"title": "Boundary"})).json()["id"]
    (await client.post(f"/sessions/{sid}/files")).raise_for_status()
    assert config.session_files_root is not None
    directory = config.session_files_root / "Ungrouped" / sid
    canonical = directory / "Transcript.md"
    original = session_files._rename_at

    def replace_at_boundary(fd: int, source: str, destination: str, *, exchange: bool) -> None:
        if source == "Transcript.md":
            replacement = directory / "editor.tmp"
            replacement.write_text("External first")
            replacement.replace(canonical)
        original(fd, source, destination, exchange=exchange)
        if source == "Transcript.md" and second_canonical:
            canonical.write_text("External second")

    with monkeypatch.context() as patcher:
        patcher.setattr(session_files, "_rename_at", replace_at_boundary)
        response = await client.delete(f"/sessions/{sid}")
    assert response.status_code == 409
    assert (await client.get(f"/sessions/{sid}")).status_code == 200
    contents = [p.read_text() for p in directory.iterdir()]
    assert "External first" in contents
    if second_canonical:
        assert canonical.read_text() == "External second"
        assert (await client.get(f"/sessions/{sid}/files")).json()["conflicts"]
    else:
        assert canonical.read_text() == "External first"


@pytest.mark.parametrize("changed", ["disabled", "different", "offline"])
def test_root_change_does_not_orphan_ownership_and_original_root_can_retry(
    config: AppConfig, outbound: FakeHttp, changed: str,
) -> None:
    assert config.session_files_root is not None
    with open_client(config, outbound) as http:
        sid = http.post("/sessions", json={"title": "Root"}).json()["id"]
        http.post(f"/sessions/{sid}/files").raise_for_status()
    root = config.session_files_root
    hidden = root.with_name("offline")
    if changed == "offline":
        root.rename(hidden)
        other = config
    else:
        other = replace(config, session_files_root=None if changed == "disabled"
                        else root.with_name("new-root"))
    with open_client(other, outbound) as http:
        assert http.delete(f"/sessions/{sid}").status_code == 409
        assert http.get(f"/sessions/{sid}").status_code == 200
    if changed == "offline":
        hidden.rename(root)
    with open_client(config, outbound) as http:
        assert http.delete(f"/sessions/{sid}").status_code == 200
    assert not (root / "Ungrouped" / sid).exists()


CRASH_DELETE = r'''
import os, sys
from pathlib import Path
from audiohelper import session_files
from audiohelper.config import AppConfig
from tests.conftest import FakeHttp
from tests.test_session_files_recovery_api import open_client
config = AppConfig(token="test-token", data_dir=Path(sys.argv[1]), session_files_root=Path(sys.argv[2]))
with open_client(config, FakeHttp()) as http:
    rename = session_files._rename_at
    def crash(fd, source, destination, *, exchange):
        rename(fd, source, destination, exchange=exchange)
        os.fsync(fd)
        os._exit(73)
    session_files._rename_at = crash
    response = http.delete(f"/sessions/{sys.argv[3]}")
    raise RuntimeError(f"Crash boundary not reached: {response.status_code}")
'''


def test_process_death_during_delete_preserves_source_and_recovery(
    config: AppConfig, outbound: FakeHttp,
) -> None:
    assert config.session_files_root is not None
    with open_client(config, outbound) as http:
        sid = http.post("/sessions", json={"title": "Crash delete"}).json()["id"]
        http.post(f"/sessions/{sid}/files").raise_for_status()
    directory = config.session_files_root / "Ungrouped" / sid
    before = (directory / "Transcript.md").read_bytes()
    child = subprocess.run([sys.executable, "-c", CRASH_DELETE, str(config.data_dir),
                            str(config.session_files_root), sid], capture_output=True,
                           text=True, timeout=20, cwd=Path(__file__).resolve().parents[1])
    assert child.returncode == 73, child.stderr
    with open_client(config, outbound) as http:
        assert http.get(f"/sessions/{sid}").status_code == 200
        status = http.get(f"/sessions/{sid}/files").json()
        assert status["state"] == "conflict"
        artifact = directory / status["conflicts"][0]["path"]
        assert artifact.read_bytes() == before
        assert http.delete(f"/sessions/{sid}").status_code == 409
        assert http.post(f"/sessions/{sid}/files").json()["state"] == "conflict"
        assert artifact.read_bytes() == before
        assert (directory / "Transcript.md").read_bytes() == before
    assert outbound.requests == []


async def test_concurrent_delete_requests_do_not_recreate_status_after_delete(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch,
) -> None:
    sid = (await client.post("/sessions", json={"title": "Concurrent delete"})).json()["id"]
    (await client.post(f"/sessions/{sid}/files")).raise_for_status()
    entered, release = threading.Event(), threading.Event()
    original = session_files._rename_at

    def delayed(fd: int, source: str, destination: str, *, exchange: bool) -> None:
        entered.set()
        assert release.wait(5)
        original(fd, source, destination, exchange=exchange)

    with monkeypatch.context() as patcher:
        patcher.setattr(session_files, "_rename_at", delayed)
        first = asyncio.create_task(client.delete(f"/sessions/{sid}"))
        second = None
        try:
            assert await asyncio.to_thread(entered.wait, 5)
            second = asyncio.create_task(client.delete(f"/sessions/{sid}"))
            done, _ = await asyncio.wait({second}, timeout=0.1)
            assert not done
        finally:
            release.set()
            results = await asyncio.gather(first, *([second] if second else []),
                                           return_exceptions=True)
    assert all(isinstance(r, httpx.Response) and r.status_code == 200 for r in results), results
    assert (await client.get(f"/sessions/{sid}")).status_code == 404


@pytest.mark.parametrize("obstacle", ["late_file", "permission", "missing", "parent_swap",
                                     "session_swap"])
async def test_directory_cleanup_boundary_preserves_external_data(
    client: httpx.AsyncClient, config: AppConfig, outbound: FakeHttp,
    monkeypatch: pytest.MonkeyPatch, obstacle: str,
) -> None:
    sid, nid = await seed_note(client, outbound)
    assert config.session_files_root is not None
    parent = config.session_files_root / "Ungrouped"
    directory = parent / sid
    audio = (await client.get(f"/sessions/{sid}/audio/0")).content
    original = os.rmdir
    reached = False

    def boundary(path: str | Path, *, dir_fd: int | None = None) -> None:
        nonlocal reached
        if path != sid:
            original(path, dir_fd=dir_fd)
            return
        reached = True
        assert path == sid and dir_fd is not None
        if obstacle == "late_file":
            (directory / "personal.txt").write_text("Keep late bytes")
        elif obstacle == "permission":
            raise PermissionError("Private path must not be echoed")
        elif obstacle == "missing":
            original(path, dir_fd=dir_fd)
        elif obstacle == "session_swap":
            directory.rename(parent / "saved-session")
            directory.mkdir()
            (directory / "personal.txt").write_text("Keep late bytes")
        else:
            parent.rename(parent.with_name("saved-group"))
            directory.mkdir(parents=True)
            (directory / "personal.txt").write_text("Keep replacement bytes")
        original(path, dir_fd=dir_fd)

    with monkeypatch.context() as patcher:
        patcher.setattr(os, "rmdir", boundary)
        response = await client.delete(f"/sessions/{sid}")
    assert reached
    if obstacle == "parent_swap":
        assert response.status_code == 200, response.text
        assert (directory / "personal.txt").read_text() == "Keep replacement bytes"
        assert not (parent.with_name("saved-group") / sid).exists()
        return
    assert response.status_code == 409, response.text
    assert "Private path" not in response.text
    assert (await client.get(f"/sessions/{sid}")).json()["notes_list"][0]["id"] == nid
    assert (await client.get(f"/sessions/{sid}/audio/0")).content == audio
    if obstacle in ("late_file", "session_swap"):
        assert (directory / "personal.txt").read_text() == "Keep late bytes"
        (directory / "personal.txt").unlink()
    # Recreate a removed projection explicitly; never regenerate a Note/model.
    calls = len(outbound.requests)
    assert (await client.post(f"/sessions/{sid}/files")).json()["state"] == "ready"
    assert (await client.delete(f"/sessions/{sid}")).status_code == 200
    assert not directory.exists()
    assert len(outbound.requests) == calls


async def test_never_projected_empty_external_directory_is_not_removed(
    client: httpx.AsyncClient, config: AppConfig,
) -> None:
    sid = (await client.post("/sessions", json={"title": "Never projected"})).json()["id"]
    assert config.session_files_root is not None
    directory = config.session_files_root / "Ungrouped" / sid
    directory.mkdir(parents=True)
    assert (await client.delete(f"/sessions/{sid}")).status_code == 200
    assert directory.is_dir()


def test_process_death_after_rmdir_keeps_primary_data_for_explicit_retry(
    config: AppConfig, outbound: FakeHttp,
) -> None:
    assert config.session_files_root is not None
    with open_client(config, outbound) as http:
        sid = http.post("/sessions", json={"title": "Crash rmdir"}).json()["id"]
        http.post(f"/sessions/{sid}/files").raise_for_status()
    script = CRASH_DELETE.replace("rename = session_files._rename_at", "remove = os.rmdir")
    start = script.index("    def crash(")
    end = script.index("    response =", start)
    script = script[:start] + '''    def crash(path, *, dir_fd=None):
        remove(path, dir_fd=dir_fd)
        os.fsync(dir_fd)
        os._exit(73)
    os.rmdir = crash
''' + script[end:]
    child = subprocess.run([sys.executable, "-c", script, str(config.data_dir),
                            str(config.session_files_root), sid], capture_output=True,
                           text=True, timeout=20, cwd=Path(__file__).resolve().parents[1])
    assert child.returncode == 73, child.stderr
    directory = config.session_files_root / "Ungrouped" / sid
    assert not directory.exists()
    with open_client(config, outbound) as http:
        assert http.get(f"/sessions/{sid}").status_code == 200
        assert http.get(f"/sessions/{sid}/files").json()["state"] != "ready"
        assert http.delete(f"/sessions/{sid}").status_code == 409
        assert http.post(f"/sessions/{sid}/files").json()["state"] == "ready"
        assert http.delete(f"/sessions/{sid}").status_code == 200
    assert not directory.exists()
    assert outbound.requests == []
