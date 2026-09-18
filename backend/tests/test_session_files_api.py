"""Filesystem output observed through session/notes HTTP, with isolated real disk."""
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

from audiohelper.app import create_app
from audiohelper.config import AppConfig
from audiohelper.gateways import soniox
from audiohelper.secrets import MemorySecretStore
from tests.conftest import FakeHttp, chat_completion, make_wav
from tests.test_native_live_ws import AUTH, packet
from tests.test_native_soniox_ws import ProviderSocket


@pytest.fixture
def config(tmp_path: Path) -> AppConfig:
    return replace(AppConfig(token="test-token", data_dir=tmp_path / "data", retain_native_audio=True),
                   session_files_root=tmp_path / "files")


async def test_pause_projects_transcript_without_generating_notes(
    client: httpx.AsyncClient, config: AppConfig, outbound: FakeHttp,
) -> None:
    sid = (await client.post("/sessions", json={"title": "../Lecture <script>"})).json()["id"]
    paused = await client.patch(f"/sessions/{sid}", json={"status": "paused"})
    assert paused.status_code == 200, paused.text
    status = await client.get(f"/sessions/{sid}/files")
    assert status.status_code == 200, status.text
    assert status.json()["state"] == "ready"
    assert config.session_files_root is not None
    directory = config.session_files_root / "Ungrouped" / sid
    transcript = (directory / "Transcript.md").read_text()
    assert "&lt;script&gt;" in transcript
    assert "No stable transcript" in transcript
    assert list(directory.glob("Note-*.md")) == []
    assert outbound.requests == []
    assert not (config.session_files_root / "Lecture <script>").exists()


async def seed_note(client: httpx.AsyncClient, outbound: FakeHttp) -> tuple[str, str]:
    (await client.put("/settings", json={
        "cloud_consent": True,
        "provider_keys": {"openai": "fixture-only"},
        "asr": {"provider": "openai", "model": "whisper-1"},
        "notes": {"provider": "openai", "model": "gpt-4o-mini"},
    })).raise_for_status()
    sid = (await client.post("/sessions", json={"title": "Lecture"})).json()["id"]
    outbound.json_route("POST", "audio/transcriptions", {"text": "Original evidence."})
    response = await client.post(f"/sessions/{sid}/audio", params={
        "sequence": 0, "start_ms": 0, "end_ms": 1000,
    }, content=make_wav(), headers={"Content-Type": "audio/wav"})
    assert response.status_code == 200, response.text
    outbound.json_route("POST", "chat/completions", chat_completion("First note [P1]"))
    note = await client.post(f"/sessions/{sid}/notes", json={})
    assert note.status_code == 200, note.text
    return sid, str(note.json()["id"])


async def test_independent_notes_edit_restore_and_external_conflict(
    client: httpx.AsyncClient, config: AppConfig, outbound: FakeHttp,
) -> None:
    sid, nid = await seed_note(client, outbound)
    assert config.session_files_root is not None
    directory = config.session_files_root / "Ungrouped" / sid
    note_file = directory / f"Note-{nid}.md"
    original = note_file.read_text()
    assert "First note" in original
    assert "[P1]" not in original, "labels are grounding, never part of the document"
    detail = (await client.get(f"/sessions/{sid}")).json()
    segment = detail["segments"][0]["id"]
    assert f"Transcript.md#segment-{segment}" in original
    transcript = (directory / "Transcript.md").read_text()
    assert f'id="segment-{segment}"' in transcript
    assert "00:00:00.000" in transcript
    assert "Original evidence" in transcript
    second = (await client.post(f"/sessions/{sid}/notes", json={})).json()["id"]
    assert second != nid
    assert len(list(directory.glob("Note-*.md"))) == 2
    path = f"/sessions/{sid}/notes/{nid}"
    (await client.patch(path, json={"expected_revision": 1, "content": "Edited"})).raise_for_status()
    assert "Edited" in note_file.read_text()
    versions = (await client.get(path + "/history")).json()["versions"]
    (await client.post(path + f"/history/{versions[0]['id']}/restore",
                       json={"expected_revision": 2})).raise_for_status()
    assert "First note" in note_file.read_text()
    assert list(directory.glob("*history*")) == []
    note_file.write_text("External author's changes", encoding="utf-8")
    response = await client.patch(path, json={"expected_revision": 3, "content": "New app text"})
    assert response.status_code == 200, response.text
    assert note_file.read_text() == "External author's changes"
    status = (await client.get(f"/sessions/{sid}/files")).json()
    assert status["state"] == "conflict"
    conflict = next(f for f in status["files"] if f["state"] == "conflict")
    assert "New app text" in (directory / conflict["path"]).read_text()
    # Selected by id, not by position: the list is ordered by last edit, so the
    # note just written is now first. The claim here is about its content.
    listing = (await client.get(path.rsplit("/", 1)[0])).json()["notes"]
    assert next(n for n in listing if n["id"] == nid)["content"] == "New app text"


@pytest.mark.parametrize("target", ["root", "group", "session", "transcript", "hardlink"])
async def test_projection_rejects_links_without_touching_external_data(
    client: httpx.AsyncClient, config: AppConfig, tmp_path: Path, target: str,
) -> None:
    sid = (await client.post("/sessions", json={"title": "Safe"})).json()["id"]
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
    status = (await client.get(f"/sessions/{sid}/files")).json()
    assert status["state"] == "error"
    assert str(outside) not in str(status)
    assert external.read_text() == "Never touch"
    assert sorted(p.name for p in outside.iterdir()) == ["private.md"]


async def test_unknown_file_is_not_adopted_or_overwritten_and_get_is_read_only(
    client: httpx.AsyncClient, config: AppConfig,
) -> None:
    sid = (await client.post("/sessions", json={"title": "Safe"})).json()["id"]
    assert config.session_files_root is not None
    directory = config.session_files_root / "Ungrouped" / sid
    status = (await client.get(f"/sessions/{sid}/files")).json()
    assert status["state"] == "pending"
    assert not directory.exists()
    directory.mkdir(parents=True)
    target = directory / "Transcript.md"
    target.write_text("External before first projection")
    result = (await client.post(f"/sessions/{sid}/files")).json()
    assert result["state"] == "conflict"
    assert target.read_text() == "External before first projection"
    assert "No stable transcript" in (directory / result["files"][0]["path"]).read_text()
    assert (await client.post("/sessions/missing/files")).status_code == 404
    again = (await client.post(f"/sessions/{sid}/files")).json()
    assert again["files"][0]["path"] == result["files"][0]["path"]
    assert len(list(directory.glob("*.md"))) == 2


async def test_note_sources_link_to_preserved_app_transcript_on_conflict(
    client: httpx.AsyncClient, config: AppConfig, outbound: FakeHttp,
) -> None:
    sid, nid = await seed_note(client, outbound)
    assert config.session_files_root is not None
    directory = config.session_files_root / "Ungrouped" / sid
    (directory / "Transcript.md").write_text("External replacement without source anchors")
    result = (await client.post(f"/sessions/{sid}/files")).json()
    projected = next(f for f in result["files"] if f["name"] == "Transcript.md")
    assert projected["state"] == "conflict"
    note = (directory / f"Note-{nid}.md").read_text()
    assert f']({projected["path"]}#segment-' in note
    assert "](Transcript.md#" not in note


async def test_external_replace_at_atomic_publish_boundary_is_preserved(
    client: httpx.AsyncClient, config: AppConfig, monkeypatch: pytest.MonkeyPatch,
) -> None:
    sid = (await client.post("/sessions", json={"title": "Before"})).json()["id"]
    (await client.post(f"/sessions/{sid}/files")).raise_for_status()
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
    result = (await client.post(f"/sessions/{sid}/files")).json()
    assert fired
    assert result["state"] == "conflict"
    assert any("External text saved at the rename boundary" in p.read_text()
               for p in directory.glob("*.md"))
    again = (await client.post(f"/sessions/{sid}/files")).json()
    assert again["state"] == "conflict"  # retry cannot silently dismiss saved external data
    assert again["conflicts"] == result["conflicts"]


async def test_failed_file_flush_keeps_previous_file_and_committed_note_then_retry(
    client: httpx.AsyncClient, config: AppConfig, outbound: FakeHttp, monkeypatch: pytest.MonkeyPatch,
) -> None:
    sid, nid = await seed_note(client, outbound)
    assert config.session_files_root is not None
    directory = config.session_files_root / "Ungrouped" / sid
    note_file = directory / f"Note-{nid}.md"
    previous = note_file.read_bytes()
    original_fsync = os.fsync

    def failed_flush(descriptor: int) -> None:
        if stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise OSError("Sensitive path must not appear in API")
        original_fsync(descriptor)

    with monkeypatch.context() as patcher:
        patcher.setattr(os, "fsync", failed_flush)
        edited = await client.patch(f"/sessions/{sid}/notes/{nid}", json={
            "content": "Saved in database", "expected_revision": 1,
        })
        assert edited.status_code == 200, edited.text
        assert edited.json()["revision"] == 2
        assert note_file.read_bytes() == previous
        status = (await client.get(f"/sessions/{sid}/files")).json()
        assert status["state"] == "error"
        assert "Sensitive" not in str(status)
        assert list(directory.glob("*.recovery-*.md")) == []
    result = (await client.post(f"/sessions/{sid}/files")).json()
    assert result["state"] == "ready"
    assert "Saved in database" in note_file.read_text()
    assert len(list(directory.glob("Note-*.md"))) == 1


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
        sid = http.post("/sessions", headers=AUTH, json={"title": "Native"}).json()["id"]
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
            http.post(f"/sessions/{sid}/files", headers=AUTH).raise_for_status()
            assert "Hello" not in target.read_text()
            assert "Unstable draft" not in target.read_text()
            ws.send_json({"type": "end", "action": "pause"})
            assert ws.receive_json()["transcription_complete"] is True
            assert "Hello" in target.read_text()  # provider supplies final only after end
            assert "Unstable draft" not in target.read_text()
        assert outbound.requests == []  # no notes generation
    reopened = create_app(config, secret_store=secrets, http_client=outbound.client())
    with TestClient(reopened, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as http:
        assert http.get(f"/sessions/{sid}/files", headers=AUTH).json()["state"] == "ready"
        result = http.post(f"/sessions/{sid}/files", headers=AUTH).json()
        assert result["files"][0]["state"] == "unchanged"
        assert http.get(f"/sessions/{sid}/audio/0", headers=AUTH).content[44:] == packet(0, 0)[20:]
        target.write_text("External after restart")
        result = http.post(f"/sessions/{sid}/files", headers=AUTH).json()
        assert result["state"] == "conflict"
        assert target.read_text() == "External after restart"
        assert "Hello" in (directory / result["files"][0]["path"]).read_text()


async def test_delete_waits_for_inflight_file_publication(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch,
) -> None:
    sid = (await client.post("/sessions", json={"title": "Delete during export"})).json()["id"]
    entered, release = threading.Event(), threading.Event()
    original_fsync = os.fsync

    def delayed_flush(descriptor: int) -> None:
        if stat.S_ISREG(os.fstat(descriptor).st_mode):
            entered.set()
            assert release.wait(5)
        original_fsync(descriptor)

    monkeypatch.setattr(os, "fsync", delayed_flush)
    exporting = asyncio.create_task(client.post(f"/sessions/{sid}/files"))
    deleting: asyncio.Task[httpx.Response] | None = None
    try:
        assert await asyncio.to_thread(entered.wait, 5)
        deleting = asyncio.create_task(client.delete(f"/sessions/{sid}"))
        completed, _ = await asyncio.wait({deleting}, timeout=0.1)
        assert not completed  # deletion cannot orphan a manifest write
    finally:
        release.set()
        results = await asyncio.gather(exporting, *([deleting] if deleting else []),
                                       return_exceptions=True)
    assert all(isinstance(r, httpx.Response) and r.status_code == 200 for r in results), results
    assert (await client.get(f"/sessions/{sid}/files")).status_code == 404
