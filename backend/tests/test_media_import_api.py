"""Media import contracts; downloader and provider are offline fixtures, not speech acceptance.

Driven through ``LegacySpeech`` (the Knowledge Wiki's import bridge) over
``runtime.imports``; the old ``/imports`` routes and their link preview are gone
(the new interface classifies links with ``POST /kb/links/classify``).
"""
from pathlib import Path
from typing import Any

import httpx
import pytest

from skaz.gateways import ProviderNotConfigured
from skaz.import_service import DUPLICATE_VIDEO, ImportRequest
from skaz.import_store import ImportConflict

from .sessions_support import runtime_of, session_gone
from .test_imports_api import Provider, import_view, settle, speech
from .test_imports_api import provider as provider  # pytest fixture re-export
from .test_imports_api import ready as ready  # pytest fixture re-export

VIDEO = "https://youtu.be/abcdefghijk?t=12"


@pytest.fixture(autouse=True)
def media(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("skaz.import_service.POLL_SCHEDULE", (0.0,))

    async def metadata(url: str) -> dict[str, Any]:
        from skaz.media_source import youtube_source
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

    monkeypatch.setattr("skaz.media_tools.youtube_metadata", metadata)
    monkeypatch.setattr("skaz.media_tools.download_audio", download)
    monkeypatch.setattr("skaz.media_tools.extract_audio", extract)


async def start_video(client: httpx.AsyncClient, url: str = VIDEO) -> str:
    bridge = speech(client)
    session_id = bridge.create_import_session("Lecture")
    await bridge.start_import(ImportRequest(session_id=session_id, path=Path(""), translate=False,
                                            declared_duration_ms=None, url=url, prepare_media=True))
    return session_id


async def test_video_import_and_duplicate(ready: httpx.AsyncClient) -> None:
    session_id = await start_video(ready)
    result = await settle(ready, session_id, expect="completed")
    assert result["source"]["video_id"] == "abcdefghijk"
    assert result["source"]["url"] == "https://www.youtube.com/watch?v=abcdefghijk"
    assert session_id in runtime_of(ready).imports.store.matching_video("abcdefghijk")
    with pytest.raises(ImportConflict, match=DUPLICATE_VIDEO):
        await start_video(ready)


async def test_retry_requires_current_consent(ready: httpx.AsyncClient, provider: Provider) -> None:
    provider.queue(provider.failed("audio_error", "fixture error"))
    sid = await start_video(ready, "https://youtu.be/abcdefghijk")
    await settle(ready, sid, expect="failed")
    await ready.put("/settings", json={"cloud_consent": False})
    with pytest.raises(ProviderNotConfigured):
        await speech(ready).retry_import(sid)
    view = import_view(ready, sid)
    assert view is not None and view["status"] == "failed"


async def test_retry_terminal_provider_error_can_start_new_job(
    ready: httpx.AsyncClient, provider: Provider,
) -> None:
    provider.queue(provider.failed("audio_error", "fixture error"))
    sid = await start_video(ready, "https://youtu.be/abcdefghijk")
    await settle(ready, sid, expect="failed")
    # Reconciliation sees a definitively failed job, not a network failure or missing ID.
    provider.queue(provider.failed("audio_error", "fixture error"))
    await speech(ready).retry_import(sid)
    await settle(ready, sid, expect="completed")


async def test_cancel_removes_unfinished_session(
    ready: httpx.AsyncClient, provider: Provider, tmp_path: Path,
) -> None:
    provider.queue(*[provider.processing() for _ in range(100)])
    path = tmp_path / "source.m4a"
    path.write_bytes(b"original")
    bridge = speech(ready)
    session_id = bridge.create_import_session("Local")
    await bridge.start_import(ImportRequest(session_id=session_id, path=path, translate=False,
                                            declared_duration_ms=None))
    await bridge.cancel_import(session_id)
    assert session_gone(ready, session_id)
    assert path.read_bytes() == b"original"
