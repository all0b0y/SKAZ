"""Explicit preservation resolves conflicts without importing or deleting bytes."""
from __future__ import annotations

import os
import subprocess
import sys
from dataclasses import replace
from pathlib import Path

import httpx
import pytest

from audiohelper import session_files
from audiohelper.config import AppConfig
from tests.conftest import FakeHttp
from tests.test_session_files_api import seed_note
from tests.test_session_files_recovery_api import CRASH_WRITER, open_client


@pytest.fixture
def config(tmp_path: Path) -> AppConfig:
    return replace(AppConfig(token="test-token", data_dir=tmp_path / "data"),
                   session_files_root=tmp_path / "files")


async def test_preserve_all_versions_restores_app_files_and_keeps_archive_after_delete(
    client: httpx.AsyncClient, config: AppConfig, outbound: FakeHttp,
) -> None:
    sid, nid = await seed_note(client, outbound)
    assert config.session_files_root is not None
    directory = config.session_files_root / "Ungrouped" / sid
    original = (directory / "Transcript.md").read_bytes()
    (directory / "Transcript.md").write_text("External canonical")
    recovery = f"Transcript.recovery-{'a' * 32}.md"
    (directory / recovery).write_text("Unfinished editor version")
    (directory / "personal.txt").write_text("Unrelated file")
    audio = (await client.get(f"/sessions/{sid}/audio/0")).content
    calls = len(outbound.requests)
    response = await client.post(f"/sessions/{sid}/files/preserve")
    assert response.status_code == 200, response.text
    status = response.json()
    assert status["state"] == "ready"
    assert len(status["preserved_directories"]) == 1
    archive = config.session_files_root / status["preserved_directories"][0]
    assert archive != directory
    assert (archive / "Transcript.md").read_text() == "External canonical"
    assert (archive / recovery).read_text() == "Unfinished editor version"
    assert (archive / "personal.txt").read_text() == "Unrelated file"
    assert (directory / "Transcript.md").read_bytes() == original
    assert (directory / f"Note-{nid}.md").is_file()
    assert (await client.get(f"/sessions/{sid}/audio/0")).content == audio
    assert len(outbound.requests) == calls
    repeated = (await client.post(f"/sessions/{sid}/files/preserve")).json()
    assert repeated["state"] == "ready"
    assert repeated["preserved_directories"] == status["preserved_directories"]
    assert (await client.get(f"/sessions/{sid}/files")).json() == repeated
    assert (await client.delete(f"/sessions/{sid}")).status_code == 200
    assert (archive / "personal.txt").read_text() == "Unrelated file"
    assert not directory.exists()


@pytest.mark.parametrize("phase", ["intent", "rename", "commit"])
def test_process_death_preserves_bytes_and_explicit_retry_finishes_once(
    config: AppConfig, outbound: FakeHttp, phase: str,
) -> None:
    assert config.session_files_root is not None
    with open_client(config, outbound) as client:
        sid = client.post("/sessions", json={"title": "Crash preservation"}).json()["id"]
        client.post(f"/sessions/{sid}/files").raise_for_status()
    directory = config.session_files_root / "Ungrouped" / sid
    (directory / "Transcript.md").write_text("External bytes before crash")
    script = CRASH_WRITER.replace(
        'if phase == "manifest" and sql.startswith("INSERT OR REPLACE INTO file_projections"):',
        'if (phase == "intent" and sql.startswith("INSERT INTO file_preservations")) or '
        '(phase == "commit" and sql.startswith("UPDATE file_preservations")):',
    ).replace('phase != "manifest"', 'phase == "rename"').replace(
        '/files", headers=auth)', '/files/preserve", headers=auth)',
    )
    process = subprocess.run(
        [sys.executable, "-c", script, str(config.data_dir), str(config.session_files_root), sid, phase],
        cwd=Path(__file__).parents[1], capture_output=True, text=True, timeout=30,
    )
    assert process.returncode == 73, process.stderr
    with open_client(config, outbound) as client:
        status = client.get(f"/sessions/{sid}/files").json()
        assert status["state"] != "ready"
        if phase != "commit":
            assert status["preservation_pending"] is True
            assert client.delete(f"/sessions/{sid}").status_code == 409
            assert client.post(f"/sessions/{sid}/files").json()["state"] == "error"
        response = client.post(f"/sessions/{sid}/files/preserve")
        assert response.status_code == 200, response.text
        result = response.json()
        assert result["state"] == "ready"
        assert result["preservation_pending"] is False
        assert len(result["preserved_directories"]) == 1
        archive = config.session_files_root / result["preserved_directories"][0]
        assert (archive / "Transcript.md").read_text() == "External bytes before crash"
        assert "Crash preservation" in (directory / "Transcript.md").read_text()


async def test_unknown_file_delete_refusal_exposes_actionable_conflict(
    client: httpx.AsyncClient, config: AppConfig,
) -> None:
    sid = (await client.post("/sessions", json={"title": "Unknown entry"})).json()["id"]
    (await client.post(f"/sessions/{sid}/files")).raise_for_status()
    assert config.session_files_root is not None
    directory = config.session_files_root / "Ungrouped" / sid
    (directory / "personal.txt").write_text("User-owned file")
    assert (await client.delete(f"/sessions/{sid}")).status_code == 409
    assert (await client.get(f"/sessions/{sid}/files")).json()["state"] == "conflict"
    assert (await client.post(f"/sessions/{sid}/files")).json()["state"] == "conflict"
    result = (await client.post(f"/sessions/{sid}/files/preserve")).json()
    assert result["state"] == "ready"
    archive = config.session_files_root / result["preserved_directories"][0]
    assert (archive / "personal.txt").read_text() == "User-owned file"


@pytest.mark.parametrize("kind", ["symlink", "hardlink", "nested"])
async def test_archive_preserves_unknown_entries_without_traversal(
    client: httpx.AsyncClient, config: AppConfig, kind: str,
) -> None:
    sid = (await client.post("/sessions", json={"title": "Links"})).json()["id"]
    (await client.post(f"/sessions/{sid}/files")).raise_for_status()
    assert config.session_files_root is not None
    directory = config.session_files_root / "Ungrouped" / sid
    external = config.data_dir / "external.txt"
    external.write_text("Never modify target")
    obstacle = directory / "unknown"
    if kind == "symlink":
        obstacle.symlink_to(external)
    elif kind == "hardlink":
        obstacle.hardlink_to(external)
    else:
        obstacle.mkdir()
        (obstacle / "nested.txt").write_text("Nested bytes")
    before = obstacle.lstat()
    response = await client.post(f"/sessions/{sid}/files/preserve")
    assert response.status_code == 200, response.text
    archive = config.session_files_root / response.json()["preserved_directories"][0]
    assert os.path.samestat(before, (archive / "unknown").lstat())
    assert external.read_text() == "Never modify target"
    assert (await client.delete(f"/sessions/{sid}")).status_code == 200
    assert (archive / "unknown").lstat().st_ino == before.st_ino


async def test_never_used_directory_cannot_be_archived(
    client: httpx.AsyncClient, config: AppConfig,
) -> None:
    sid = (await client.post("/sessions", json={"title": "Unknown"})).json()["id"]
    assert config.session_files_root is not None
    directory = config.session_files_root / "Ungrouped" / sid
    directory.mkdir(parents=True)
    (directory / "personal.txt").write_text("Unknown directory")
    response = await client.post(f"/sessions/{sid}/files/preserve")
    assert response.status_code == 409
    assert (directory / "personal.txt").read_text() == "Unknown directory"
    assert str(config.session_files_root) not in response.text


@pytest.mark.parametrize("fault", ["fsync", "late_file", "source_replaced", "destination_created"])
async def test_preservation_at_syscall_boundaries_never_clobbers_external_bytes(
    client: httpx.AsyncClient, config: AppConfig, monkeypatch: pytest.MonkeyPatch, fault: str,
) -> None:
    sid = (await client.post("/sessions", json={"title": "Race"})).json()["id"]
    (await client.post(f"/sessions/{sid}/files")).raise_for_status()
    assert config.session_files_root is not None
    directory = config.session_files_root / "Ungrouped" / sid
    (directory / "Transcript.md").write_text("External original")
    original_rename = session_files._rename_at
    original_fsync = os.fsync
    displaced = directory.with_name("external-displaced")
    hit = False

    def rename(fd: int, source: str, destination: str, *, exchange: bool) -> None:
        nonlocal hit
        if source == sid:
            hit = True
            if fault == "late_file":
                (directory / "late.txt").write_text("Late editor bytes")
            elif fault == "source_replaced":
                directory.rename(displaced)
                directory.mkdir()
                (directory / "replacement.txt").write_text("Replacement bytes")
            elif fault == "destination_created":
                (directory.parent / destination).mkdir()
                (directory.parent / destination / "other.txt").write_text("Existing destination")
        original_rename(fd, source, destination, exchange=exchange)

    def fsync(fd: int) -> None:
        if fault == "fsync" and hit:
            raise OSError("Private path must not reach HTTP")
        original_fsync(fd)

    with monkeypatch.context() as patcher:
        patcher.setattr("audiohelper.file_preservation._rename_at", rename)
        patcher.setattr(os, "fsync", fsync)
        response = await client.post(f"/sessions/{sid}/files/preserve")
    assert hit
    assert response.status_code == (200 if fault == "late_file" else 409), response.text
    assert "Private path" not in response.text
    status = (await client.get(f"/sessions/{sid}/files")).json()
    archive = config.session_files_root / status["preserved_directories"][0]
    assert (await client.get(f"/sessions/{sid}")).status_code == 200
    if fault in ("fsync", "late_file"):
        assert (archive / "Transcript.md").read_text() == "External original"
        if fault == "late_file":
            assert (archive / "late.txt").read_text() == "Late editor bytes"
        else:
            assert status["preservation_pending"]
            assert (await client.post(f"/sessions/{sid}/files/preserve")).json()["state"] == "ready"
    elif fault == "source_replaced":
        assert (displaced / "Transcript.md").read_text() == "External original"
        assert (archive / "replacement.txt").read_text() == "Replacement bytes"
        assert (await client.post(f"/sessions/{sid}/files/preserve")).status_code == 409
    else:
        assert (directory / "Transcript.md").read_text() == "External original"
        assert (archive / "other.txt").read_text() == "Existing destination"
