"""B4: new recordings and imports never create or change anything under the old ``Documents/SKAZ``.

An earlier SKAZ version may have left a saved Markdown root (``storage_root``) or the
managed physical layout (``physical_storage``) in the profile's database, with its
session folders under ``<Documents>/SKAZ/Ungrouped/<id>/``. The knowledge library is
the only store of new material: a recording, an import and the deletion of an
import's technical session must leave every old byte, name and folder as it was.

Soniox (realtime and file API) and ffmpeg/yt-dlp are fakes at the external edge.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest
from starlette.testclient import TestClient

from skaz import media_tools
from skaz.config import AppConfig
from skaz.db import Database

from .speech_support import AsyncSoniox
from .test_speech_recordings_api import AUTH, LECTURE, Provider, make_app, open_stream, recording, texts

OLD_SESSION = "0123456789abcdef0123456789abcdef"
OLD_TRANSCRIPT = b"# Old lecture\n\nWritten by the previous version.\n"


@pytest.fixture(autouse=True)
def _offline_media(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("skaz.import_service.POLL_SCHEDULE", (0.01,))

    async def probe(path: Path) -> dict[str, Any]:
        return {"title": path.stem, "duration_ms": 2500}

    monkeypatch.setattr(media_tools, "local_metadata", probe)


def seed_old_install(config: AppConfig, old_root: Path, *, managed: bool) -> None:
    """The profile state and files an earlier version left behind (written directly, as it did)."""
    session_dir = old_root / "Ungrouped" / OLD_SESSION
    session_dir.mkdir(parents=True)
    (session_dir / "Transcript.md").write_bytes(OLD_TRANSCRIPT)
    db = Database(config.db_path)
    try:
        with db.write() as connection:
            connection.execute("INSERT OR REPLACE INTO storage_root VALUES (1,?)", (str(old_root),))
            if managed:
                connection.execute("INSERT INTO physical_storage VALUES (1,0,?)", (json.dumps(
                    {"version": 1, "groups": [], "membership": {}}),))
    finally:
        db.close()


def snapshot(root: Path) -> dict[str, str]:
    """Every entry under ``root``: folders by name, files by content."""
    result: dict[str, str] = {}
    for path in sorted(root.rglob("*")):
        key = str(path.relative_to(root))
        result[key] = "dir" if path.is_dir() else hashlib.sha256(path.read_bytes()).hexdigest()
    return result


@pytest.fixture
def provider(monkeypatch: pytest.MonkeyPatch) -> Provider:
    from skaz.gateways import soniox as soniox_gateway

    fake = Provider()
    monkeypatch.setattr(soniox_gateway, "connect", fake.connect)
    return fake


def wait(http: TestClient, check: Callable[[], bool], what: str) -> None:
    assert http.portal is not None
    for _ in range(500):
        if check():
            return
        http.portal.call(asyncio.sleep, 0.01)
    raise AssertionError(f"timed out waiting for {what}")


def imported(http: TestClient, material_id: str) -> dict[str, Any]:
    return dict(http.get(f"/kb/imports/{material_id}", headers=AUTH).json())


@pytest.fixture(params=["markdown_root", "managed_layout"])
def old_install(request: pytest.FixtureRequest, kb_config: AppConfig, documents: Path) -> Path:
    old_root = documents / "SKAZ"
    seed_old_install(kb_config, old_root, managed=request.param == "managed_layout")
    return old_root


@pytest.fixture
def http(kb_config: AppConfig, old_install: Path, provider: Provider) -> Iterator[TestClient]:
    from tests.conftest import FakeHttp

    cloud = FakeHttp()
    app = make_app(kb_config, cloud)
    app.state.soniox = AsyncSoniox(cloud)
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as client:
        library = client.post("/kb/library", headers=AUTH, json={}).json()
        assert library["state"] == "ready", library
        # The old folder is not a new library: the new one is created beside it.
        assert Path(library["root"]) != old_install
        assert client.put("/settings", headers=AUTH, json={"cloud_consent": True}).status_code == 200
        yield client
    app.state.runtime.close()


def test_recording_and_import_leave_the_old_documents_folder_unchanged(
    http: TestClient, provider: Provider, old_install: Path, tmp_path: Path,
) -> None:
    before = snapshot(old_install)
    assert before == {
        "Ungrouped": "dir",
        f"Ungrouped/{OLD_SESSION}": "dir",
        f"Ungrouped/{OLD_SESSION}/Transcript.md": hashlib.sha256(OLD_TRANSCRIPT).hexdigest(),
    }

    # A recording: created, streamed, paused (the old projection ran here), stopped.
    rec = http.post("/kb/recordings", headers=AUTH, json={}).json()
    material_id, session_id = rec["material_id"], rec["session_id"]
    provider.scripts.append(LECTURE)
    with http.websocket_connect(f"ws://127.0.0.1/sessions/{session_id}/live/stream", headers=AUTH) as ws:
        stream = open_stream(http, ws)
        stream.send(5)
        assert stream.end("stop")["transcription_complete"] is True
    wait(http, lambda: recording(http, material_id)["status"] == "ready", "the recording to settle")
    assert len(texts(http, material_id)) == 3
    assert http.patch(f"/sessions/{session_id}", headers=AUTH, json={"status": "stopped"}).status_code == 200

    # An import that completes.
    soniox: AsyncSoniox = http.app.state.soniox  # type: ignore[attr-defined]
    audio = tmp_path / "Lecture.m4a"
    audio.write_bytes(b"\x00\x01" * 2048)
    done = http.post("/kb/imports", headers=AUTH, json={"path": str(audio)}).json()
    wait(http, lambda: imported(http, done["material_id"])["status"] == "ready", "the import to finish")

    # An import that is cancelled: its technical session is deleted.
    soniox.hold_all = True
    held = tmp_path / "Held.m4a"
    held.write_bytes(b"\x00\x01" * 2048)
    cancelled = http.post("/kb/imports", headers=AUTH, json={"path": str(held)}).json()
    wait(http, lambda: imported(http, cancelled["material_id"])["import_stage"] == "processing",
         "the second import to run")
    assert http.post(f"/kb/imports/{cancelled['material_id']}/cancel", headers=AUTH).status_code == 200

    assert snapshot(old_install) == before
    assert (old_install / "Ungrouped" / OLD_SESSION / "Transcript.md").read_bytes() == OLD_TRANSCRIPT
