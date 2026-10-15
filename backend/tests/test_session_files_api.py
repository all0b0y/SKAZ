"""Markdown projection of a recording's session onto isolated real disk.

The files/notes routes of the old interface are gone: projection runs when the
recorder pauses or stops (``PATCH /sessions/{id}``) and on the paths that call
``SessionFiles.project`` directly; session Notes no longer exist, so their file
tests went with them.
"""
from __future__ import annotations

import asyncio
import ctypes
import json
import os
import stat
import sys
import threading
import time
from dataclasses import replace
from pathlib import Path
from typing import Any

import httpx
import pytest
from starlette.testclient import TestClient

from skaz.app import create_app
from skaz.config import AppConfig
from skaz.gateways import soniox
from skaz.secrets import MemorySecretStore
from tests.conftest import FakeHttp
from tests.sessions_support import (
    adelete,
    create_session,
    files_status,
    project,
    session_gone,
)
from tests.test_native_live_ws import AUTH, packet
from tests.test_native_soniox_ws import ProviderSocket


@pytest.fixture
def config(tmp_path: Path) -> AppConfig:
    return replace(AppConfig(token="test-token", data_dir=tmp_path / "data"),
                   session_files_root=tmp_path / "files")


async def test_pause_projects_transcript_without_generating_notes(
    client: httpx.AsyncClient, config: AppConfig, outbound: FakeHttp,
) -> None:
    sid = create_session(client, "../Lecture <script>")
    paused = await client.patch(f"/sessions/{sid}", json={"status": "paused"})
    assert paused.status_code == 200, paused.text
    assert files_status(client, sid)["state"] == "ready"
    assert config.session_files_root is not None
    directory = config.session_files_root / "Ungrouped" / sid
    transcript = (directory / "Transcript.md").read_text()
    assert "&lt;script&gt;" in transcript
    assert "No stable transcript" in transcript
    assert list(directory.glob("Note-*.md")) == []
    assert outbound.requests == []
    assert not (config.session_files_root / "Lecture <script>").exists()


@pytest.mark.parametrize("target", ["root", "group", "session", "transcript", "hardlink"])
async def test_projection_rejects_links_without_touching_external_data(
    client: httpx.AsyncClient, config: AppConfig, tmp_path: Path, target: str,
) -> None:
    sid = create_session(client, "Safe")
    assert config.session_files_root is not None
    root = config.session_files_root
    directory = root / "Ungrouped" / sid
    outside = tmp_path / "outside"
    outside.mkdir()
    external = outside / "private.md"
    external.write_text("Never touch")
    if target in ("root", "group", "session"):
        link = {"root": root, "group": root / "Ungrouped", "session": directory}[target]
        link.parent.mkdir(parents=True, exist_ok=True)
        link.symlink_to(outside, target_is_directory=True)
    else:
        directory.mkdir(parents=True)
        if target == "transcript":
            (directory / "Transcript.md").symlink_to(external)
        else:
            (directory / "Transcript.md").hardlink_to(external)
    paused = await client.patch(f"/sessions/{sid}", json={"status": "paused"})
    assert paused.status_code == 200
    status = files_status(client, sid)
    assert status["state"] == "error"
    assert str(outside) not in str(status)
    assert external.read_text() == "Never touch"
    assert sorted(p.name for p in outside.iterdir()) == ["private.md"]


async def test_unknown_file_is_not_adopted_or_overwritten_and_get_is_read_only(
    client: httpx.AsyncClient, config: AppConfig,
) -> None:
    sid = create_session(client, "Safe")
    assert config.session_files_root is not None
    directory = config.session_files_root / "Ungrouped" / sid
    status = files_status(client, sid)
    assert status["state"] == "pending"
    assert not directory.exists()
    directory.mkdir(parents=True)
    target = directory / "Transcript.md"
    target.write_text("External before first projection")
    result = project(client, sid)
    assert result["state"] == "conflict"
    assert target.read_text() == "External before first projection"
    assert "No stable transcript" in (directory / result["files"][0]["path"]).read_text()
    again = project(client, sid)
    assert again["files"][0]["path"] == result["files"][0]["path"]
    assert len(list(directory.glob("*.md"))) == 2


async def test_external_replace_at_atomic_publish_boundary_is_preserved(
    client: httpx.AsyncClient, config: AppConfig, monkeypatch: pytest.MonkeyPatch,
) -> None:
    sid = create_session(client, "Before")
    project(client, sid)
    assert config.session_files_root is not None
    directory = config.session_files_root / "Ungrouped" / sid
    target = directory / "Transcript.md"
    await client.patch(f"/sessions/{sid}", json={"title": "After"})
    fired = False

    def external_replace() -> None:
        nonlocal fired
        if not fired:
            fired = True
            external = directory / "editor-save.md"
            external.write_text("External text saved at the rename boundary")
            os.rename(external, target)

    original_replace = os.replace

    def racing_replace(*args: Any, **kwargs: Any) -> None:
        external_replace()
        original_replace(*args, **kwargs)

    # Inject at the OS boundary, then execute the real filesystem operation.
    # Support both portable replace and the no-loss native exchange primitive.
    original_library = ctypes.CDLL

    def racing_library(*args: Any, **kwargs: Any) -> Any:
        library = original_library(*args, **kwargs)
        symbol = "renameatx_np" if sys.platform == "darwin" else "renameat2"
        native = getattr(library, symbol)

        def racing_rename(*values: Any) -> int:
            if values[-1] == 2:
                external_replace()
            return int(native(*values))

        setattr(library, symbol, racing_rename)
        return library

    monkeypatch.setattr(os, "replace", racing_replace)
    monkeypatch.setattr(ctypes, "CDLL", racing_library)
    result = project(client, sid)
    assert fired
    assert result["state"] == "conflict"
    assert any("External text saved at the rename boundary" in p.read_text()
               for p in directory.glob("*.md"))
    again = project(client, sid)
    assert again["state"] == "conflict"  # retry cannot silently dismiss saved external data
    assert again["conflicts"] == result["conflicts"]


def test_native_pause_waits_for_tail_and_restart_keeps_manifest(
    config: AppConfig, outbound: FakeHttp, secrets: MemorySecretStore, monkeypatch: pytest.MonkeyPatch,
) -> None:
    class DraftSocket(ProviderSocket):
        async def send(self, message: str | bytes) -> None:
            await super().send(message)
            if isinstance(message, bytes) and message:
                await self.responses.put(json.dumps({
                    "tokens": [{"text": "Unstable draft", "start_ms": 0, "end_ms": 100,
                                "confidence": 0.8, "is_final": False, "language": "en"}],
                    "final_audio_proc_ms": 0, "total_audio_proc_ms": 100,
                }))

    async def connect(*args: Any, **kwargs: Any) -> ProviderSocket:
        return DraftSocket()

    monkeypatch.setattr(soniox, "connect", connect)
    secrets.set("soniox", "fixture-only")
    app = create_app(config, secret_store=secrets, http_client=outbound.client())
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as http:
        http.put("/settings", headers=AUTH, json={"cloud_consent": True}).raise_for_status()
        sid = create_session(http, "Native")
        assert config.session_files_root is not None
        directory = config.session_files_root / "Ungrouped" / sid
        target = directory / "Transcript.md"
        with http.websocket_connect(f"ws://127.0.0.1/sessions/{sid}/live/stream", headers=AUTH) as ws:
            ws.send_json({"type": "open", "sample_rate": 16000})
            ws.receive_json()
            assert http.portal is not None
            http.portal.call(asyncio.sleep, 0)
            ws.send_bytes(packet(0, 0))
            assert ws.receive_json()["type"] == "audio.saved"
            deadline = time.monotonic() + 3
            while True:
                snapshot = http.get(f"/sessions/{sid}/live", headers=AUTH).json()
                draft = json.loads(snapshot["connections"][-1]["draft_json"])
                if any(token["text"] == "Unstable draft" for token in draft):
                    break
                assert time.monotonic() < deadline, snapshot
                time.sleep(0.01)
            project(http, sid)
            assert "Hello" not in target.read_text()
            assert "Unstable draft" not in target.read_text()
            ws.send_json({"type": "end", "action": "pause"})
            assert ws.receive_json()["transcription_complete"] is True
            assert "Hello" in target.read_text()  # provider supplies final only after end
            assert "Unstable draft" not in target.read_text()
        assert outbound.requests == []  # no notes generation
    reopened = create_app(config, secret_store=secrets, http_client=outbound.client())
    with TestClient(reopened, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as http:
        assert files_status(http, sid)["state"] == "ready"
        result = project(http, sid)
        assert result["files"][0]["state"] == "unchanged"
        assert http.get(f"/sessions/{sid}/audio/0", headers=AUTH).status_code == 404
        target.write_text("External after restart")
        result = project(http, sid)
        assert result["state"] == "conflict"
        assert target.read_text() == "External after restart"
        assert "Hello" in (directory / result["files"][0]["path"]).read_text()


async def test_delete_waits_for_inflight_file_publication(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch,
) -> None:
    sid = create_session(client, "Delete during export")
    entered, release = threading.Event(), threading.Event()
    original_fsync = os.fsync

    def delayed_flush(descriptor: int) -> None:
        if stat.S_ISREG(os.fstat(descriptor).st_mode):
            entered.set()
            assert release.wait(5)
        original_fsync(descriptor)

    monkeypatch.setattr(os, "fsync", delayed_flush)
    exporting = asyncio.create_task(asyncio.to_thread(project, client, sid))
    deleting: asyncio.Task[None] | None = None
    try:
        assert await asyncio.to_thread(entered.wait, 5)
        deleting = asyncio.create_task(adelete(client, sid))
        completed, _ = await asyncio.wait({deleting}, timeout=0.1)
        assert not completed  # deletion cannot orphan a manifest write
    finally:
        release.set()
        results = await asyncio.gather(exporting, *([deleting] if deleting else []),
                                       return_exceptions=True)
    assert not any(isinstance(r, BaseException) for r in results), results
    assert session_gone(client, sid)
