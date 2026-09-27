from __future__ import annotations

import asyncio
import os
from typing import Any

import httpx
import pytest

from tests.conftest import FakeHttp, make_wav

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
        f"/sessions/{session_id}/audio/buffer",
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


async def test_buffer_accepts_pcm_without_archiving_or_invoking_asr(
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
    assert (await client.get(f"/sessions/{session_id}/audio/0")).status_code == 404
    assert (await client.get(f"/sessions/{session_id}/audio/1")).status_code == 404
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
async def test_pause_discards_buffer_without_hidden_asr(
    client: httpx.AsyncClient, app: Any, outbound: FakeHttp, status: str,
) -> None:
    sid = await create_session(client)
    assert (await store_chunk(client, sid, 0)).status_code == 201
    assert app.state.runtime.ingestion.audio.get(sid, 0) == make_wav(1.0, frequency=220)
    response = await client.patch(f"/sessions/{sid}", json={"status": status, "flush_transcription": False})
    assert response.status_code == 200
    with pytest.raises(FileNotFoundError):
        app.state.runtime.ingestion.audio.get(sid, 0)
    assert not outbound.requests


async def test_flush_uses_only_live_input_and_keeps_text(
    client: httpx.AsyncClient, outbound: FakeHttp
) -> None:
    await configure_openai(client, consent=True, with_key=True)
    sid = await create_session(client)
    await store_chunk(client, sid, 0)
    outbound.json_route("POST", "audio/transcriptions", {"text": "Retained text."})
    assert (await client.patch(f"/sessions/{sid}", json={"status": "paused"})).status_code == 200
    assert len(outbound.requests) == 1
    assert (await client.get(f"/sessions/{sid}")).json()["segments"][0]["text"] == "Retained text."
    assert (await client.get(f"/sessions/{sid}/audio")).status_code == 405


async def test_duplicate_resubmission_requires_same_bytes_and_range(
    client: httpx.AsyncClient, app: Any
) -> None:
    sid = await create_session(client)
    body = make_wav(1.0, frequency=440)
    assert (await store_chunk(client, sid, 3, body=body)).status_code == 201
    app.state.runtime.ingestion.audio.discard(sid)
    duplicate = await store_chunk(client, sid, 3, body=body)
    assert duplicate.status_code == 200 and duplicate.json()["duplicate"]
    assert app.state.runtime.ingestion.audio.get(sid, 3) == body
    assert (await store_chunk(client, sid, 3, body=make_wav(1.0, frequency=880))).status_code == 409
    assert (await store_chunk(client, sid, 3, body=body, start_ms=1000, end_ms=2000)).status_code == 409
    assert not list(app.state.runtime.config.data_dir.rglob("*.wav"))


async def test_input_never_calls_audio_filesystem_writer(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch, app: Any,
) -> None:
    sid = await create_session(client)
    def no_audio_sync(_fd: int) -> None:
        raise AssertionError("Unexpected audio file sync")
    with monkeypatch.context() as boundary:
        boundary.setattr(os, "fsync", no_audio_sync)
        assert (await store_chunk(client, sid, 0)).status_code == 201
    assert not list(app.state.runtime.config.data_dir.rglob("*.wav"))
    assert (await client.post(f"/sessions/{sid}/audio/store")).status_code == 404
    assert (await client.get(f"/sessions/{sid}/audio/0")).status_code == 404


async def test_buffer_auth_and_validation(client: httpx.AsyncClient, config: Any) -> None:
    sid = await create_session(client)
    assert (await client.post(f"/sessions/{sid}/audio/buffer",
                             headers={"Authorization": ""})).status_code == 401
    assert (await store_chunk(client, "missing", 0)).status_code == 404
    assert (await store_chunk(client, sid, 0, start_ms=1000, end_ms=1000)).status_code == 422
    assert (await store_chunk(client, sid, 0, body=b"not a wav")).status_code == 400
    assert (await store_chunk(client, sid, 0, body=b"0" * (config.max_chunk_bytes + 1))).status_code == 413
    assert (await store_chunk(client, sid, -1)).status_code == 422


async def test_receipt_database_failure_never_reports_acceptance(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from skaz import repository
    sid = await create_session(client)
    def fail(*args: Any) -> bool:
        raise OSError("sensitive local path")
    with monkeypatch.context() as boundary:
        boundary.setattr(repository, "insert_chunk", fail)
        result = await store_chunk(client, sid, 0)
    assert result.status_code == 500 and "sensitive" not in result.text
    assert (await store_chunk(client, sid, 0)).status_code == 201
