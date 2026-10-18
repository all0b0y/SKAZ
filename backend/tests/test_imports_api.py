"""File imports: the whole provider path, with a scripted provider and no real calls.

The point of these tests is what the user is promised: a job id that survives a
restart, a transport failure that waits instead of charging twice, a cancellation
that tells the truth about a race, and a failure that keeps its reason.

The import routes of the old interface are gone; the Knowledge Wiki starts,
cancels and retries an import through ``LegacySpeech`` (``knowledge/speech/legacy.py``)
over ``runtime.imports``, so these tests drive exactly that bridge. The request
checks made in front of it (absolute path, file type, duration, no session left
behind) belong to ``/kb/imports`` and are covered in
``tests/knowledge/test_speech_imports_api.py``.
"""

from __future__ import annotations

import asyncio
import dataclasses
from pathlib import Path
from typing import Any

import httpx
import pytest

from skaz import repository as repo
from skaz.app import create_app
from skaz.config import AppConfig
from skaz.gateways import ProviderNotConfigured
from skaz.gateways.soniox_async import ASYNC_MODEL
from skaz.import_service import ImportRequest
from skaz.knowledge.speech.legacy import LegacySpeech
from skaz.secrets import MemorySecretStore

from .conftest import TOKEN, FakeHttp
from .sessions_support import (
    adelete,
    create_import_session,
    runtime_of,
    session_count,
    session_detail,
    session_gone,
)

FILE_ID = "84c32fc6-4fb5-4e7a-b656-b5ec70493753"
JOB_ID = "73d4357d-cad2-4338-a60d-ec6f2044f721"


@pytest.fixture(autouse=True)
def _fast_polling(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep the real backoff logic, remove the wall-clock wait."""
    monkeypatch.setattr("skaz.import_service.POLL_SCHEDULE", (0.0,))


def audio_file(tmp_path: Path, name: str = "lecture.m4a") -> Path:
    path = tmp_path / name
    path.write_bytes(b"\x00\x01" * 2048)
    return path


class Provider:
    """A scripted Soniox async endpoint: records calls, replays job states."""

    def __init__(self, outbound: FakeHttp) -> None:
        self.statuses: list[dict[str, Any]] = []
        self.tokens: list[dict[str, Any]] = [
            {"text": "Добрый ", "start_ms": 0, "end_ms": 400, "confidence": 0.9,
             "speaker": "1", "language": "ru"},
            {"text": "день", "start_ms": 400, "end_ms": 900, "confidence": 0.9,
             "speaker": "1", "language": "ru"},
            {"text": "Отвечаю", "start_ms": 1_400, "end_ms": 2_100, "confidence": 0.9,
             "speaker": "2", "language": "ru"},
        ]
        self.upload_calls = 0
        self.create_calls = 0
        self.deleted_files: list[str] = []
        self.deleted_jobs: list[str] = []
        self.create_bodies: list[Any] = []
        self.job_deletion_status = 204

        @outbound.route("POST", "/v1/files")
        def _upload(_request: httpx.Request) -> httpx.Response:
            self.upload_calls += 1
            return httpx.Response(201, json={
                "id": FILE_ID, "filename": "lecture.m4a", "size": 4096,
                "created_at": "2026-01-01T00:00:00Z",
            })

        @outbound.route("POST", "/v1/transcriptions")
        def _create(request: httpx.Request) -> httpx.Response:
            self.create_calls += 1
            import json as jsonlib

            self.create_bodies.append(jsonlib.loads(request.content))
            return httpx.Response(201, json=self._job("queued"))

        @outbound.route("GET", f"{JOB_ID}/transcript")
        def _transcript(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"id": JOB_ID, "text": "x", "tokens": self.tokens})

        @outbound.route("GET", f"/v1/transcriptions/{JOB_ID}")
        def _status(_request: httpx.Request) -> httpx.Response:
            state = self.statuses.pop(0) if self.statuses else self._job("completed", 2_500)
            if "http_status" in state:
                return httpx.Response(state["http_status"], json={"error_type": "overloaded"})
            return httpx.Response(200, json=state)

        @outbound.route("DELETE", "/v1/files/")
        def _delete_file(request: httpx.Request) -> httpx.Response:
            self.deleted_files.append(str(request.url).rsplit("/", 1)[-1])
            return httpx.Response(204)

        @outbound.route("DELETE", f"/v1/transcriptions/{JOB_ID}")
        def _delete_job(request: httpx.Request) -> httpx.Response:
            self.deleted_jobs.append(str(request.url).rsplit("/", 1)[-1])
            return httpx.Response(self.job_deletion_status, json={"error_type": "invalid_state"})

    def _job(self, status: str, duration: int | None = None) -> dict[str, Any]:
        return {"id": JOB_ID, "status": status, "audio_duration_ms": duration,
                "error_type": None, "error_message": None, "model": ASYNC_MODEL,
                "created_at": "2026-01-01T00:00:00Z", "filename": "lecture.m4a",
                "enable_speaker_diarization": True, "enable_language_identification": True}

    def queue(self, *states: dict[str, Any]) -> None:
        self.statuses.extend(states)

    def processing(self) -> dict[str, Any]:
        return self._job("processing")

    def failed(self, error_type: str, message: str) -> dict[str, Any]:
        return {**self._job("error"), "error_type": error_type, "error_message": message}

    def unreachable(self, http_status: int = 503) -> dict[str, Any]:
        return {"http_status": http_status}


@pytest.fixture
def provider(outbound: FakeHttp) -> Provider:
    return Provider(outbound)


@pytest.fixture
async def ready(
    client: httpx.AsyncClient, secrets: MemorySecretStore, provider: Provider,
) -> httpx.AsyncClient:
    secrets.set("soniox", "test-soniox-key")
    response = await client.put("/settings", json={"cloud_consent": True})
    assert response.status_code == 200
    return client


def speech(client: httpx.AsyncClient) -> LegacySpeech:
    """The bridge the Knowledge Wiki's speech area uses to run imports."""
    return LegacySpeech(runtime_of(client))


def import_view(client: httpx.AsyncClient, session_id: str) -> dict[str, Any] | None:
    record = runtime_of(client).imports.store.get(session_id)
    return None if record is None else dataclasses.asdict(record)


async def settle(client: httpx.AsyncClient, session_id: str, *, expect: str) -> dict[str, Any]:
    """Wait for the background import task to reach a settled state."""
    for _ in range(400):
        await asyncio.sleep(0.01)
        view = import_view(client, session_id)
        if view is None:
            return {"status": "deleted"}
        if view["status"] == expect:
            return view
    raise AssertionError(f"import never reached {expect}")


async def start_import(client: httpx.AsyncClient, path: Path, *, translate: bool = False,
                       declared_duration_ms: int | None = 2_500, title: str = "Лекция") -> str:
    bridge = speech(client)
    session_id = bridge.create_import_session(title)
    await bridge.start_import(ImportRequest(session_id=session_id, path=path, translate=translate,
                                            declared_duration_ms=declared_duration_ms))
    return session_id


async def refused_import(client: httpx.AsyncClient, path: Path) -> Exception:
    """Start an import that must be refused; the refusal is returned for inspection."""
    session_id = create_import_session(client, "Лекция")
    with pytest.raises(Exception) as refused:
        await speech(client).start_import(ImportRequest(session_id=session_id, path=path, translate=False,
                                                        declared_duration_ms=None))
    return refused.value


async def wait_processing(client: httpx.AsyncClient, session_id: str) -> None:
    for _ in range(400):
        await asyncio.sleep(0.01)
        view = import_view(client, session_id)
        if view is not None and view["status"] == "processing":
            return


@pytest.mark.parametrize("finished", [True, False])
async def test_an_import_can_be_deleted_without_touching_source(
    ready: httpx.AsyncClient, tmp_path: Path, provider: Provider, finished: bool,
) -> None:
    if not finished:
        provider.queue(*[provider.processing() for _ in range(200)])
    source = audio_file(tmp_path)
    original = source.read_bytes()
    sid = await start_import(ready, source)
    await settle(ready, sid, expect="completed" if finished else "processing")
    await adelete(ready, sid)
    assert session_gone(ready, sid)
    assert import_view(ready, sid) is None
    assert source.read_bytes() == original


async def test_import_origin_survives_rename(ready: httpx.AsyncClient, tmp_path: Path) -> None:
    sid = await start_import(ready, audio_file(tmp_path))
    await settle(ready, sid, expect="completed")
    session = repo.get_session(runtime_of(ready).db, sid)
    assert session is not None and session.origin == "import"
    assert (await ready.patch(f"/sessions/{sid}", json={"title": "Renamed"})).json()["origin"] == "import"


async def test_import_produces_a_live_shaped_transcript_with_speakers(
    ready: httpx.AsyncClient, tmp_path: Path, provider: Provider,
) -> None:
    session_id = await start_import(ready, audio_file(tmp_path))
    await settle(ready, session_id, expect="completed")

    live = (await ready.get(f"/sessions/{session_id}/live")).json()
    assert [token["text"] for token in live["final_tokens"]] == ["Добрый ", "день", "Отвечаю"]
    assert [speaker["number"] for speaker in live["speakers"]] == [1, 2]

    detail = session_detail(ready, session_id)
    assert detail is not None
    assert [segment["text"] for segment in detail["segments"]] == ["Добрый день", "Отвечаю"]
    assert detail["session"]["duration_ms"] == 2_500


async def test_request_asks_for_diarization_and_no_translation_by_default(
    ready: httpx.AsyncClient, tmp_path: Path, provider: Provider,
) -> None:
    await settle(ready, await start_import(ready, audio_file(tmp_path)), expect="completed")

    body = provider.create_bodies[0]
    assert body["model"] == ASYNC_MODEL
    assert body["enable_speaker_diarization"] is True
    assert "translation" not in body


async def test_translation_is_requested_only_when_asked(
    ready: httpx.AsyncClient, tmp_path: Path, provider: Provider,
) -> None:
    await settle(ready, await start_import(ready, audio_file(tmp_path), translate=True), expect="completed")

    assert provider.create_bodies[0]["translation"] == {"type": "one_way", "target_language": "ru"}


async def test_uploaded_file_is_deleted_from_the_provider_after_success(
    ready: httpx.AsyncClient, tmp_path: Path, provider: Provider,
) -> None:
    await settle(ready, await start_import(ready, audio_file(tmp_path)), expect="completed")

    assert provider.deleted_files == [FILE_ID]


async def test_a_transport_failure_waits_instead_of_creating_a_second_job(
    ready: httpx.AsyncClient, tmp_path: Path, provider: Provider,
) -> None:
    provider.queue(
        provider.processing(), provider.unreachable(), provider.unreachable(),
        provider.processing(),
    )
    await settle(ready, await start_import(ready, audio_file(tmp_path)), expect="completed")

    # The job was paid for once; connectivity problems never buy a second one.
    assert provider.create_calls == 1
    assert provider.upload_calls == 1


async def test_a_provider_error_fails_the_import_and_keeps_its_reason(
    ready: httpx.AsyncClient, tmp_path: Path, provider: Provider,
) -> None:
    provider.queue(provider.failed("audio_decode_failed", "The audio could not be decoded."))
    session_id = await start_import(ready, audio_file(tmp_path))
    record = await settle(ready, session_id, expect="failed")

    assert "audio_decode_failed" in record["error"]
    # The session survives so the user can read what happened and decide.
    assert not session_gone(ready, session_id)


async def test_an_unexpected_error_fails_the_import_instead_of_leaving_it_running(
    ready: httpx.AsyncClient, tmp_path: Path, provider: Provider, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """H5: an untyped exception used to end the task and leave the import "running" until a restart."""
    async def broken(_self: Any, _record: Any) -> None:
        raise KeyError("model cache entry")

    monkeypatch.setattr("skaz.import_service.ImportService._execute", broken)
    session_id = await start_import(ready, audio_file(tmp_path))
    record = await settle(ready, session_id, expect="failed")
    assert "KeyError" in record["error"] and "Retry" in record["error"]


async def test_a_failed_import_is_never_retried_automatically(
    ready: httpx.AsyncClient, tmp_path: Path, provider: Provider,
) -> None:
    provider.queue(provider.failed("audio_decode_failed", "Bad file."))
    await settle(ready, await start_import(ready, audio_file(tmp_path)), expect="failed")
    await asyncio.sleep(0.2)

    assert provider.create_calls == 1


async def test_retry_recovers_existing_job_in_the_same_session(
    ready: httpx.AsyncClient, tmp_path: Path, provider: Provider,
) -> None:
    provider.queue(provider.failed("audio_decode_failed", "Bad file."))
    failed_id = await start_import(ready, audio_file(tmp_path))
    await settle(ready, failed_id, expect="failed")

    record = await speech(ready).retry_import(failed_id)
    assert record.session_id == failed_id
    await settle(ready, failed_id, expect="completed")
    assert provider.create_calls == 1


async def test_cancelling_a_running_import_removes_provider_side_copies(
    ready: httpx.AsyncClient, tmp_path: Path, provider: Provider, monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A zero poll delay lets a fast machine drain every "processing" reply before
    # the cancel request lands; keep the job running long enough to cancel it.
    monkeypatch.setattr("skaz.import_service.POLL_SCHEDULE", (0.05,))
    provider.queue(*[provider.processing() for _ in range(200)])
    session_id = await start_import(ready, audio_file(tmp_path))
    await wait_processing(ready, session_id)

    record = await speech(ready).cancel_import(session_id)
    assert record.status == "cancelled"
    assert provider.deleted_files == [FILE_ID]
    assert provider.deleted_jobs == [JOB_ID]
    # A cancelled import's session goes with it.
    assert session_gone(ready, session_id)


async def test_a_refused_job_deletion_does_not_break_cancellation(
    ready: httpx.AsyncClient, tmp_path: Path, provider: Provider, monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The provider refuses to delete a processing job; that is not our failure.
    monkeypatch.setattr("skaz.import_service.POLL_SCHEDULE", (0.05,))
    provider.job_deletion_status = 409
    provider.queue(*[provider.processing() for _ in range(200)])
    session_id = await start_import(ready, audio_file(tmp_path))
    await wait_processing(ready, session_id)

    assert (await speech(ready).cancel_import(session_id)).status == "cancelled"


async def test_cancelling_after_completion_keeps_the_paid_transcript(
    ready: httpx.AsyncClient, tmp_path: Path, provider: Provider,
) -> None:
    session_id = await start_import(ready, audio_file(tmp_path))
    await settle(ready, session_id, expect="completed")

    record = await speech(ready).cancel_import(session_id)
    # The race was lost: the work is done, so the result is kept, not destroyed.
    assert record.status == "completed"
    detail = session_detail(ready, session_id)
    assert detail is not None and detail["segments"]


async def test_import_requires_cloud_consent(
    client: httpx.AsyncClient, secrets: MemorySecretStore, tmp_path: Path, provider: Provider,
) -> None:
    secrets.set("soniox", "test-soniox-key")
    refused = await refused_import(client, audio_file(tmp_path))
    assert isinstance(refused, ProviderNotConfigured)
    assert "Send audio to Soniox" in str(refused) and "Recording & speech" in str(refused)  # QA B6
    assert provider.upload_calls == 0


async def test_import_requires_an_api_key(
    client: httpx.AsyncClient, tmp_path: Path, provider: Provider,
) -> None:
    await client.put("/settings", json={"cloud_consent": True})
    refused = await refused_import(client, audio_file(tmp_path))
    assert isinstance(refused, ProviderNotConfigured)
    assert provider.upload_calls == 0


async def test_a_missing_file_is_rejected_before_upload(
    ready: httpx.AsyncClient, tmp_path: Path, provider: Provider,
) -> None:
    refused = await refused_import(ready, tmp_path / "gone.mp3")
    assert "no longer exists" in str(refused)
    assert provider.upload_calls == 0


async def test_an_import_cannot_queue_behind_another(
    ready: httpx.AsyncClient, tmp_path: Path, provider: Provider, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Still never queued — but no longer refused: a second import starts at once beside the first."""
    monkeypatch.setattr("skaz.import_service.POLL_SCHEDULE", (10.0,))
    source = audio_file(tmp_path)
    first = await start_import(ready, source)
    await start_import(ready, source, title="Second")
    assert session_count(ready) == 2
    assert import_view(ready, first) is not None
    assert runtime_of(ready).imports.active == 2


async def test_a_microphone_cannot_record_into_an_imported_session(
    ready: httpx.AsyncClient, tmp_path: Path, provider: Provider,
) -> None:
    session_id = await start_import(ready, audio_file(tmp_path))
    await settle(ready, session_id, expect="completed")
    # The import task finishes its provider clean-up after the record settles; the
    # TestClient below closes the app on its own loop, so nothing may still run here.
    for _ in range(400):
        if runtime_of(ready).imports.active == 0:
            break
        await asyncio.sleep(0.01)

    # The live route must refuse rather than append microphone speech to a file
    # transcript: the two have no shared time axis and no comparable speakers.
    from starlette.testclient import TestClient

    app = ready._transport.app  # type: ignore[attr-defined]
    with (
        TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as http,
        http.websocket_connect(
            f"ws://127.0.0.1/sessions/{session_id}/live/stream",
            headers={"Authorization": f"Bearer {TOKEN}"},
        ) as socket,
    ):
        socket.send_json({"type": "open", "sample_rate": 16000})
        assert socket.receive_json() == {"type": "stream.error", "code": "invalid_stream"}


async def test_an_unfinished_import_waits_for_manual_retry_after_restart(
    config: AppConfig, outbound: FakeHttp, secrets: MemorySecretStore, tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A zero poll delay lets a slow runner drain all queued "processing" replies, and
    # finish the import, before the loop below ever observes it processing.
    monkeypatch.setattr("skaz.import_service.POLL_SCHEDULE", (0.01,))
    provider = Provider(outbound)
    secrets.set("soniox", "test-soniox-key")
    provider.queue(*[provider.processing() for _ in range(500)])

    first = create_app(config, secret_store=secrets, http_client=outbound.client())
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=first), base_url="http://127.0.0.1:8765",
        headers={"Authorization": f"Bearer {TOKEN}"},
    ) as client:
        await client.put("/settings", json={"cloud_consent": True})
        session_id = await start_import(client, audio_file(tmp_path))
        await wait_processing(client, session_id)
        view = import_view(client, session_id)
        assert view is not None and view["status"] == "processing"
    # Simulate a hard stop: the process goes away while the provider keeps working.
    await first.state.runtime.imports.close()
    first.state.runtime.close()

    provider.statuses.clear()
    second = create_app(config, secret_store=secrets, http_client=outbound.client())
    # Entering the app's lifespan is what resumes unfinished imports.
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=second), base_url="http://127.0.0.1:8765",
        headers={"Authorization": f"Bearer {TOKEN}"},
    ) as client, second.router.lifespan_context(second):
        interrupted = await settle(client, session_id, expect="interrupted")
        assert interrupted["status"] == "interrupted"
        await asyncio.sleep(0.05)
        view = import_view(client, session_id)
        assert view is not None and view["status"] == "interrupted"
        await speech(client).retry_import(session_id)
        record = await settle(client, session_id, expect="completed")
    second.state.runtime.close()

    assert record["audio_duration_ms"] == 2_500
    # The recovered run reuses the stored job; it never pays for a second one.
    assert provider.create_calls == 1
    assert provider.upload_calls == 1
