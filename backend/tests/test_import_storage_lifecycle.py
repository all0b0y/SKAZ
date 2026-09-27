"""Regression for old DB-only imports and filesystem ownership boundaries."""
from dataclasses import replace
from pathlib import Path
from typing import Any

import httpx
import pytest

from skaz.config import AppConfig
from tests.test_import_store import start, token


@pytest.fixture
def config(tmp_path: Path) -> AppConfig:
    return replace(AppConfig(token="test-token", data_dir=tmp_path / "data"),
                   session_files_root=tmp_path / "files")


@pytest.mark.parametrize("endpoint", ["sessions", "imports"])
@pytest.mark.parametrize("collision", [False, True])
async def test_delete_old_import_without_allocation(
    client: httpx.AsyncClient, app: Any, config: AppConfig, tmp_path: Path,
    endpoint: str, collision: bool,
) -> None:
    assert (await client.post("/storage/layout")).status_code == 200
    runtime = app.state.runtime
    # Old import creation bypassed ManagedStorage entirely.
    sid = start(runtime.imports.store, runtime.db, tmp_path)
    runtime.imports.store.apply_transcript(sid, tokens=[token("Hello", 0, 500)], audio_duration_ms=1000)
    assert config.session_files_root is not None
    directory = config.session_files_root / "Ungrouped" / sid
    if collision:
        directory.mkdir()
        (directory / "external.txt").write_text("Keep me")
    response = await client.delete(f"/{endpoint}/{sid}")
    if collision:
        assert response.status_code == 409, response.text
        assert (directory / "external.txt").read_text() == "Keep me"
        assert (await client.get(f"/sessions/{sid}")).status_code == 200
    else:
        assert response.status_code == 200, response.text
        assert not directory.exists()
        assert (await client.get(f"/sessions/{sid}")).status_code == 404
    assert (tmp_path / "lecture.m4a").read_bytes() == b"not really audio, never decoded here"


@pytest.mark.parametrize("endpoint", ["sessions", "imports"])
async def test_import_delete_preserves_external_files(
    client: httpx.AsyncClient, app: Any, config: AppConfig, tmp_path: Path, endpoint: str,
) -> None:
    assert (await client.post("/storage/layout")).status_code == 200
    runtime = app.state.runtime
    sid = start(runtime.imports.store, runtime.db, tmp_path)
    runtime.imports.store.apply_transcript(sid, tokens=[token("Hello", 0, 500)], audio_duration_ms=1000)
    runtime.storage.ensure_import_directory(sid)
    assert runtime.session_files.project(sid)["state"] == "ready"
    assert config.session_files_root is not None
    directory = config.session_files_root / "Ungrouped" / sid
    external = directory / "external.txt"
    external.write_text("Keep me")
    response = await client.delete(f"/{endpoint}/{sid}")
    assert response.status_code == 409, response.text
    assert external.read_text() == "Keep me"
    assert (await client.get(f"/sessions/{sid}")).status_code == 200
