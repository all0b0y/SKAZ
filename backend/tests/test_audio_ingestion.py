from __future__ import annotations

from typing import Any

import httpx
import pytest

from tests.conftest import TOKEN, FakeHttp, chat_completion, make_wav

CATALOG = {
    "data": [
        {
            "id": "qwen/qwen3-asr-1.7b",
            "name": "Qwen3 ASR",
            "architecture": {"input_modalities": ["audio"], "output_modalities": ["transcription"]},
        },
        {
            "id": "google/gemini-2.5-flash-lite",
            "name": "Gemini 2.5 Flash Lite",
            "architecture": {"input_modalities": ["text", "image", "audio"], "output_modalities": ["text"]},
        },
    ]
}
WAV = "audio/wav"


@pytest.fixture(autouse=True)
def _catalog(outbound: FakeHttp) -> None:
    outbound.json_route("GET", "openrouter.ai/api/v1/models", CATALOG)


@pytest.fixture
async def session(client: httpx.AsyncClient, outbound: FakeHttp) -> str:
    """A recording session configured for the verified OpenRouter audio-input model."""
    response = await client.put(
        "/settings",
        json={"provider_keys": {"openrouter": "sk-test"}, "asr": {"provider": "openrouter", "model": "google/gemini-2.5-flash-lite"},
            "cloud_consent": True,
        },
    )
    assert response.status_code == 200, response.text
    created = await client.post("/sessions", json={"title": "Lecture"})
    return str(created.json()["id"])


async def post_chunk(
    client: httpx.AsyncClient,
    session: str,
    sequence: int,
    *,
    start_ms: int = 0,
    end_ms: int = 1000,
    body: bytes | None = None,
) -> httpx.Response:
    return await client.post(
        f"/sessions/{session}/audio",
        params={"sequence": sequence, "start_ms": start_ms, "end_ms": end_ms},
        content=body if body is not None else make_wav(1.0),
        headers={"Content-Type": WAV},
    )


def stub_transcript(outbound: FakeHttp, text: str = "Hello from the lecture.") -> None:
    outbound.json_route("POST", "chat/completions", chat_completion(text))


async def configure_dedicated(client: httpx.AsyncClient) -> str:
    response = await client.put(
        "/settings",
        json={"provider_keys": {"openrouter": "sk-test"}, "asr": {"provider": "openrouter", "model": "qwen/qwen3-asr-1.7b"},
            "cloud_consent": True,
        },
    )
    assert response.status_code == 200, response.text
    return str((await client.post("/sessions", json={"title": "Dedicated STT"})).json()["id"])


async def test_openrouter_dedicated_stt_uses_json_contract_and_omits_auto_language(
    client: httpx.AsyncClient, outbound: FakeHttp
) -> None:
    dedicated_session = await configure_dedicated(client)
    outbound.json_route(
        "POST",
        "audio/transcriptions",
        {
            "text": "First. Second.",
            "language": "en",
            "segments": [
                {"start": 0.0, "end": 0.4, "text": "First."},
                {"start": 0.4, "end": 1.0, "text": "Second."},
            ],
            "usage": {"seconds": 1},
        },
    )
    response = await post_chunk(client, dedicated_session, 0)
    assert response.status_code == 200, response.text
    assert [item["text"] for item in response.json()["segments"]] == ["First.", "Second."]
    request = outbound.requests[-1]
    assert str(request.url) == "https://openrouter.ai/api/v1/audio/transcriptions"
    payload = outbound.last_body
    assert payload["model"] == "qwen/qwen3-asr-1.7b"
    assert payload["response_format"] == "json"
    assert payload["input_audio"]["format"] == "wav"
    assert payload["input_audio"]["data"]
    assert "language" not in payload


@pytest.mark.parametrize(
    "payload",
    [
        {"text": "Реальный текст."},
        {"text": "Реальный текст.", "usage": {"seconds": 1, "type": "duration"}},
        {"text": "Реальный текст.", "segments": []},
        {"text": "Реальный текст.", "segments": "not a list"},
        {"text": "Реальный текст.", "segments": [{"text": "Реальный текст.", "start": None, "end": None}]},
        {"text": "Реальный текст.", "segments": [{"text": "Реальный текст.", "start": "0", "end": "0.9"}]},
        {"text": "Реальный текст.", "segments": ["junk", 5]},
        {"text": ["Реальный ", "текст."], "language": None},
    ],
)
async def test_optional_transcription_fields_parse_safely(
    client: httpx.AsyncClient, outbound: FakeHttp, payload: dict[str, Any]
) -> None:
    """Only `text` is contractual; odd or missing segments/usage must not lose the transcript."""
    dedicated_session = await configure_dedicated(client)
    outbound.json_route("POST", "audio/transcriptions", payload)
    response = await post_chunk(client, dedicated_session, 0)
    assert response.status_code == 200, response.text
    segments = response.json()["segments"]
    assert [segment["text"] for segment in segments] == ["Реальный текст."]
    assert all(0 <= segment["start_ms"] <= segment["end_ms"] for segment in segments)


async def test_empty_transcription_is_not_a_verified_model(
    client: httpx.AsyncClient, outbound: FakeHttp
) -> None:
    dedicated_session = await configure_dedicated(client)
    outbound.json_route("POST", "audio/transcriptions", {"text": "   "})
    response = await post_chunk(client, dedicated_session, 0)
    assert response.status_code == 200, response.text
    assert response.json()["segments"] == []
    assert (await client.get("/settings")).json()["asr"]["verified"] is False


async def test_legacy_audio_chat_success_never_marks_asr_verified(
    client: httpx.AsyncClient, session: str, outbound: FakeHttp
) -> None:
    stub_transcript(outbound, "Could you provide the audio file or transcript?")
    await post_chunk(client, session, 0)
    asr = (await client.get("/settings")).json()["asr"]
    assert asr["verified"] is False
    assert "legacy" in asr["verification_note"].lower()


async def test_chunk_is_transcribed_and_returned(
    client: httpx.AsyncClient, session: str, outbound: FakeHttp
) -> None:
    stub_transcript(outbound)
    response = await post_chunk(client, session, 0)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["duplicate"] is False
    assert len(body["segments"]) == 1
    segment = body["segments"][0]
    assert segment["text"] == "Hello from the lecture."
    assert (segment["start_ms"], segment["end_ms"]) == (0, 1000)
    assert isinstance(segment["id"], str) and segment["id"]


async def test_audio_is_sent_as_base64_wav_input_audio(
    client: httpx.AsyncClient, session: str, outbound: FakeHttp
) -> None:
    stub_transcript(outbound)
    await post_chunk(client, session, 0)
    payload: dict[str, Any] = outbound.last_body
    assert payload["model"] == "google/gemini-2.5-flash-lite"
    content = payload["messages"][-1]["content"]
    audio_parts = [part for part in content if part["type"] == "input_audio"]
    assert audio_parts and audio_parts[0]["input_audio"]["format"] == "wav"
    assert audio_parts[0]["input_audio"]["data"]
    assert outbound.requests[-1].headers["authorization"] == "Bearer sk-test"


async def test_segments_are_visible_in_session_detail(
    client: httpx.AsyncClient, session: str, outbound: FakeHttp
) -> None:
    stub_transcript(outbound, "First window.")
    await post_chunk(client, session, 0, start_ms=0, end_ms=1000)
    stub_transcript(outbound, "Second window.")
    await post_chunk(client, session, 1, start_ms=1000, end_ms=2000)
    detail = (await client.get(f"/sessions/{session}")).json()
    assert [segment["text"] for segment in detail["segments"]] == ["First window.", "Second window."]
    assert detail["session"]["duration_ms"] == 2000


async def test_repeated_sequence_with_same_audio_is_a_duplicate(
    client: httpx.AsyncClient, session: str, outbound: FakeHttp
) -> None:
    stub_transcript(outbound)
    body = make_wav(1.0)
    first = (await post_chunk(client, session, 0, body=body)).json()
    calls = len(outbound.requests)
    second = await post_chunk(client, session, 0, body=body)
    assert second.status_code == 200
    assert second.json()["duplicate"] is True
    assert second.json()["segments"] == first["segments"]
    assert len(outbound.requests) == calls, "duplicate chunk must not be transcribed twice"


async def test_reused_sequence_with_different_audio_is_rejected(
    client: httpx.AsyncClient, session: str, outbound: FakeHttp
) -> None:
    stub_transcript(outbound)
    await post_chunk(client, session, 0, body=make_wav(1.0, frequency=440))
    response = await post_chunk(client, session, 0, body=make_wav(1.0, frequency=880))
    assert response.status_code == 409
    assert isinstance(response.json()["detail"], str)


async def test_reused_sequence_with_changed_timestamps_is_rejected(
    client: httpx.AsyncClient, session: str, outbound: FakeHttp
) -> None:
    stub_transcript(outbound)
    body = make_wav(1.0)
    await post_chunk(client, session, 0, start_ms=0, end_ms=1000, body=body)
    response = await post_chunk(client, session, 0, start_ms=1000, end_ms=2000, body=body)
    assert response.status_code == 409
    assert "metadata" in response.json()["detail"].lower()


async def test_concurrent_identical_sequence_is_transcribed_once(
    client: httpx.AsyncClient, session: str, outbound: FakeHttp
) -> None:
    import asyncio

    release = asyncio.Event()

    async def slow(_request: httpx.Request) -> httpx.Response:
        await release.wait()
        return httpx.Response(200, json=chat_completion("Only once."))

    outbound.routes[("POST", "chat/completions")] = slow  # type: ignore[assignment]
    body = make_wav(1.0)
    first = asyncio.create_task(post_chunk(client, session, 7, body=body))
    await asyncio.sleep(0.02)
    second = asyncio.create_task(post_chunk(client, session, 7, body=body))
    await asyncio.sleep(0.02)
    release.set()
    responses = await asyncio.gather(first, second)
    assert all(response.status_code == 200 for response in responses)
    assert sorted(response.json()["duplicate"] for response in responses) == [False, True]
    posts = [r for r in outbound.requests if r.method == "POST" and "chat/completions" in str(r.url)]
    assert len(posts) == 1


async def test_concurrent_conflicting_sequence_keeps_the_stored_audio_consistent(
    client: httpx.AsyncClient, session: str, outbound: FakeHttp
) -> None:
    """Racing uploads of one sequence: one owner, one 409, and no mixed-up bytes on disk."""
    import asyncio
    import hashlib

    stub_transcript(outbound)
    quiet, loud = make_wav(1.0, frequency=440), make_wav(1.0, frequency=880)
    responses = await asyncio.gather(
        post_chunk(client, session, 3, body=quiet),
        post_chunk(client, session, 3, body=loud),
        return_exceptions=False,
    )
    assert sorted(response.status_code for response in responses) == [200, 409]
    winner = quiet if responses[0].status_code == 200 else loud
    stored = await client.get(f"/sessions/{session}/audio/3")
    assert stored.status_code == 200
    assert hashlib.sha256(stored.content).hexdigest() == hashlib.sha256(winner).hexdigest()


async def test_concurrent_conflicting_metadata_is_rejected_not_silently_merged(
    client: httpx.AsyncClient, session: str, outbound: FakeHttp
) -> None:
    import asyncio

    stub_transcript(outbound)
    body = make_wav(1.0)
    responses = await asyncio.gather(
        post_chunk(client, session, 4, start_ms=0, end_ms=1000, body=body),
        post_chunk(client, session, 4, start_ms=5000, end_ms=6000, body=body),
    )
    assert sorted(response.status_code for response in responses) == [200, 409]
    detail = (await client.get(f"/sessions/{session}")).json()
    windows = {(segment["start_ms"], segment["end_ms"]) for segment in detail["segments"]}
    assert len(windows) == 1, "only the winning timeline metadata may produce segments"


async def test_non_wav_body_is_rejected(client: httpx.AsyncClient, session: str) -> None:
    response = await post_chunk(client, session, 0, body=b"OggS not a wav at all")
    assert response.status_code == 400
    assert "wav" in response.json()["detail"].lower()


async def test_stereo_audio_is_rejected(client: httpx.AsyncClient, session: str) -> None:
    response = await post_chunk(client, session, 0, body=make_wav(1.0, channels=2))
    assert response.status_code == 400
    assert "mono" in response.json()["detail"].lower()


async def test_eight_bit_audio_is_rejected(client: httpx.AsyncClient, session: str) -> None:
    response = await post_chunk(client, session, 0, body=make_wav(0.5, sample_width=1))
    assert response.status_code == 400


async def test_chunk_longer_than_thirty_seconds_is_rejected(client: httpx.AsyncClient, session: str) -> None:
    response = await post_chunk(client, session, 0, end_ms=31_000, body=make_wav(31.0, sample_rate=8_000))
    assert response.status_code == 400
    assert "30" in response.json()["detail"]


async def test_device_sample_rate_is_accepted(
    client: httpx.AsyncClient, session: str, outbound: FakeHttp
) -> None:
    stub_transcript(outbound, "Recorded at 48 kHz.")
    response = await post_chunk(client, session, 0, body=make_wav(1.0, sample_rate=48_000))
    assert response.status_code == 200, response.text
    assert response.json()["segments"][0]["text"] == "Recorded at 48 kHz."


async def test_audio_for_unknown_session_is_404(client: httpx.AsyncClient) -> None:
    assert (await post_chunk(client, "missing", 0)).status_code == 404


async def test_negative_or_inverted_range_is_rejected(client: httpx.AsyncClient, session: str) -> None:
    assert (await post_chunk(client, session, 0, start_ms=2000, end_ms=1000)).status_code == 422
    assert (await post_chunk(client, session, -1)).status_code == 422


async def test_failed_transcription_keeps_the_chunk_and_flushes_on_stop(
    client: httpx.AsyncClient, session: str, outbound: FakeHttp
) -> None:
    outbound.json_route("POST", "chat/completions", {"error": {"message": "upstream down"}}, status=503)
    failed = await post_chunk(client, session, 0)
    assert failed.status_code == 502
    detail = failed.json()["detail"].lower()
    assert "503" in detail and "temporarily unavailable" in detail
    assert "upstream down" not in detail  # the provider body never reaches the user

    # The audio survived the provider failure and is still downloadable.
    stored = await client.get(f"/sessions/{session}/audio/0")
    assert stored.status_code == 200

    stub_transcript(outbound, "Recovered text.")
    stopped = await client.patch(f"/sessions/{session}", json={"status": "stopped"})
    assert stopped.status_code == 200
    detail = (await client.get(f"/sessions/{session}")).json()
    assert [segment["text"] for segment in detail["segments"]] == ["Recovered text."]


async def test_stored_audio_is_returned_byte_identical(
    client: httpx.AsyncClient, session: str, outbound: FakeHttp
) -> None:
    stub_transcript(outbound)
    body = make_wav(1.0, sample_rate=44_100)
    await post_chunk(client, session, 3, body=body)
    response = await client.get(f"/sessions/{session}/audio/3")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("audio/wav")
    assert response.content == body


async def test_stored_audio_requires_auth_and_exists(
    client: httpx.AsyncClient, session: str, outbound: FakeHttp
) -> None:
    stub_transcript(outbound)
    await post_chunk(client, session, 0)
    assert (
        await client.get(f"/sessions/{session}/audio/0", headers={"Authorization": ""})
    ).status_code == 401
    assert (await client.get(f"/sessions/{session}/audio/9")).status_code == 404
    assert (
        await client.get(f"/sessions/{session}/audio/0", headers={"Authorization": f"Bearer {TOKEN}"})
    ).status_code == 200


async def test_delete_session_removes_stored_audio(
    client: httpx.AsyncClient, session: str, outbound: FakeHttp, config: Any
) -> None:
    stub_transcript(outbound)
    await post_chunk(client, session, 0)
    assert list(config.audio_dir.rglob("*.wav"))
    await client.delete(f"/sessions/{session}")
    assert not list(config.audio_dir.rglob("*.wav"))
    assert (await client.get(f"/sessions/{session}/audio/0")).status_code == 404


async def test_cloud_upload_requires_consent(client: httpx.AsyncClient, outbound: FakeHttp) -> None:
    stub_transcript(outbound)
    await client.put(
        "/settings",
        json={"provider_keys": {"openrouter": "sk-test"}, "asr": {"provider": "openrouter", "model": "google/gemini-2.5-flash-lite"},
            "cloud_consent": False,
        },
    )
    created = await client.post("/sessions", json={"title": "No consent"})
    response = await post_chunk(client, str(created.json()["id"]), 0)
    assert response.status_code == 400
    assert "consent" in response.json()["detail"].lower()


async def test_missing_api_key_is_reported(client: httpx.AsyncClient, outbound: FakeHttp) -> None:
    await client.put(
        "/settings",
        json={
            "asr": {"provider": "openrouter", "model": "google/gemini-2.5-flash-lite"},
            "cloud_consent": True,
        },
    )
    created = await client.post("/sessions", json={"title": "No key"})
    response = await post_chunk(client, str(created.json()["id"]), 0)
    assert response.status_code == 400
    assert "key" in response.json()["detail"].lower()


async def test_successful_dedicated_transcription_marks_the_model_verified(
    client: httpx.AsyncClient, outbound: FakeHttp
) -> None:
    session = await configure_dedicated(client)
    assert (await client.get("/settings")).json()["asr"]["verified"] is False
    outbound.json_route("POST", "audio/transcriptions", {"text": "Hello from the lecture."})
    await post_chunk(client, session, 0)
    asr = (await client.get("/settings")).json()["asr"]
    assert asr["verified"] is True
    assert "verified" in asr["verification_note"].lower()


async def test_bounded_queue_rejects_overload(
    client: httpx.AsyncClient, session: str, outbound: FakeHttp, app: Any
) -> None:
    import asyncio

    release = asyncio.Event()

    async def slow(_request: httpx.Request) -> httpx.Response:
        await release.wait()
        return httpx.Response(200, json=chat_completion("late"))

    outbound.routes[("POST", "chat/completions")] = slow  # type: ignore[assignment]
    bound = app.state.runtime.config.max_pending_chunks
    tasks = [asyncio.create_task(post_chunk(client, session, index)) for index in range(bound + 3)]
    await asyncio.sleep(0.05)
    overflow = await post_chunk(client, session, 99)
    release.set()
    responses = await asyncio.gather(*tasks)
    assert overflow.status_code == 429
    assert "pending" in overflow.json()["detail"].lower()
    assert any(response.status_code == 200 for response in responses)
