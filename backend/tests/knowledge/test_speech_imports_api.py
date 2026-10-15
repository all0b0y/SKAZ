"""``/kb/imports``: imported audio/video becomes a material; imports run side by side, never queued.

The Soniox file API, yt-dlp/ffmpeg and Local Whisper are scripted fakes at the
external edge: this proves the plumbing (parallelism, cancellation, statuses,
fragments), not recognition quality.
"""
from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest

from skaz import asr_providers, media_tools
from skaz.app import create_app
from skaz.config import AppConfig
from skaz.file_asr import FileTranscript
from skaz.gateways.soniox_async import AsyncToken
from skaz.import_service import LOCAL_BUSY, MAX_LOCAL_RECOGNITIONS
from skaz.knowledge.ingest.service import NO_SPEECH_FILE
from skaz.knowledge.library.library import INBOX_ID
from skaz.knowledge.speech.service import CANCELLED_IMPORT, INTERRUPTED_IMPORT
from skaz.secrets import MemorySecretStore
from tests.conftest import TOKEN, FakeHttp
from tests.sessions_support import adelete, get_session, session_count

from .speech_support import AsyncSoniox


@pytest.fixture(autouse=True)
def _offline_media(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("skaz.import_service.POLL_SCHEDULE", (0.01,))

    async def metadata(url: str) -> dict[str, Any]:
        from skaz.media_source import youtube_source

        source = youtube_source(url)
        return {"url": source.url, "video_id": source.video_id, "title": "Video lecture", "duration_ms": 2500}

    async def download(url: str, directory: Path) -> Path:
        path = directory / "download.m4a"
        path.write_bytes(b"fixture audio")
        return path

    async def extract(source: Path, directory: Path) -> Path:
        path = directory / "audio.m4a"
        path.write_bytes(source.read_bytes())
        return path

    async def probe(path: Path) -> dict[str, Any]:
        return {"title": path.stem, "duration_ms": 2500}

    monkeypatch.setattr(media_tools, "youtube_metadata", metadata)
    monkeypatch.setattr(media_tools, "download_audio", download)
    monkeypatch.setattr(media_tools, "extract_audio", extract)
    monkeypatch.setattr(media_tools, "local_metadata", probe)


@pytest.fixture
def cloud() -> FakeHttp:
    return FakeHttp()


@pytest.fixture
def soniox(cloud: FakeHttp) -> AsyncSoniox:
    return AsyncSoniox(cloud)


@pytest.fixture
def speech_app(kb_config: AppConfig, cloud: FakeHttp) -> Iterator[Any]:
    secrets = MemorySecretStore()
    secrets.set("soniox", "fixture-key-not-real")
    application = create_app(kb_config, secret_store=secrets, http_client=cloud.client())
    yield application
    application.state.runtime.close()


async def connected(application: Any) -> httpx.AsyncClient:
    client = httpx.AsyncClient(transport=httpx.ASGITransport(app=application), base_url="http://127.0.0.1:8765",
                               headers={"Authorization": f"Bearer {TOKEN}"})
    assert (await client.post("/kb/library", json={})).json()["state"] == "ready"
    assert (await client.put("/settings", json={"cloud_consent": True})).status_code == 200
    return client


@pytest.fixture
async def api(speech_app: Any, soniox: AsyncSoniox) -> AsyncIterator[httpx.AsyncClient]:
    client = await connected(speech_app)
    try:
        yield client
    finally:
        # No lifespan here (plain ASGI transport): close what a finished import may have started —
        # the automatic wiki job and its engine — before the loop ends, as the app's shutdown does.
        await speech_app.state.runtime.kb_ingest.close()
        await speech_app.state.runtime.kb_codex.close()
        await speech_app.state.runtime.imports.close()
        await speech_app.state.runtime.kb_speech.close()
        await client.aclose()


def media(tmp_path: Path, name: str) -> str:
    path = tmp_path / name
    path.write_bytes(b"\x00\x01" * 2048)
    return str(path)


async def until(api: httpx.AsyncClient, material_id: str, **expected: object) -> dict[str, Any]:
    for _ in range(500):
        view = (await api.get(f"/kb/imports/{material_id}")).json()
        if all(view.get(key) == value for key, value in expected.items()):
            return dict(view)
        await asyncio.sleep(0.01)
    raise AssertionError(f"{material_id} never reached {expected}: {view}")


async def fragments(api: httpx.AsyncClient, material_id: str) -> list[tuple[str, str | None]]:
    material = (await api.get(f"/kb/materials/{material_id}")).json()
    return [(item["text"], item["speaker"]) for item in material["fragments"]]


async def test_two_imports_run_side_by_side_and_cancel_independently(
    api: httpx.AsyncClient, soniox: AsyncSoniox, tmp_path: Path, speech_app: Any,
) -> None:
    soniox.hold_all = True
    first = await api.post("/kb/imports", json={"path": media(tmp_path, "Lecture A.m4a")})
    second = await api.post("/kb/imports", json={"path": media(tmp_path, "Lecture B.mp3")})
    assert first.status_code == 201, first.text
    assert second.status_code == 201, second.text
    a, b = first.json(), second.json()
    assert (a["title"], a["kind"], a["status"], a["import_state"]) == (
        "Lecture A", "audio", "processing", "running"), a
    assert b["folder_id"] == INBOX_ID
    await until(api, a["material_id"], import_stage="processing")
    await until(api, b["material_id"], import_stage="processing")
    active = {item["material_id"] for item in (await api.get("/kb/imports/active")).json()}
    assert active == {a["material_id"], b["material_id"]}

    cancelled = await api.post(f"/kb/imports/{a['material_id']}/cancel")
    assert cancelled.status_code == 200, cancelled.text
    assert cancelled.json()["status"] == "failed" and cancelled.json()["error"] == CANCELLED_IMPORT
    # The other import is untouched and still running.
    assert (await api.get(f"/kb/imports/{b['material_id']}")).json()["import_state"] == "running"
    # A cancelled import's technical session is deleted with it.
    assert get_session(speech_app, a["session_id"]) is None

    soniox.hold.clear()
    done = await until(api, b["material_id"], status="ready")
    assert done["import_state"] == "completed" and done["error"] is None
    assert await fragments(api, b["material_id"]) == [("Hello there", "1"), ("Hi", "2")]
    assert (await api.get("/kb/imports/active")).json() == []


async def test_deleting_one_imports_session_leaves_the_other_running(
    api: httpx.AsyncClient, soniox: AsyncSoniox, tmp_path: Path, speech_app: Any,
) -> None:
    soniox.hold_all = True
    a = (await api.post("/kb/imports", json={"path": media(tmp_path, "Left.m4a")})).json()
    b = (await api.post("/kb/imports", json={"path": media(tmp_path, "Right.m4a")})).json()
    await until(api, a["material_id"], import_stage="processing")
    # The deletion path the speech area uses (``LegacySpeech.delete_session``).
    await adelete(speech_app, a["session_id"])
    gone = await until(api, a["material_id"], status="failed")
    assert gone["error"] == CANCELLED_IMPORT
    assert (await api.get(f"/kb/imports/{b['material_id']}")).json()["import_state"] == "running"
    soniox.hold.clear()
    await until(api, b["material_id"], status="ready")


async def test_imports_go_to_the_last_used_folder(api: httpx.AsyncClient, tmp_path: Path) -> None:
    assert (await api.get("/kb/recordings/defaults")).json() == {"folder_id": INBOX_ID}
    physics = (await api.post("/kb/folders", json={"name": "Physics"})).json()["id"]
    chosen = (await api.post("/kb/imports", json={"path": media(tmp_path, "one.wav"),
                                                  "folder_id": physics})).json()
    assert chosen["folder_id"] == physics
    assert (await api.get("/kb/recordings/defaults")).json() == {"folder_id": physics}
    following = (await api.post("/kb/imports", json={"path": media(tmp_path, "two.wav")})).json()
    assert following["folder_id"] == physics
    missing = await api.post("/kb/imports", json={"path": media(tmp_path, "three.wav"),
                                                  "folder_id": "fld-gone"})
    assert missing.status_code == 404


async def test_import_without_cloud_consent_is_refused_and_leaves_no_session_behind(
    api: httpx.AsyncClient, soniox: AsyncSoniox, tmp_path: Path, speech_app: Any,
) -> None:
    assert (await api.put("/settings", json={"cloud_consent": False})).status_code == 200
    sessions_before = session_count(speech_app)

    refused = await api.post("/kb/imports", json={"path": media(tmp_path, "Lecture.m4a")})

    assert refused.status_code == 409, refused.text
    assert "consent" in refused.json()["detail"].lower()
    assert session_count(speech_app) == sessions_before
    active = await api.get("/kb/imports/active")
    assert active.status_code == 200 and active.json() == []
    assert soniox.jobs == []


async def test_requests_are_checked_before_anything_starts(
    api: httpx.AsyncClient, soniox: AsyncSoniox, tmp_path: Path, speech_app: Any,
) -> None:
    sessions_before = session_count(speech_app)
    cases = [
        ({"path": "relative.m4a"}, 400),
        ({"path": media(tmp_path, "notes.txt")}, 400),
        ({"url": "https://example.com/watch?v=abcdefghijk"}, 400),
        ({"path": media(tmp_path, "x.m4a"), "url": "https://youtu.be/abcdefghijk"}, 400),
        ({"path": media(tmp_path, "y.m4a"), "language": "xx"}, 400),
    ]
    for body, status in cases:
        response = await api.post("/kb/imports", json=body)
        assert response.status_code == status, (body, response.text)
    await api.post("/kb/imports", json={"path": media(tmp_path, "Same.m4a")})
    taken = await api.post("/kb/imports", json={"path": media(tmp_path, "same.m4a")})
    assert taken.status_code == 409 and "already exists" in taken.json()["detail"]
    assert session_count(speech_app) == sessions_before + 1
    assert len(soniox.jobs) <= 1


async def test_audio_and_video_paths_get_the_same_checks_as_documents(
    api: httpx.AsyncClient, speech_app: Any, soniox: AsyncSoniox, tmp_path: Path,
) -> None:
    """Hidden folders and SKAZ's own data are refused after links are followed; ordinary files work."""
    sessions_before = session_count(speech_app)
    (tmp_path / ".cache").mkdir()
    hidden = Path(media(tmp_path / ".cache", "talk.m4a"))
    data_dir = speech_app.state.runtime.kb.data_dir
    inside = Path(media(data_dir, "rec.m4a"))
    (tmp_path / "into-hidden.m4a").symlink_to(hidden)
    (tmp_path / "into-data.m4a").symlink_to(inside)
    (tmp_path / "Folder").mkdir()
    cases = [
        (str(hidden), "hidden folders"),
        (str(tmp_path / "into-hidden.m4a"), "hidden folders"),
        (str(inside), "own data folder"),
        (str(tmp_path / "into-data.m4a"), "own data folder"),
        (str(tmp_path / "missing.m4a"), "doesn't exist"),
        (str(tmp_path / "Folder.m4a"), "doesn't exist"),
    ]
    (tmp_path / "Folder.m4a").mkdir()
    cases[-1] = (str(tmp_path / "Folder.m4a"), "regular file")
    for path, message in cases:
        response = await api.post("/kb/imports", json={"path": path})
        assert response.status_code == 400, (path, response.text)
        assert message in response.json()["detail"], (path, response.text)
    assert session_count(speech_app) == sessions_before
    assert (await api.get("/kb/materials")).json() == []
    # A link to a file in an ordinary folder is followed and imported.
    (tmp_path / "Lecture.m4a").symlink_to(Path(media(tmp_path / "Folder", "real.m4a")))
    started = await api.post("/kb/imports", json={"path": str(tmp_path / "Lecture.m4a")})
    assert started.status_code == 201, started.text


async def test_video_files_and_links_become_video_materials_and_duplicates_are_guarded(
    api: httpx.AsyncClient, tmp_path: Path,
) -> None:
    video = (await api.post("/kb/imports", json={"path": media(tmp_path, "Seminar.mov")})).json()
    assert video["kind"] == "video"
    link = await api.post("/kb/imports", json={"url": "https://youtu.be/abcdefghijk", "language": "en"})
    assert link.status_code == 201, link.text
    linked = link.json()
    assert (linked["kind"], linked["title"]) == ("video_link", "Video lecture")
    await until(api, linked["material_id"], status="ready")
    await until(api, video["material_id"], status="ready")
    material = (await api.get(f"/kb/materials/{linked['material_id']}")).json()
    assert material["origin"]["url"] == "https://www.youtube.com/watch?v=abcdefghijk"
    assert material["languages"] == ["en"]

    duplicate = await api.post("/kb/imports", json={"url": "https://youtu.be/abcdefghijk", "title": "Again"})
    assert duplicate.status_code == 409 and "already has a session" in duplicate.json()["detail"]
    again = await api.post("/kb/imports", json={"url": "https://youtu.be/abcdefghijk", "title": "Again",
                                                "allow_duplicate": True})
    assert again.status_code == 201, again.text

    # Two simultaneous requests for one new video: one starts, the other is told it is a duplicate.
    racing = await asyncio.gather(*(
        api.post("/kb/imports", json={"url": "https://youtu.be/bcdefghijkl", "title": f"Race {index}"})
        for index in range(2)))
    assert sorted(response.status_code for response in racing) == [201, 409]


async def test_a_failed_import_keeps_its_reason_and_retry_continues_the_same_material(
    api: httpx.AsyncClient, soniox: AsyncSoniox, tmp_path: Path,
) -> None:
    soniox.failing = True
    created = (await api.post("/kb/imports", json={"path": media(tmp_path, "Broken.m4a")})).json()
    failed = await until(api, created["material_id"], status="failed")
    assert failed["import_state"] == "failed" and "fixture error" in failed["error"]
    soniox.failing = False
    retried = await api.post(f"/kb/imports/{created['material_id']}/retry")
    assert retried.status_code == 200, retried.text
    done = await until(api, created["material_id"], status="ready")
    assert done["material_id"] == created["material_id"] and done["error"] is None
    assert await fragments(api, created["material_id"]) == [("Hello there", "1"), ("Hi", "2")]
    assert (await api.post(f"/kb/imports/{created['material_id']}/retry")).status_code == 409


async def test_on_device_recognition_is_bounded_with_a_reason_not_queued(
    api: httpx.AsyncClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(asr_providers, "local_asr_available", lambda: True)
    monkeypatch.setattr(asr_providers, "local_model_cache_present", lambda *a, **k: True)
    gate = asyncio.Event()
    running: list[str] = []

    async def decode(source: Path, directory: Path) -> Path:
        output = directory / "audio.s16le"
        output.write_bytes(b"\x00\x00" * 16_000)
        return output

    async def transcribe(runtime: Any, model: str, pcm: Path, *, languages: tuple[str, ...] | None,
                         translation_target: str | None) -> FileTranscript:
        running.append(model)
        await gate.wait()
        return FileTranscript([AsyncToken(" Local", 0, 400, 0.9, "1", "en", "none")], 1_000)

    monkeypatch.setattr(media_tools, "decode_pcm16k", decode)
    monkeypatch.setattr("skaz.import_service.transcribe_import", transcribe)
    assert (await api.put("/settings", json={"transcription_provider": "local-whisper"})).status_code == 200

    started = [await api.post("/kb/imports", json={"path": media(tmp_path, f"local {index}.m4a")})
               for index in range(MAX_LOCAL_RECOGNITIONS)]
    assert [response.status_code for response in started] == [201] * MAX_LOCAL_RECOGNITIONS
    refused = await api.post("/kb/imports", json={"path": media(tmp_path, "one too many.m4a")})
    assert refused.status_code == 409 and refused.json()["detail"] == LOCAL_BUSY
    for _ in range(200):
        if len(running) == MAX_LOCAL_RECOGNITIONS:
            break
        await asyncio.sleep(0.01)
    assert len(running) == MAX_LOCAL_RECOGNITIONS  # all four at once, none waiting behind another

    gate.set()
    for response in started:
        await until(api, response.json()["material_id"], status="ready")
    later = await api.post("/kb/imports", json={"path": media(tmp_path, "one too many.m4a")})
    assert later.status_code == 201, later.text


async def test_closing_the_app_stops_every_import_and_retry_resumes_each(
    kb_config: AppConfig, cloud: FakeHttp, soniox: AsyncSoniox, tmp_path: Path,
) -> None:
    secrets = MemorySecretStore()
    secrets.set("soniox", "fixture-key-not-real")
    soniox.hold_all = True
    first_app = create_app(kb_config, secret_store=secrets, http_client=cloud.client())
    async with first_app.router.lifespan_context(first_app):
        client = await connected(first_app)
        ids = [(await client.post("/kb/imports", json={"path": media(tmp_path, f"Talk {index}.m4a")})).json()
               ["material_id"] for index in range(2)]
        for material_id in ids:
            await until(client, material_id, import_stage="processing")
        await client.aclose()
    # Lifespan exit cancelled and awaited both imports.
    assert first_app.state.runtime.imports.active == 0
    first_app.state.runtime.close()

    soniox.hold.clear()
    soniox.hold_all = False
    second_app = create_app(kb_config, secret_store=secrets, http_client=cloud.client())
    async with second_app.router.lifespan_context(second_app):
        client = await connected(second_app)
        for material_id in ids:
            interrupted = await until(client, material_id, status="failed")
            assert interrupted["import_state"] == "interrupted" and interrupted["error"] == INTERRUPTED_IMPORT
        assert (await client.post(f"/kb/imports/{ids[0]}/retry")).status_code == 200
        await until(client, ids[0], status="ready")
        # The other one is still waiting for its own decision.
        assert (await client.get(f"/kb/imports/{ids[1]}")).json()["status"] == "failed"
        await client.aclose()
    second_app.state.runtime.close()


async def test_a_translated_import_writes_translation_md_beside_the_original(
    api: httpx.AsyncClient, soniox: AsyncSoniox, tmp_path: Path,
) -> None:
    soniox.tokens = [
        {"text": "Hello", "start_ms": 0, "end_ms": 400, "confidence": 0.9, "speaker": "1", "language": "en",
         "translation_status": "original"},
        {"text": "Привет", "start_ms": 0, "end_ms": 400, "confidence": 0.9, "speaker": "1", "language": "ru",
         "translation_status": "translation"},
    ]
    created = await api.post("/kb/imports", json={"path": media(tmp_path, "Greeting.m4a"), "translate": True})
    assert created.status_code == 201, created.text
    await until(api, created.json()["material_id"], status="ready")
    assert await fragments(api, created.json()["material_id"]) == [("Hello", "1")]
    root = Path((await api.get("/kb/library")).json()["root"])
    translation = root / "Materials" / "Inbox" / "Greeting" / ".skaz" / "translation.md"
    content = translation.read_text(encoding="utf-8")
    assert "**Speaker 1**\nПривет" in content and "^seg" not in content


async def _import_finishing_before_the_route_returns(
    api: httpx.AsyncClient, speech_app: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, *,
    to_wiki: bool, settings_add: bool,
) -> tuple[str, list[str]]:
    """The import completes inside ``start_import`` (a short file on a fast service): its "finished"
    event reaches AutoIngest before the HTTP route returns."""
    runtime = speech_app.state.runtime
    runtime.kb_ingest.update_settings(auto_add_files_links=settings_add)
    legacy = runtime.kb_speech.legacy
    original = legacy.start_import

    async def start_then_finish(request: Any) -> None:
        await original(request)
        for _ in range(500):
            status = legacy.import_status(request.session_id)
            if status is not None and status.state == "completed":
                return
            await asyncio.sleep(0.01)
        raise AssertionError("the scripted import never completed")

    monkeypatch.setattr(legacy, "start_import", start_then_finish)
    started: list[str] = []

    async def record(material_id: str) -> None:
        started.append(material_id)

    monkeypatch.setattr(runtime.kb_auto_ingest, "_start", record)
    response = await api.post("/kb/imports", json={"path": media(tmp_path, "short.m4a"), "to_wiki": to_wiki})
    assert response.status_code == 201, response.text
    material_id = response.json()["material_id"]
    await until(api, material_id, status="ready")
    await asyncio.sleep(0.05)
    return material_id, started


async def test_an_unticked_import_that_finishes_at_once_stays_out_of_the_wiki(
    api: httpx.AsyncClient, speech_app: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    """X5 (X2 Q3): the choice travels in ``ImportInput``; it is kept before the import can finish."""
    from skaz.knowledge.wiring import CHOICE_KEY

    material_id, started = await _import_finishing_before_the_route_returns(
        api, speech_app, monkeypatch, tmp_path, to_wiki=False, settings_add=True)
    assert started == []  # Settings add files by themselves, but the user unticked this one
    # Used up at completion: no choice is left behind for a material that already finished.
    assert speech_app.state.runtime.kb.settings.get(CHOICE_KEY + material_id) is None


async def test_a_ticked_import_that_finishes_at_once_goes_to_the_wiki(
    api: httpx.AsyncClient, speech_app: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    from skaz.knowledge.wiring import CHOICE_KEY

    material_id, started = await _import_finishing_before_the_route_returns(
        api, speech_app, monkeypatch, tmp_path, to_wiki=True, settings_add=False)
    assert started == [material_id]
    assert speech_app.state.runtime.kb.settings.get(CHOICE_KEY + material_id) is None


async def test_an_import_without_speech_is_ready_without_text_and_never_goes_to_the_wiki(
    api: httpx.AsyncClient, speech_app: Any, soniox: AsyncSoniox, tmp_path: Path,
) -> None:
    """User bug 1016-2 for imports: an empty transcription is no wiki failure, nothing is started."""
    speech_app.state.runtime.kb_ingest.update_settings(auto_add_files_links=True)
    soniox.tokens = []
    body = {"path": media(tmp_path, "Silence.m4a"), "to_wiki": True}
    created = (await api.post("/kb/imports", json=body)).json()
    material_id = created["material_id"]
    done = await until(api, material_id, status="ready")
    assert done["fragment_count"] == 0 and done["error"] is None and done["duration_ms"] == 2_500
    await asyncio.sleep(0.1)
    assert (await api.get("/kb/jobs", params={"material_id": material_id})).json() == []
    refused = await api.post(f"/kb/materials/{material_id}/ingest")
    assert refused.status_code == 409
    assert refused.json()["detail"] == NO_SPEECH_FILE
