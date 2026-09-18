from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import Any

import httpx
import pytest

from tests.conftest import TOKEN, FakeHttp, make_wav

WAV_HEADERS = {"Content-Type": "audio/wav"}


async def create_session(client: httpx.AsyncClient, title: str = "Diagnostics") -> str:
    response = await client.post("/sessions", json={"title": title})
    assert response.status_code == 200, response.text
    return str(response.json()["id"])


async def store_chunk(
    client: httpx.AsyncClient,
    session_id: str,
    sequence: int,
    *,
    start_ms: int = 0,
    end_ms: int = 1000,
    body: bytes | None = None,
) -> httpx.Response:
    return await client.post(
        f"/sessions/{session_id}/audio/store",
        params={"sequence": sequence, "start_ms": start_ms, "end_ms": end_ms},
        content=body if body is not None else make_wav(1.0, frequency=220.0),
        headers=WAV_HEADERS,
    )


async def transcribe_chunk(
    client: httpx.AsyncClient,
    session_id: str,
    sequence: int,
    *,
    start_ms: int = 0,
    end_ms: int = 1000,
    body: bytes | None = None,
) -> httpx.Response:
    return await client.post(
        f"/sessions/{session_id}/audio",
        params={"sequence": sequence, "start_ms": start_ms, "end_ms": end_ms},
        content=body if body is not None else make_wav(1.0, frequency=330.0),
        headers=WAV_HEADERS,
    )


async def configure_openai(client: httpx.AsyncClient, *, consent: bool, with_key: bool) -> None:
    payload: dict[str, object] = {
        "asr": {"provider": "openai", "model": "gpt-4o-transcribe"},
        "cloud_consent": consent,
    }
    if with_key:
        payload["provider_keys"] = {"openai": "sk-test"}
    response = await client.put("/settings", json=payload)
    assert response.status_code == 200, response.text


async def test_store_preserves_nonzero_and_zero_pcm_exactly_without_asr(
    client: httpx.AsyncClient, outbound: FakeHttp
) -> None:
    session_id = await create_session(client)
    speech_like = make_wav(1.0, frequency=220.0)
    silence = make_wav(1.0, frequency=0.0)

    first = await store_chunk(client, session_id, 0, body=speech_like)
    second = await store_chunk(
        client, session_id, 1, start_ms=1000, end_ms=2000, body=silence
    )

    assert first.status_code == 201, first.text
    assert second.status_code == 201, second.text
    assert first.json() == {
        "sequence": 0,
        "start_ms": 0,
        "end_ms": 1000,
        "status": "pending",
        "available": True,
        "duplicate": False,
        "source_kind": "original_captured_wav",
    }
    assert (await client.get(f"/sessions/{session_id}/audio/0")).content == speech_like
    assert (await client.get(f"/sessions/{session_id}/audio/1")).content == silence
    assert (await client.get(f"/sessions/{session_id}")).json()["session"]["duration_ms"] == 2000
    assert outbound.requests == [], "persistence-only upload must never contact an ASR provider"


async def test_store_ignores_missing_key_and_cloud_consent(
    client: httpx.AsyncClient, outbound: FakeHttp
) -> None:
    await configure_openai(client, consent=False, with_key=False)
    session_id = await create_session(client)

    response = await store_chunk(client, session_id, 0)

    assert response.status_code == 201, response.text
    assert response.json()["available"] is True
    assert outbound.requests == []


async def test_store_remains_independent_after_asr_failure(
    client: httpx.AsyncClient, outbound: FakeHttp
) -> None:
    await configure_openai(client, consent=True, with_key=True)
    session_id = await create_session(client)
    outbound.json_route("POST", "audio/transcriptions", {"error": "upstream"}, status=503)
    failed = await transcribe_chunk(client, session_id, 0)
    requests_after_failure = len(outbound.requests)

    stored = await store_chunk(client, session_id, 1, start_ms=1000, end_ms=2000)

    assert failed.status_code == 502
    assert stored.status_code == 201, stored.text
    assert len(outbound.requests) == requests_after_failure


async def test_store_does_not_wait_for_the_transcription_backlog(
    client: httpx.AsyncClient, outbound: FakeHttp, app: Any
) -> None:
    await configure_openai(client, consent=True, with_key=True)
    session_id = await create_session(client)
    release = asyncio.Event()

    async def slow(_request: httpx.Request) -> httpx.Response:
        await release.wait()
        return httpx.Response(200, json={"text": "late"})

    outbound.routes[("POST", "audio/transcriptions")] = slow  # type: ignore[assignment]
    bound = app.state.runtime.config.max_pending_chunks
    transcription_tasks = [
        asyncio.create_task(transcribe_chunk(client, session_id, sequence))
        for sequence in range(bound)
    ]
    await asyncio.sleep(0.05)

    stored = await asyncio.wait_for(
        store_chunk(client, session_id, 99, start_ms=99_000, end_ms=100_000), timeout=0.5
    )
    release.set()
    await asyncio.gather(*transcription_tasks)

    assert stored.status_code == 201, stored.text
    assert stored.json()["status"] == "pending"


@pytest.mark.parametrize("status", ["paused", "stopped"])
async def test_capture_status_can_skip_transcription_flush_after_local_store(
    client: httpx.AsyncClient, outbound: FakeHttp, status: str
) -> None:
    await configure_openai(client, consent=True, with_key=True)
    session_id = await create_session(client)
    assert (await store_chunk(client, session_id, 0)).status_code == 201

    async def delayed_failure(_request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(10)
        return httpx.Response(503, json={"error": "delayed upstream failure"})

    outbound.routes[("POST", "audio/transcriptions")] = delayed_failure  # type: ignore[assignment]
    response = await asyncio.wait_for(
        client.patch(
            f"/sessions/{session_id}",
            json={"status": status, "flush_transcription": False},
        ),
        timeout=0.25,
    )

    assert response.status_code == 200, response.text
    assert response.json()["status"] == status
    assert outbound.requests == [], "capture-only status changes must not build or invoke ASR"
    manifest = (await client.get(f"/sessions/{session_id}/audio")).json()
    assert manifest["chunks"][0]["status"] == "pending"


async def test_capture_status_flushes_transcription_when_option_is_omitted(
    client: httpx.AsyncClient, outbound: FakeHttp
) -> None:
    await configure_openai(client, consent=True, with_key=True)
    session_id = await create_session(client)
    assert (await store_chunk(client, session_id, 0)).status_code == 201
    outbound.json_route("POST", "audio/transcriptions", {"text": "Legacy flush."})

    response = await client.patch(f"/sessions/{session_id}", json={"status": "paused"})

    assert response.status_code == 200, response.text
    assert len(outbound.requests) == 1
    manifest = (await client.get(f"/sessions/{session_id}/audio")).json()
    assert manifest["chunks"][0]["status"] == "done"


async def test_duplicate_conflict_and_missing_file_retry_are_safe(
    client: httpx.AsyncClient, config: Any
) -> None:
    session_id = await create_session(client)
    body = make_wav(1.0, frequency=440.0)
    assert (await store_chunk(client, session_id, 3, body=body)).status_code == 201

    duplicate = await store_chunk(client, session_id, 3, body=body)
    assert duplicate.status_code == 200
    assert duplicate.json()["duplicate"] is True

    stored_path = config.audio_dir / session_id / "000003.wav"
    stored_path.unlink()
    missing = (await client.get(f"/sessions/{session_id}/audio")).json()["chunks"][0]
    assert missing["available"] is False
    assert (await client.get(f"/sessions/{session_id}/audio/3")).status_code == 404

    repaired = await store_chunk(client, session_id, 3, body=body)
    assert repaired.status_code == 200, repaired.text
    assert repaired.json()["available"] is True
    assert stored_path.read_bytes() == body

    changed_audio = await store_chunk(client, session_id, 3, body=make_wav(1.0, frequency=880.0))
    changed_range = await store_chunk(
        client, session_id, 3, start_ms=1000, end_ms=2000, body=body
    )
    assert changed_audio.status_code == 409
    assert changed_range.status_code == 409


async def test_disk_failure_rolls_back_new_claim_and_allows_retry(
    client: httpx.AsyncClient, app: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    session_id = await create_session(client)
    service_type = type(app.state.runtime.ingestion)
    original_store = service_type._store_audio

    def fail_store(_path: Path, _body: bytes) -> None:
        raise OSError("private disk detail")

    monkeypatch.setattr(service_type, "_store_audio", staticmethod(fail_store))
    failed = await store_chunk(client, session_id, 8)
    assert failed.status_code == 500
    assert "private disk detail" not in failed.text
    assert (await client.get(f"/sessions/{session_id}/audio")).json()["chunks"] == []

    monkeypatch.setattr(service_type, "_store_audio", staticmethod(original_store))
    retried = await store_chunk(client, session_id, 8)
    assert retried.status_code == 201, retried.text


@pytest.mark.parametrize("failed_sync", [1, 2])
async def test_store_does_not_acknowledge_failed_disk_sync_and_allows_retry(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch, failed_sync: int
) -> None:
    session_id = await create_session(client)
    original_sync = os.fsync
    calls = 0

    def fail_sync(descriptor: int) -> None:
        nonlocal calls
        calls += 1
        if calls == failed_sync:
            raise OSError("private disk sync detail")
        original_sync(descriptor)

    with monkeypatch.context() as boundary:
        boundary.setattr(os, "fsync", fail_sync)
        failed = await store_chunk(client, session_id, 0)
    assert failed.status_code == 500
    assert "private disk sync detail" not in failed.text
    assert (await client.get(f"/sessions/{session_id}/audio")).json()["chunks"] == []
    retried = await store_chunk(client, session_id, 0)
    assert retried.status_code == 201, retried.text
    assert (await client.get(f"/sessions/{session_id}/audio/0")).content == make_wav(
        1.0, frequency=220.0
    )


async def test_manifest_has_stable_pagination_statuses_and_actual_segment_links(
    client: httpx.AsyncClient, outbound: FakeHttp
) -> None:
    await configure_openai(client, consent=True, with_key=True)
    session_id = await create_session(client)
    outbound.json_route("POST", "audio/transcriptions", {"text": "mapped"})
    transcribed = await transcribe_chunk(client, session_id, 5)
    segment_id = transcribed.json()["segments"][0]["id"]
    await store_chunk(client, session_id, 6, body=make_wav(1.0, frequency=0.0))
    outbound.json_route("POST", "audio/transcriptions", {"error": "down"}, status=503)
    assert (await transcribe_chunk(client, session_id, 7)).status_code == 502

    first = (await client.get(f"/sessions/{session_id}/audio", params={"limit": 2})).json()
    second = (
        await client.get(
            f"/sessions/{session_id}/audio", params={"after_sequence": 6, "limit": 2}
        )
    ).json()

    assert [item["sequence"] for item in first["chunks"]] == [5, 6]
    assert first["next_after_sequence"] == 6
    assert [item["sequence"] for item in second["chunks"]] == [7]
    assert second["next_after_sequence"] is None
    assert first["chunks"][0]["segment_ids"] == [segment_id]
    assert first["chunks"][1]["segment_ids"] == []
    assert second["chunks"][0]["segment_ids"] == []
    assert [first["chunks"][0]["status"], first["chunks"][1]["status"], second["chunks"][0]["status"]] == [
        "done",
        "pending",
        "failed",
    ]
    assert all(
        item["source_kind"] == "original_captured_wav"
        for item in [*first["chunks"], *second["chunks"]]
    )


async def test_manifest_and_store_require_auth_isolate_sessions_and_hide_paths(
    client: httpx.AsyncClient
) -> None:
    owner = await create_session(client, "owner")
    other = await create_session(client, "other")
    assert (await store_chunk(client, owner, 0)).status_code == 201

    unauthenticated_store = await client.post(
        f"/sessions/{owner}/audio/store",
        params={"sequence": 1, "start_ms": 1000, "end_ms": 2000},
        content=make_wav(1.0),
        headers={"Authorization": "", **WAV_HEADERS},
    )
    unauthenticated_manifest = await client.get(
        f"/sessions/{owner}/audio", headers={"Authorization": ""}
    )
    owner_manifest = (await client.get(f"/sessions/{owner}/audio")).json()
    other_manifest = (await client.get(f"/sessions/{other}/audio")).json()

    assert unauthenticated_store.status_code == 401
    assert unauthenticated_manifest.status_code == 401
    assert (await store_chunk(client, "missing", 0)).status_code == 404
    assert (await client.get("/sessions/missing/audio")).status_code == 404
    assert other_manifest == {"chunks": [], "next_after_sequence": None}
    assert set(owner_manifest["chunks"][0]) == {
        "sequence",
        "start_ms",
        "end_ms",
        "status",
        "available",
        "segment_ids",
        "source_kind",
    }
    assert "path" not in str(owner_manifest).lower()
    assert "audio_dir" not in str(owner_manifest).lower()
    assert TOKEN not in str(owner_manifest)


async def test_store_uses_the_existing_upload_validation_limits(
    client: httpx.AsyncClient, config: Any
) -> None:
    session_id = await create_session(client)
    invalid_range = await store_chunk(client, session_id, 0, start_ms=1000, end_ms=1000)
    invalid_wav = await store_chunk(client, session_id, 0, body=b"not a wav")
    oversized = await store_chunk(
        client, session_id, 0, body=b"0" * (config.max_chunk_bytes + 1)
    )
    negative_sequence = await store_chunk(client, session_id, -1)
    zero_limit = await client.get(f"/sessions/{session_id}/audio", params={"limit": 0})
    excessive_limit = await client.get(f"/sessions/{session_id}/audio", params={"limit": 201})
    negative_cursor = await client.get(
        f"/sessions/{session_id}/audio", params={"after_sequence": -1}
    )

    assert invalid_range.status_code == 422
    assert invalid_wav.status_code == 400
    assert oversized.status_code == 413
    assert negative_sequence.status_code == 422
    assert zero_limit.status_code == 422
    assert excessive_limit.status_code == 422
    assert negative_cursor.status_code == 422
