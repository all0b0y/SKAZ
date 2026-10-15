"""Regression for old DB-only imports and filesystem ownership boundaries.

Runs on an install whose earlier version switched the managed layout on (its route is
gone); deletion goes through the path the speech area calls.
"""
from dataclasses import replace
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import HTTPException

from skaz.config import AppConfig
from skaz.managed_storage import StorageConflict
from tests.sessions_support import adelete, session_gone
from tests.test_import_store import start, token
from tests.test_managed_storage_api import enable_managed


@pytest.fixture
def config(tmp_path: Path) -> AppConfig:
    return replace(AppConfig(token="test-token", data_dir=tmp_path / "data"),
                   session_files_root=tmp_path / "files")


@pytest.mark.parametrize("collision", [False, True])
async def test_delete_old_import_without_allocation(
    client: httpx.AsyncClient, app: Any, config: AppConfig, tmp_path: Path, collision: bool,
) -> None:
    enable_managed(app)
    runtime = app.state.runtime
    # Old import creation bypassed ManagedStorage entirely.
    sid = start(runtime.imports.store, runtime.db, tmp_path)
    runtime.imports.store.apply_transcript(sid, tokens=[token("Hello", 0, 500)], audio_duration_ms=1000)
    assert config.session_files_root is not None
    directory = config.session_files_root / "Ungrouped" / sid
    if collision:
        directory.mkdir()
        (directory / "external.txt").write_text("Keep me")
        with pytest.raises((HTTPException, StorageConflict)):
            await adelete(client, sid)
        assert (directory / "external.txt").read_text() == "Keep me"
        assert not session_gone(client, sid)
    else:
        await adelete(client, sid)
        assert not directory.exists()
        assert session_gone(client, sid)
    assert (tmp_path / "lecture.m4a").read_bytes() == b"not really audio, never decoded here"


async def test_import_delete_preserves_external_files(
    client: httpx.AsyncClient, app: Any, config: AppConfig, tmp_path: Path,
) -> None:
    enable_managed(app)
    runtime = app.state.runtime
    sid = start(runtime.imports.store, runtime.db, tmp_path)
    runtime.imports.store.apply_transcript(sid, tokens=[token("Hello", 0, 500)], audio_duration_ms=1000)
    runtime.storage.ensure_import_directory(sid)
    assert runtime.session_files.project(sid)["state"] == "ready"
    assert config.session_files_root is not None
    directory = config.session_files_root / "Ungrouped" / sid
    external = directory / "external.txt"
    external.write_text("Keep me")
    with pytest.raises((HTTPException, StorageConflict)):
        await adelete(client, sid)
    assert external.read_text() == "Keep me"
    assert not session_gone(client, sid)
