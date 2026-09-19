"""Import API: the whole paid path, with a scripted provider and no real calls.

The point of these tests is what the user is promised: a job id that survives a
restart, a transport failure that waits instead of charging twice, a cancellation
that tells the truth about a race, and a failure that keeps its reason.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import httpx
import pytest

from audiohelper.app import create_app
from audiohelper.config import AppConfig
from audiohelper.gateways.soniox_async import ASYNC_MODEL
from audiohelper.secrets import MemorySecretStore

from .conftest import TOKEN, FakeHttp

FILE_ID = "84c32fc6-4fb5-4e7a-b656-b5ec70493753"
JOB_ID = "73d4357d-cad2-4338-a60d-ec6f2044f721"


@pytest.fixture(autouse=True)
def _fast_polling(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep the real backoff logic, remove the wall-clock wait."""
    monkeypatch.setattr("audiohelper.import_service.POLL_SCHEDULE", (0.0,))


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


async def settle(client: httpx.AsyncClient, session_id: str, *, expect: str) -> dict[str, Any]:
    """Wait for the background import task to reach a settled state."""
    for _ in range(400):
        await asyncio.sleep(0.01)
        response = await client.get(f"/imports/{session_id}")
        if response.status_code == 404:
            return {"status": "deleted"}
        body = response.json()
        if body["status"] == expect:
            return body
    raise AssertionError(f"import never reached {expect}")


async def start_import(client: httpx.AsyncClient, path: Path, **over: Any) -> dict[str, Any]:
    response = await client.post("/imports", json={
        "path": str(path), "title": "Лекция", "declared_duration_ms": 2_500, **over,
    })
    assert response.status_code == 201, response.text
    return response.json()


async def test_import_produces_a_live_shaped_transcript_with_speakers(
    ready: httpx.AsyncClient, tmp_path: Path, provider: Provider,
) -> None:
    created = await start_import(ready, audio_file(tmp_path))
    session_id = created["session"]["id"]
    await settle(ready, session_id, expect="completed")

    live = (await ready.get(f"/sessions/{session_id}/live")).json()
    assert [token["text"] for token in live["final_tokens"]] == ["Добрый ", "день", "Отвечаю"]
    assert [speaker["number"] for speaker in live["speakers"]] == [1, 2]

    detail = (await ready.get(f"/sessions/{session_id}")).json()
    assert [segment["text"] for segment in detail["segments"]] == ["Добрый день", "Отвечаю"]
    assert detail["session"]["duration_ms"] == 2_500


async def test_request_asks_for_diarization_and_no_translation_by_default(
    ready: httpx.AsyncClient, tmp_path: Path, provider: Provider,
) -> None:
    created = await start_import(ready, audio_file(tmp_path))
    await settle(ready, created["session"]["id"], expect="completed")

    body = provider.create_bodies[0]
    assert body["model"] == ASYNC_MODEL
    assert body["enable_speaker_diarization"] is True
    assert "translation" not in body


async def test_translation_is_requested_only_when_asked(
    ready: httpx.AsyncClient, tmp_path: Path, provider: Provider,
) -> None:
    created = await start_import(ready, audio_file(tmp_path), translate=True)
    await settle(ready, created["session"]["id"], expect="completed")

    assert provider.create_bodies[0]["translation"] == {"type": "one_way", "target_language": "ru"}


async def test_uploaded_file_is_deleted_from_the_provider_after_success(
    ready: httpx.AsyncClient, tmp_path: Path, provider: Provider,
) -> None:
    created = await start_import(ready, audio_file(tmp_path))
    await settle(ready, created["session"]["id"], expect="completed")

    assert provider.deleted_files == [FILE_ID]


async def test_a_transport_failure_waits_instead_of_creating_a_second_job(
    ready: httpx.AsyncClient, tmp_path: Path, provider: Provider,
) -> None:
    provider.queue(
        provider.processing(), provider.unreachable(), provider.unreachable(),
        provider.processing(),
    )
    created = await start_import(ready, audio_file(tmp_path))
    await settle(ready, created["session"]["id"], expect="completed")

    # The job was paid for once; connectivity problems never buy a second one.
    assert provider.create_calls == 1
    assert provider.upload_calls == 1


async def test_a_provider_error_fails_the_import_and_keeps_its_reason(
    ready: httpx.AsyncClient, tmp_path: Path, provider: Provider,
) -> None:
    provider.queue(provider.failed("audio_decode_failed", "The audio could not be decoded."))
    created = await start_import(ready, audio_file(tmp_path))
    record = await settle(ready, created["session"]["id"], expect="failed")

    assert "audio_decode_failed" in record["error"]
    # The session survives so the user can read what happened and decide.
    assert (await ready.get(f"/sessions/{created['session']['id']}")).status_code == 200


async def test_a_failed_import_is_never_retried_automatically(
    ready: httpx.AsyncClient, tmp_path: Path, provider: Provider,
) -> None:
    provider.queue(provider.failed("audio_decode_failed", "Bad file."))
    created = await start_import(ready, audio_file(tmp_path))
    await settle(ready, created["session"]["id"], expect="failed")
    await asyncio.sleep(0.2)

    assert provider.create_calls == 1


async def test_retry_starts_a_new_session_and_a_new_job(
    ready: httpx.AsyncClient, tmp_path: Path, provider: Provider,
) -> None:
    provider.queue(provider.failed("audio_decode_failed", "Bad file."))
    created = await start_import(ready, audio_file(tmp_path))
    failed_id = created["session"]["id"]
    await settle(ready, failed_id, expect="failed")

    response = await ready.post(f"/imports/{failed_id}/retry")
    assert response.status_code == 201
    retried_id = response.json()["session"]["id"]
    assert retried_id != failed_id
    await settle(ready, retried_id, expect="completed")
    assert provider.create_calls == 2


async def test_cancelling_a_running_import_removes_provider_side_copies(
    ready: httpx.AsyncClient, tmp_path: Path, provider: Provider,
) -> None:
    provider.queue(*[provider.processing() for _ in range(200)])
    created = await start_import(ready, audio_file(tmp_path))
    session_id = created["session"]["id"]
    for _ in range(400):
        await asyncio.sleep(0.01)
        if (await ready.get(f"/imports/{session_id}")).json()["status"] == "processing":
            break

    response = await ready.post(f"/imports/{session_id}/cancel")
    assert response.status_code == 200
    assert response.json()["status"] == "cancelled"
    assert provider.deleted_files == [FILE_ID]
    assert provider.deleted_jobs == [JOB_ID]


async def test_a_refused_job_deletion_does_not_break_cancellation(
    ready: httpx.AsyncClient, tmp_path: Path, provider: Provider,
) -> None:
    # The provider refuses to delete a processing job; that is not our failure.
    provider.job_deletion_status = 409
    provider.queue(*[provider.processing() for _ in range(200)])
    created = await start_import(ready, audio_file(tmp_path))
    session_id = created["session"]["id"]
    for _ in range(400):
        await asyncio.sleep(0.01)
        if (await ready.get(f"/imports/{session_id}")).json()["status"] == "processing":
            break

    assert (await ready.post(f"/imports/{session_id}/cancel")).json()["status"] == "cancelled"


async def test_cancelling_after_completion_keeps_the_paid_transcript(
    ready: httpx.AsyncClient, tmp_path: Path, provider: Provider,
) -> None:
    created = await start_import(ready, audio_file(tmp_path))
    session_id = created["session"]["id"]
    await settle(ready, session_id, expect="completed")

    response = await ready.post(f"/imports/{session_id}/cancel")
    assert response.status_code == 200
    # The race was lost: the work is billed, so the result is kept, not destroyed.
    assert response.json()["status"] == "completed"
    detail = (await ready.get(f"/sessions/{session_id}")).json()
    assert detail["segments"]


async def test_import_requires_cloud_consent_and_leaves_no_session_behind(
    client: httpx.AsyncClient, secrets: MemorySecretStore, tmp_path: Path, provider: Provider,
) -> None:
    secrets.set("soniox", "test-soniox-key")
    before = len((await client.get("/sessions")).json()["sessions"])

    response = await client.post("/imports", json={
        "path": str(audio_file(tmp_path)), "title": "Лекция",
    })
    assert response.status_code == 409
    assert "consent" in response.json()["detail"].lower()
    assert provider.upload_calls == 0
    assert len((await client.get("/sessions")).json()["sessions"]) == before


async def test_import_requires_an_api_key(
    client: httpx.AsyncClient, tmp_path: Path, provider: Provider,
) -> None:
    await client.put("/settings", json={"cloud_consent": True})
    response = await client.post("/imports", json={
        "path": str(audio_file(tmp_path)), "title": "Лекция",
    })

    assert response.status_code == 409
    assert provider.upload_calls == 0


async def test_an_unsupported_container_is_rejected_before_upload(
    ready: httpx.AsyncClient, tmp_path: Path, provider: Provider,
) -> None:
    response = await ready.post("/imports", json={
        "path": str(audio_file(tmp_path, "notes.txt")), "title": "Лекция",
    })

    assert response.status_code == 400
    assert ".txt" in response.json()["detail"]
    assert provider.upload_calls == 0


async def test_a_missing_file_is_rejected_without_a_session(
    ready: httpx.AsyncClient, tmp_path: Path, provider: Provider,
) -> None:
    before = len((await ready.get("/sessions")).json()["sessions"])
    response = await ready.post("/imports", json={
        "path": str(tmp_path / "gone.mp3"), "title": "Лекция",
    })

    assert response.status_code == 400
    assert len((await ready.get("/sessions")).json()["sessions"]) == before


async def test_a_file_longer_than_the_provider_limit_is_refused(
    ready: httpx.AsyncClient, tmp_path: Path, provider: Provider,
) -> None:
    response = await ready.post("/imports", json={
        "path": str(audio_file(tmp_path)), "title": "Лекция",
        "declared_duration_ms": 301 * 60 * 1000,
    })

    assert response.status_code == 422
    assert provider.upload_calls == 0


async def test_capabilities_tell_the_dialog_what_it_may_promise(
    ready: httpx.AsyncClient, provider: Provider,
) -> None:
    body = (await ready.get("/imports")).json()

    assert "m4a" in body["supported_extensions"]
    assert body["max_duration_ms"] == 300 * 60 * 1000
    assert body["rate_per_hour_usd"] == 0.10
    assert body["translation_rate_per_hour_usd"] == 0.15
    assert body["warn_above_usd"] == 0.30
    assert body["cloud_consent"] is True and body["has_api_key"] is True
    assert body["max_concurrent_imports"] == 3
    # Markdown projection is off by default: say so instead of inventing a path.
    assert body["markdown_enabled"] is False
    assert "хранилище" in body["destination"]


async def test_the_cost_warning_threshold_can_be_changed_and_cleared(
    ready: httpx.AsyncClient, provider: Provider,
) -> None:
    await ready.put("/settings", json={"import_cost_warning_usd": 1.5})
    assert (await ready.get("/imports")).json()["warn_above_usd"] == 1.5

    await ready.put("/settings", json={"clear_import_cost_warning": True})
    assert (await ready.get("/imports")).json()["warn_above_usd"] is None


async def test_a_microphone_cannot_record_into_an_imported_session(
    ready: httpx.AsyncClient, tmp_path: Path, provider: Provider,
) -> None:
    created = await start_import(ready, audio_file(tmp_path))
    session_id = created["session"]["id"]
    await settle(ready, session_id, expect="completed")

    # The live route must refuse rather than append microphone speech to a file
    # transcript: the two have no shared time axis and no comparable speakers.
    from starlette.testclient import TestClient

    from audiohelper.app import create_app

    app = ready._transport.app  # type: ignore[attr-defined]
    assert create_app is not None
    with (
        TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as http,
        http.websocket_connect(
            f"ws://127.0.0.1/sessions/{session_id}/live/stream",
            headers={"Authorization": f"Bearer {TOKEN}"},
        ) as socket,
    ):
        socket.send_json({"type": "open", "sample_rate": 16000})
        assert socket.receive_json() == {"type": "stream.error", "code": "invalid_stream"}


async def test_an_unfinished_import_is_resumed_after_a_restart(
    config: AppConfig, outbound: FakeHttp, secrets: MemorySecretStore, tmp_path: Path,
) -> None:
    provider = Provider(outbound)
    secrets.set("soniox", "test-soniox-key")
    provider.queue(*[provider.processing() for _ in range(500)])

    first = create_app(config, secret_store=secrets, http_client=outbound.client())
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=first), base_url="http://127.0.0.1:8765",
        headers={"Authorization": f"Bearer {TOKEN}"},
    ) as client:
        await client.put("/settings", json={"cloud_consent": True})
        created = await start_import(client, audio_file(tmp_path))
        session_id = created["session"]["id"]
        for _ in range(400):
            await asyncio.sleep(0.01)
            if (await client.get(f"/imports/{session_id}")).json()["status"] == "processing":
                break
    # Simulate a hard stop: the process goes away while the provider keeps working.
    await first.state.runtime.imports.close()
    first.state.runtime.close()

    provider.statuses.clear()
    second = create_app(config, secret_store=secrets, http_client=outbound.client())
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=second), base_url="http://127.0.0.1:8765",
        headers={"Authorization": f"Bearer {TOKEN}"},
    ) as client:
        async with httpx.AsyncClient() as _idle:
            pass
        # Entering the app's lifespan is what resumes unfinished imports.
        async with second.router.lifespan_context(second):
            record = await settle(client, session_id, expect="completed")
    second.state.runtime.close()

    assert record["audio_duration_ms"] == 2_500
    # The recovered run reuses the stored job; it never pays for a second one.
    assert provider.create_calls == 1
    assert provider.upload_calls == 1
