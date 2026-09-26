"""Media import contracts; downloader and provider are offline fixtures, not speech acceptance."""
from pathlib import Path
from typing import Any

import httpx
import pytest

from .test_imports_api import Provider, settle
from .test_imports_api import provider as provider  # pytest fixture re-export
from .test_imports_api import ready as ready  # pytest fixture re-export


@pytest.fixture(autouse=True)
def media(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("audiohelper.import_service.POLL_SCHEDULE", (0.0,))

    async def metadata(url: str) -> dict[str, Any]:
        from audiohelper.media_source import youtube_source
        source = youtube_source(url)
        return {"url": source.url, "video_id": source.video_id,
                "title": "Lecture", "duration_ms": 2500}

    async def download(url: str, directory: Path) -> Path:
        path = directory / "download.m4a"
        path.write_bytes(b"fixture audio")
        return path

    async def extract(source: Path, directory: Path) -> Path:
        path = directory / "audio.m4a"
        path.write_bytes(source.read_bytes())
        return path

    monkeypatch.setattr("audiohelper.media_tools.youtube_metadata", metadata)
    monkeypatch.setattr("audiohelper.media_tools.download_audio", download)
    monkeypatch.setattr("audiohelper.media_tools.extract_audio", extract)


async def test_youtube_preview_import_and_duplicate(ready: httpx.AsyncClient) -> None:
    source = {"kind": "youtube", "url": "https://youtu.be/abcdefghijk?t=12"}
    preview = await ready.post("/imports/preview", json={"source": source})
    assert preview.status_code == 200, preview.text
    assert preview.json()["title"] == "Lecture"
    assert preview.json()["duration_ms"] == 2500
    response = await ready.post("/imports", json={"source": source, "title": "Lecture"})
    assert response.status_code == 201, response.text
    session_id = response.json()["session"]["id"]
    result = await settle(ready, session_id, expect="completed")
    assert result["source"]["video_id"] == "abcdefghijk"
    assert result["source"]["url"] == "https://www.youtube.com/watch?v=abcdefghijk"
    again = await ready.post("/imports/preview", json={"source": source})
    assert session_id in again.json()["existing_session_ids"]
    duplicate = await ready.post("/imports", json={"source": source, "title": "Lecture"})
    assert duplicate.status_code == 409


async def test_retry_requires_current_consent(ready: httpx.AsyncClient, provider: Provider) -> None:
    provider.queue(provider.failed("audio_error", "fixture error"))
    created = await ready.post("/imports", json={
        "source": {"kind": "youtube", "url": "https://youtu.be/abcdefghijk"}, "title": "Lecture",
    })
    sid = created.json()["session"]["id"]
    await settle(ready, sid, expect="failed")
    await ready.put("/settings", json={"cloud_consent": False})
    retried = await ready.post(f"/imports/{sid}/retry")
    assert retried.status_code == 409
    assert (await ready.get(f"/imports/{sid}")).json()["status"] == "failed"


async def test_retry_terminal_provider_error_can_start_new_job(
    ready: httpx.AsyncClient, provider: Provider,
) -> None:
    provider.queue(provider.failed("audio_error", "fixture error"))
    created = await ready.post("/imports", json={
        "source": {"kind": "youtube", "url": "https://youtu.be/abcdefghijk"}, "title": "Lecture",
    })
    sid = created.json()["session"]["id"]
    await settle(ready, sid, expect="failed")
    # Reconciliation sees a definitively failed job, not a network failure or missing ID.
    provider.queue(provider.failed("audio_error", "fixture error"))
    retried = await ready.post(f"/imports/{sid}/retry")
    assert retried.status_code == 201
    await settle(ready, sid, expect="completed")


async def test_cancel_removes_unfinished_session(
    ready: httpx.AsyncClient, provider: Provider, tmp_path: Path,
) -> None:
    provider.queue(*[provider.processing() for _ in range(100)])
    path = tmp_path / "source.m4a"
    path.write_bytes(b"original")
    created = await ready.post("/imports", json={"path": str(path), "title": "Local"})
    session_id = created.json()["session"]["id"]
    cancelled = await ready.post(f"/imports/{session_id}/cancel")
    assert cancelled.status_code == 200
    assert (await ready.get(f"/sessions/{session_id}")).status_code == 404
    assert path.read_bytes() == b"original"
