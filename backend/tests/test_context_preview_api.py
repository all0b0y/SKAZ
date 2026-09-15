from __future__ import annotations

import asyncio
import hashlib
import io
import struct
import threading
import wave
from collections.abc import Iterator
from types import SimpleNamespace
from typing import Any

import httpx
import numpy as np
import pytest

from audiohelper.audio import WavAudio
from audiohelper.gateways.asr import LocalWhisperTranscriber
from tests.conftest import TOKEN, FakeHttp, make_wav


def pcm_wav(samples: list[int], *, sample_rate: int = 16_000) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(b"".join(struct.pack("<h", sample) for sample in samples))
    return buffer.getvalue()


async def create_session(client: httpx.AsyncClient, title: str = "Preview") -> str:
    response = await client.post("/sessions", json={"title": title})
    assert response.status_code == 200, response.text
    return str(response.json()["id"])


async def use_local_profile(
    client: httpx.AsyncClient, *, model: str = "small", language: str = "auto"
) -> None:
    response = await client.put(
        "/settings",
        json={
            "asr": {"provider": "local-whisper", "model": model},
            "transcript_language": language,
        },
    )
    assert response.status_code == 200, response.text


async def store(
    client: httpx.AsyncClient,
    session_id: str,
    sequence: int,
    body: bytes,
    *,
    start_ms: int,
    end_ms: int,
) -> None:
    response = await client.post(
        f"/sessions/{session_id}/audio/store",
        params={"sequence": sequence, "start_ms": start_ms, "end_ms": end_ms},
        content=body,
        headers={"Content-Type": "audio/wav"},
    )
    assert response.status_code == 201, response.text


class RecordingEngine:
    def __init__(self, *, text: str = "joined preview", language: str = "en") -> None:
        self.text = text
        self.language = language
        self.inputs: list[np.ndarray[Any, Any]] = []
        self.languages: list[str | None] = []

    def transcribe(
        self, samples: np.ndarray[Any, Any], *, language: str | None, vad_filter: bool
    ) -> tuple[list[Any], Any]:
        assert vad_filter is False
        self.inputs.append(samples.copy())
        self.languages.append(language)
        segment = SimpleNamespace(start=0.0, end=len(samples) / 16_000, text=self.text)
        return [segment], SimpleNamespace(language=self.language)


@pytest.fixture(autouse=True)
def clear_local_model_cache() -> Iterator[None]:
    LocalWhisperTranscriber._models.clear()
    yield
    LocalWhisperTranscriber._models.clear()


async def test_two_stored_chunks_are_one_decode_with_exact_multi_source_provenance(
    client: httpx.AsyncClient, app: Any, monkeypatch: pytest.MonkeyPatch, outbound: FakeHttp
) -> None:
    await use_local_profile(client, model="small", language="ru")
    session_id = await create_session(client)
    first_samples = ([1000, 2000, -1000, -2000] * 1378)[:5512]
    second_samples = ([3000, -3000] * 1378)[:2756]
    first = pcm_wav(first_samples, sample_rate=11025)
    second = pcm_wav(second_samples, sample_rate=11025)
    await store(client, session_id, 4, first, start_ms=0, end_ms=500)
    await store(client, session_id, 9, second, start_ms=500, end_ms=750)
    before = {4: first, 9: second}
    engine = RecordingEngine(text="единое окно", language="ru")
    monkeypatch.setattr("audiohelper.gateways.asr.load_local_whisper", lambda *_a, **_k: engine)

    response = await client.post(
        f"/sessions/{session_id}/asr/preview",
        json={"first_sequence": 4, "last_sequence": 9},
    )

    assert response.status_code == 200, response.text
    assert len(engine.inputs) == 1
    original_frames = b"".join(
        struct.pack("<h", sample) for sample in first_samples + second_samples
    )
    expected = np.asarray(
        WavAudio(11025, original_frames).resampled(16000).to_float32(), dtype="float32"
    )
    np.testing.assert_array_equal(engine.inputs[0], expected)
    assert engine.languages == ["ru"]
    assert response.json() == {
        "state": "draft",
        "text": "единое окно",
        "language": "ru",
        "provider": "local-whisper",
        "model": "small",
        "requested_language": "ru",
        "speech_gate_enabled": False,
        "window": {
            "start_ms": 0,
            "end_ms": 750,
            "sample_rate": 11025,
            "sample_count": 8268,
            "model_input_sample_rate": 16000,
            "model_input_sample_count": 11999,
            "model_input_kind": "assembled_pcm16_mono_resampled_for_local_whisper",
        },
        "sources": [
            {
                "sequence": 4,
                "start_ms": 0,
                "end_ms": 500,
                "sample_rate": 11025,
                "sample_count": 5512,
                "window_sample_start": 0,
                "window_sample_end": 5512,
                "sha256": hashlib.sha256(first).hexdigest(),
                "source_kind": "original_captured_wav",
            },
            {
                "sequence": 9,
                "start_ms": 500,
                "end_ms": 750,
                "sample_rate": 11025,
                "sample_count": 2756,
                "window_sample_start": 5512,
                "window_sample_end": 8268,
                "sha256": hashlib.sha256(second).hexdigest(),
                "source_kind": "original_captured_wav",
            },
        ],
    }
    assert outbound.requests == []
    for sequence, original in before.items():
        assert (await client.get(f"/sessions/{session_id}/audio/{sequence}")).content == original
    assert app.state.runtime.settings_store.load().asr.model == "small"


async def test_preview_is_not_persisted_in_final_fts_or_agent_context(
    client: httpx.AsyncClient, app: Any, monkeypatch: pytest.MonkeyPatch, outbound: FakeHttp
) -> None:
    await use_local_profile(client)
    session_id = await create_session(client)
    body = make_wav(1.0)
    await store(client, session_id, 0, body, start_ms=0, end_ms=1000)
    monkeypatch.setattr(
        "audiohelper.gateways.asr.load_local_whisper",
        lambda *_a, **_k: RecordingEngine(text="draft-only-token"),
    )

    preview = await client.post(
        f"/sessions/{session_id}/asr/preview", json={"first_sequence": 0, "last_sequence": 0}
    )

    assert preview.status_code == 200, preview.text
    assert (await client.get(f"/sessions/{session_id}")).json()["segments"] == []
    with app.state.runtime.db.read() as connection:
        assert connection.execute("SELECT count(*) FROM segments").fetchone()[0] == 0
        assert connection.execute("SELECT count(*) FROM segments_fts").fetchone()[0] == 0
        assert connection.execute("SELECT count(*) FROM notes").fetchone()[0] == 0
        assert connection.execute("SELECT count(*) FROM verifications").fetchone()[0] == 0
    answer = await client.post(
        f"/sessions/{session_id}/ask", json={"question": "draft-only-token", "scope": "all"}
    )
    assert answer.status_code == 200, answer.text
    assert "draft-only-token" not in answer.json()["answer"]
    assert outbound.requests == []


@pytest.mark.parametrize(
    ("payload", "status"),
    [
        ({"first_sequence": -1, "last_sequence": 0}, 422),
        ({"first_sequence": 1, "last_sequence": 0}, 422),
        ({"first_sequence": True, "last_sequence": 1}, 422),
        ({"first_sequence": "0", "last_sequence": 1}, 422),
        ({"first_sequence": 0, "last_sequence": 1, "path": "/tmp/audio.wav"}, 422),
    ],
)
async def test_invalid_request_never_constructs_decoder(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    payload: dict[str, Any],
    status: int,
) -> None:
    session_id = await create_session(client)
    called = False

    def forbidden(*_args: Any, **_kwargs: Any) -> Any:
        nonlocal called
        called = True
        raise AssertionError("decoder must not be constructed")

    monkeypatch.setattr("audiohelper.gateways.asr.load_local_whisper", forbidden)
    response = await client.post(f"/sessions/{session_id}/asr/preview", json=payload)
    assert response.status_code == status, response.text
    assert called is False


async def test_endpoint_sequences_must_exist_but_interior_ids_may_be_absent(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    await use_local_profile(client)
    session_id = await create_session(client)
    body = make_wav(0.5)
    await store(client, session_id, 2, body, start_ms=0, end_ms=500)
    engine = RecordingEngine()
    monkeypatch.setattr("audiohelper.gateways.asr.load_local_whisper", lambda *_a, **_k: engine)

    missing = await client.post(
        f"/sessions/{session_id}/asr/preview", json={"first_sequence": 2, "last_sequence": 8}
    )
    assert missing.status_code == 404
    assert engine.inputs == []

    await store(client, session_id, 8, body, start_ms=500, end_ms=1000)
    valid = await client.post(
        f"/sessions/{session_id}/asr/preview", json={"first_sequence": 2, "last_sequence": 8}
    )
    assert valid.status_code == 200, valid.text
    assert [source["sequence"] for source in valid.json()["sources"]] == [2, 8]


@pytest.mark.parametrize("defect", ["gap", "overlap", "mixed-rate", "duration"])
async def test_timeline_and_pcm_mismatch_rejected_before_decode(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch, defect: str
) -> None:
    await use_local_profile(client)
    session_id = await create_session(client)
    rate = 8000 if defect == "mixed-rate" else 16000
    second_start = 1001 if defect == "gap" else 999 if defect == "overlap" else 1000
    first_end = 999 if defect == "duration" else 1000
    await store(client, session_id, 0, make_wav(1.0), start_ms=0, end_ms=first_end)
    await store(
        client,
        session_id,
        1,
        make_wav(1.0, sample_rate=rate),
        start_ms=second_start,
        end_ms=second_start + 1000,
    )
    engine = RecordingEngine()
    monkeypatch.setattr("audiohelper.gateways.asr.load_local_whisper", lambda *_a, **_k: engine)

    response = await client.post(
        f"/sessions/{session_id}/asr/preview", json={"first_sequence": 0, "last_sequence": 1}
    )
    assert response.status_code == 409, response.text
    assert engine.inputs == []


async def test_missing_corrupt_and_digest_mismatch_rejected_before_decode(
    client: httpx.AsyncClient, config: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    await use_local_profile(client)
    engine = RecordingEngine()
    monkeypatch.setattr("audiohelper.gateways.asr.load_local_whisper", lambda *_a, **_k: engine)

    for sequence, replacement, expected in (
        (0, None, 404),
        (1, b"not wav", 409),
        (2, make_wav(1.0, frequency=880), 409),
    ):
        session_id = await create_session(client, f"source-{sequence}")
        body = make_wav(1.0)
        await store(client, session_id, sequence, body, start_ms=0, end_ms=1000)
        path = config.audio_dir / session_id / f"{sequence:06d}.wav"
        if replacement is None:
            path.unlink()
        else:
            path.write_bytes(replacement)
        response = await client.post(
            f"/sessions/{session_id}/asr/preview",
            json={"first_sequence": sequence, "last_sequence": sequence},
        )
        assert response.status_code == expected, response.text
    assert engine.inputs == []


async def test_combined_duration_and_bytes_are_rejected_without_truncation_or_decode(
    client: httpx.AsyncClient, app: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    await use_local_profile(client)
    session_id = await create_session(client)
    first = make_wav(16.0, sample_rate=1000)
    second = make_wav(15.0, sample_rate=1000)
    await store(client, session_id, 0, first, start_ms=0, end_ms=16000)
    await store(client, session_id, 1, second, start_ms=16000, end_ms=31000)
    engine = RecordingEngine()
    monkeypatch.setattr("audiohelper.gateways.asr.load_local_whisper", lambda *_a, **_k: engine)

    duration = await client.post(
        f"/sessions/{session_id}/asr/preview", json={"first_sequence": 0, "last_sequence": 1}
    )
    assert duration.status_code == 413, duration.text

    object.__setattr__(app.state.runtime.config, "max_chunk_seconds", 60.0)
    object.__setattr__(app.state.runtime.config, "max_chunk_bytes", len(first) + len(second) - 1)
    size = await client.post(
        f"/sessions/{session_id}/asr/preview", json={"first_sequence": 0, "last_sequence": 1}
    )
    assert size.status_code == 413, size.text
    assert engine.inputs == []


async def test_chunk_metadata_count_is_bounded_before_decode(
    client: httpx.AsyncClient, app: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    await use_local_profile(client)
    session_id = await create_session(client)
    for sequence in range(2):
        await store(
            client,
            session_id,
            sequence,
            make_wav(0.5),
            start_ms=sequence * 500,
            end_ms=(sequence + 1) * 500,
        )
    object.__setattr__(app.state.runtime.config, "max_preview_chunks", 1)
    engine = RecordingEngine()
    monkeypatch.setattr("audiohelper.gateways.asr.load_local_whisper", lambda *_a, **_k: engine)

    response = await client.post(
        f"/sessions/{session_id}/asr/preview", json={"first_sequence": 0, "last_sequence": 1}
    )
    assert response.status_code == 413, response.text
    assert engine.inputs == []


async def test_cloud_profile_is_rejected_before_catalog_key_or_outbound_access(
    client: httpx.AsyncClient, app: Any, outbound: FakeHttp, monkeypatch: pytest.MonkeyPatch
) -> None:
    response = await client.put(
        "/settings",
        json={
            "asr": {"provider": "openrouter", "model": "qwen/qwen3-asr-1.7b"},
            "cloud_consent": True,
        },
    )
    assert response.status_code == 200
    session_id = await create_session(client)
    await store(client, session_id, 0, make_wav(1.0), start_ms=0, end_ms=1000)
    outbound.requests.clear()
    outbound.bodies.clear()
    monkeypatch.setattr(app.state.runtime, "api_key", lambda *_a: pytest.fail("key read"))
    monkeypatch.setattr(
        app.state.runtime.catalogs,
        "openrouter_asr_kind",
        lambda *_a: pytest.fail("catalog read"),
    )

    preview = await client.post(
        f"/sessions/{session_id}/asr/preview", json={"first_sequence": 0, "last_sequence": 0}
    )
    assert preview.status_code == 400, preview.text
    assert outbound.requests == []


async def test_other_session_chunks_are_never_included(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    await use_local_profile(client)
    selected = await create_session(client, "selected")
    other = await create_session(client, "other")
    await store(client, selected, 0, make_wav(1.0, frequency=220), start_ms=0, end_ms=1000)
    await store(client, other, 1, make_wav(1.0, frequency=880), start_ms=1000, end_ms=2000)
    engine = RecordingEngine()
    monkeypatch.setattr("audiohelper.gateways.asr.load_local_whisper", lambda *_a, **_k: engine)

    response = await client.post(
        f"/sessions/{selected}/asr/preview", json={"first_sequence": 0, "last_sequence": 1}
    )
    assert response.status_code == 404
    assert engine.inputs == []


async def test_busy_and_cancellation_release_the_single_preview_slot(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    await use_local_profile(client)
    session_id = await create_session(client)
    await store(client, session_id, 0, make_wav(1.0), start_ms=0, end_ms=1000)
    entered = threading.Event()
    release = threading.Event()

    class BlockingEngine(RecordingEngine):
        def transcribe(self, *args: Any, **kwargs: Any) -> tuple[list[Any], Any]:
            entered.set()
            release.wait(timeout=5)
            return super().transcribe(*args, **kwargs)

    engine = BlockingEngine()
    monkeypatch.setattr("audiohelper.gateways.asr.load_local_whisper", lambda *_a, **_k: engine)
    payload = {"first_sequence": 0, "last_sequence": 0}
    first = asyncio.create_task(client.post(f"/sessions/{session_id}/asr/preview", json=payload))
    await asyncio.wait_for(asyncio.to_thread(entered.wait), timeout=1)

    busy = await client.post(f"/sessions/{session_id}/asr/preview", json=payload)
    assert busy.status_code == 429, busy.text
    first.cancel()
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await first

    recovered = await client.post(f"/sessions/{session_id}/asr/preview", json=payload)
    assert recovered.status_code == 200, recovered.text


async def test_session_deleted_during_inference_cannot_return_stale_success(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    await use_local_profile(client)
    session_id = await create_session(client)
    await store(client, session_id, 0, make_wav(1.0), start_ms=0, end_ms=1000)
    entered = threading.Event()
    release = threading.Event()

    class BlockingEngine(RecordingEngine):
        def transcribe(self, *args: Any, **kwargs: Any) -> tuple[list[Any], Any]:
            entered.set()
            release.wait(timeout=5)
            return super().transcribe(*args, **kwargs)

    monkeypatch.setattr(
        "audiohelper.gateways.asr.load_local_whisper", lambda *_a, **_k: BlockingEngine()
    )
    task = asyncio.create_task(
        client.post(
            f"/sessions/{session_id}/asr/preview",
            json={"first_sequence": 0, "last_sequence": 0},
        )
    )
    await asyncio.wait_for(asyncio.to_thread(entered.wait), timeout=1)
    deleted = await client.delete(f"/sessions/{session_id}")
    assert deleted.status_code == 200
    release.set()

    result = await task
    assert result.status_code == 409, result.text


async def test_local_decoder_errors_are_sanitised_and_slot_is_reusable(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    await use_local_profile(client)
    session_id = await create_session(client)
    await store(client, session_id, 0, make_wav(1.0), start_ms=0, end_ms=1000)

    def broken(*_args: Any, **_kwargs: Any) -> Any:
        raise RuntimeError("private cache path /Users/private/secret")

    monkeypatch.setattr("audiohelper.gateways.asr.load_local_whisper", broken)
    payload = {"first_sequence": 0, "last_sequence": 0}
    failed = await client.post(f"/sessions/{session_id}/asr/preview", json=payload)
    assert failed.status_code in (400, 502)
    assert "private cache path" not in failed.text

    engine = RecordingEngine()
    monkeypatch.setattr("audiohelper.gateways.asr.load_local_whisper", lambda *_a, **_k: engine)
    recovered = await client.post(f"/sessions/{session_id}/asr/preview", json=payload)
    assert recovered.status_code == 200, recovered.text


async def test_preview_requires_auth(app: Any) -> None:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8765"
    ) as anonymous:
        response = await anonymous.post(
            "/sessions/unknown/asr/preview", json={"first_sequence": 0, "last_sequence": 0}
        )
    assert response.status_code == 401
    assert TOKEN not in response.text
