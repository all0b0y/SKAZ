"""Root and conflict transitions use persisted preferences and original WAV bytes."""
from __future__ import annotations


from pathlib import Path

import httpx
import pytest

from audiohelper.config import AppConfig
from tests.conftest import FakeHttp, make_wav
from tests.test_session_files_recovery_api import open_client
from tests.test_native_live_ws import AUTH, packet


@pytest.fixture
def config(tmp_path: Path) -> AppConfig:
    return AppConfig(token="test-token", data_dir=tmp_path / "data", retain_native_audio=True)


async def test_preservation_never_archives_primary_audio(client: httpx.AsyncClient, tmp_path: Path) -> None:
    root = tmp_path / "files"
    assert (await client.put("/storage/root", json={"root": str(root), "expected_root": None})).status_code == 200
    assert (await client.post("/storage/layout")).status_code == 200
    sid = (await client.post("/sessions", json={"title": "Protected"})).json()["id"]
    body = make_wav(.1)
    assert (await client.post(f"/sessions/{sid}/audio/store?sequence=0&start_ms=0&end_ms=100", content=body)).status_code == 201
    assert (await client.post(f"/sessions/{sid}/files")).status_code == 200
    path = root / "Ungrouped" / sid
    (path / "Transcript.md").write_text("External text")
    (path / "personal").mkdir()
    (path / "personal/keep.txt").write_text("Unrelated")
    preserved = await client.post(f"/sessions/{sid}/files/preserve")
    assert preserved.status_code == 200, preserved.text
    archive = root / preserved.json()["preserved_directories"][0]
    assert (archive / "Transcript.md").read_text() == "External text"
    assert (archive / "personal/keep.txt").read_text() == "Unrelated"
    assert not (archive / "audio").exists()
    assert (await client.get(f"/sessions/{sid}/audio/0")).content == body
    assert (await client.post(f"/sessions/{sid}/files/preserve")).json()["preserved_directories"] == preserved.json()["preserved_directories"]
    assert (await client.delete(f"/sessions/{sid}")).status_code == 200
    assert not path.exists()
    assert (archive / "personal/keep.txt").read_text() == "Unrelated"


def test_root_move_restart_and_external_root_files(config: AppConfig, tmp_path: Path) -> None:
    root, target = tmp_path / "files", tmp_path / "target"
    with open_client(config, FakeHttp()) as client:
        assert client.put("/storage/root", json={"root": str(root), "expected_root": None}).status_code == 200
        assert client.post("/storage/layout").status_code == 200
        (root / "personal.txt").write_text("Keep at old root")
        sid = client.post("/sessions", json={"title": "Move"}).json()["id"]
        body = make_wav(.1)
        assert client.post(f"/sessions/{sid}/audio/store?sequence=0&start_ms=0&end_ms=100", content=body).status_code == 201
        assert client.post(f"/sessions/{sid}/files").status_code == 200
        response = client.post("/storage/move-root", json={"root": str(target), "expected_root": str(root)})
        assert response.status_code == 200, response.text
        assert client.get("/storage/root").json()["root"] == str(target)
        assert client.get(f"/sessions/{sid}/audio/0").content == body
        assert (target / "Ungrouped" / sid / "Transcript.md").is_file()
        assert not (root / "Ungrouped").exists()
        assert (root / "personal.txt").read_text() == "Keep at old root"
    with open_client(config, FakeHttp()) as client:
        assert client.get("/storage/root").json()["root"] == str(target)
        assert client.get(f"/sessions/{sid}/audio/0").content == body
        assert client.post(f"/sessions/{sid}/files").json()["state"] == "ready"
        assert client.delete(f"/sessions/{sid}").status_code == 200
        assert not (target / "Ungrouped" / sid).exists()


async def test_legacy_delete_refuses_unknown_audio_before_markdown_cleanup(
    client: httpx.AsyncClient, config: AppConfig,
) -> None:
    sid = (await client.post("/sessions", json={"title": "Legacy"})).json()["id"]
    body = make_wav(.1)
    assert (await client.post(f"/sessions/{sid}/audio/store?sequence=0&start_ms=0&end_ms=100", content=body)).status_code == 201
    unknown = config.audio_dir / sid / "personal.txt"
    unknown.write_text("Never remove")
    assert (await client.delete(f"/sessions/{sid}")).status_code == 409
    assert unknown.read_text() == "Never remove"
    assert (await client.get(f"/sessions/{sid}/audio/0")).content == body
    unknown.unlink()
    assert (await client.delete(f"/sessions/{sid}")).status_code == 200
    assert not unknown.parent.exists()


async def test_managed_audio_symlink_cannot_be_played(client: httpx.AsyncClient, tmp_path: Path) -> None:
    root = tmp_path / "files"
    await client.put("/storage/root", json={"root": str(root), "expected_root": None})
    await client.post("/storage/layout")
    sid = (await client.post("/sessions", json={"title": "Protected"})).json()["id"]
    body = make_wav(.1)
    await client.post(f"/sessions/{sid}/audio/store?sequence=0&start_ms=0&end_ms=100", content=body)
    path = root / "Ungrouped" / sid / "audio/000000.wav"
    external = tmp_path / "external.wav"
    external.write_bytes(b"Never disclose")
    path.unlink()
    path.symlink_to(external)
    response = await client.get(f"/sessions/{sid}/audio/0")
    assert response.status_code == 409
    assert b"Never disclose" not in response.content
    assert external.read_bytes() == b"Never disclose"


def test_native_move_restart_append_and_active_move_refusal(config: AppConfig, tmp_path: Path) -> None:
    root = tmp_path / "files"
    group = "b" * 32
    with open_client(config, FakeHttp()) as client:
        client.put("/storage/root", json={"root": str(root), "expected_root": None}).raise_for_status()
        client.post("/storage/layout").raise_for_status()
        client.put("/settings", json={"native_recording_mode": "audio_only"}).raise_for_status()
        sid = client.post("/sessions", json={"title": "Native"}).json()["id"]
        move = {"expected_revision": 0, "data": {"version": 1,
                "groups": [{"id": group, "name": "Native group", "tag": ""}], "membership": {sid: group}}}
        with client.websocket_connect(f"ws://127.0.0.1/sessions/{sid}/live/stream", headers=AUTH) as ws:
            ws.send_json({"type": "open", "sample_rate": 16000})
            assert ws.receive_json()["saved_samples"] == 0
            ws.send_bytes(packet(0, 0))
            assert ws.receive_json()["saved_samples"] == 1600
            assert client.put("/storage/groups", json=move).status_code == 409
            ws.send_json({"type": "end", "action": "pause"})
            assert ws.receive_json()["type"] == "stream.stopped"
        original = client.get(f"/sessions/{sid}/audio/0").content
        client.put("/storage/groups", json=move).raise_for_status()
    with open_client(config, FakeHttp()) as client:
        with client.websocket_connect(f"ws://127.0.0.1/sessions/{sid}/live/stream", headers=AUTH) as ws:
            ws.send_json({"type": "open", "sample_rate": 16000})
            assert ws.receive_json()["saved_samples"] == 1600
            ws.send_bytes(packet(1, 1600))
            assert ws.receive_json()["saved_samples"] == 3200
            ws.send_json({"type": "end", "action": "pause"})
            assert ws.receive_json()["type"] == "stream.stopped"
        directory = root / f"Group-{group}" / sid
        assert (directory / "audio/000000.wav").read_bytes() == original
        assert client.get(f"/sessions/{sid}/audio/1").content[44:] == packet(1, 1600)[20:]
        assert (directory / "Transcript.md").is_file()
        client.delete(f"/sessions/{sid}").raise_for_status()
        assert not directory.exists()
