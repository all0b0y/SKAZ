from __future__ import annotations

import asyncio
import threading
from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx
import pytest

from audiohelper import repository as repo
from audiohelper.app import create_app
from audiohelper.config import AppConfig
from audiohelper.gateways.asr import LocalWhisperTranscriber
from audiohelper.schemas import LiveAsrDraftResponse
from audiohelper.secrets import MemorySecretStore
from audiohelper.window_asr import PreviewSourceMissing
from tests.conftest import TOKEN, FakeHttp, make_wav

Word = tuple[str, float, float]


class WindowEngine:
    def __init__(
        self,
        hypotheses: list[list[Word]],
        *,
        entered: threading.Event | None = None,
        release: threading.Event | None = None,
    ) -> None:
        self.hypotheses = hypotheses
        self.entered = entered
        self.release = release
        self.calls = 0
        self.durations: list[float] = []

    def transcribe(
        self,
        samples: Any,
        *,
        language: str | None,
        vad_filter: bool,
        word_timestamps: bool = False,
    ) -> tuple[list[Any], Any]:
        assert vad_filter is False
        assert word_timestamps is True
        self.durations.append(len(samples) / 16_000)
        if self.entered is not None:
            self.entered.set()
        if self.release is not None:
            assert self.release.wait(timeout=5)
        selected = self.hypotheses[min(self.calls, len(self.hypotheses) - 1)]
        self.calls += 1
        words = [SimpleNamespace(word=text, start=start, end=end) for text, start, end in selected]
        segment = SimpleNamespace(
            text="".join(word.word for word in words),
            words=words,
            start=words[0].start if words else 0.0,
            end=words[-1].end if words else 0.0,
        )
        return ([segment] if words else []), SimpleNamespace(language=language or "ru")


@pytest.fixture(autouse=True)
def clear_local_model_cache() -> Iterator[None]:
    LocalWhisperTranscriber._models.clear()
    yield
    LocalWhisperTranscriber._models.clear()


@pytest.fixture
def scheduler_config(tmp_path: Path) -> AppConfig:
    config = AppConfig(token=TOKEN, data_dir=tmp_path / "data", request_timeout_s=5.0)
    object.__setattr__(config, "live_finality_enabled", True)
    object.__setattr__(config, "local_speech_gate", True)
    object.__setattr__(config, "live_finality_guard_ms", 200)
    return config


@pytest.fixture
def scheduler_app(scheduler_config: AppConfig, outbound: FakeHttp) -> Iterator[Any]:
    application = create_app(
        scheduler_config,
        secret_store=MemorySecretStore(),
        http_client=outbound.client(),
    )
    yield application
    application.state.runtime.close()


@pytest.fixture
async def scheduler_client(scheduler_app: Any) -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=scheduler_app),
        base_url="http://127.0.0.1:8765",
        headers={"Authorization": f"Bearer {TOKEN}"},
    ) as client:
        yield client


async def _session(client: httpx.AsyncClient, title: str = "scheduler") -> str:
    response = await client.post("/sessions", json={"title": title})
    assert response.status_code == 200
    return str(response.json()["id"])


async def _local(client: httpx.AsyncClient, *, model: str = "small") -> None:
    response = await client.put(
        "/settings",
        json={
            "asr": {"provider": "local-whisper", "model": model},
            "transcript_language": "ru",
        },
    )
    assert response.status_code == 200


async def _store(
    client: httpx.AsyncClient,
    session_id: str,
    sequence: int,
    *,
    start_ms: int | None = None,
    end_ms: int | None = None,
) -> None:
    start = sequence * 5_000 if start_ms is None else start_ms
    end = start + 5_000 if end_ms is None else end_ms
    response = await client.post(
        f"/sessions/{session_id}/audio/store",
        params={"sequence": sequence, "start_ms": start, "end_ms": end},
        content=make_wav((end - start) / 1000, frequency=220 + sequence),
        headers={"Content-Type": "audio/wav"},
    )
    assert response.status_code in (200, 201), response.text


async def _status(client: httpx.AsyncClient, session_id: str) -> dict[str, Any]:
    response = await client.get(f"/sessions/{session_id}/asr/live/scheduler")
    assert response.status_code == 200, response.text
    return dict(response.json())


async def _wait_terminal(client: httpx.AsyncClient, session_id: str) -> dict[str, Any]:
    for _ in range(100):
        status = await _status(client, session_id)
        if status["status"] in {"complete", "stalled", "stopped"}:
            return status
        await asyncio.sleep(0)
    raise AssertionError("scheduler did not reach a terminal state")


async def test_scheduler_routes_require_capability_and_strict_authenticated_body(
    client: httpx.AsyncClient, app: Any
) -> None:
    session_id = await _session(client)
    await _store(client, session_id, 0)

    disabled = await client.post(
        f"/sessions/{session_id}/asr/live/advance", json={"through_sequence": 0}
    )
    malformed = await client.post(
        f"/sessions/{session_id}/asr/live/advance",
        json={"through_sequence": True, "unexpected": 1},
    )
    unauthenticated = await client.get(
        f"/sessions/{session_id}/asr/live/scheduler", headers={"Authorization": ""}
    )

    assert disabled.status_code == 400
    assert malformed.status_code == 422
    assert unauthenticated.status_code == 401
    assert (await _status(client, session_id))["capable"] is False
    assert not hasattr(app.state.runtime, "live_scheduler") or (
        await _status(client, session_id)
    )["status"] == "idle"


async def test_durable_status_marks_bounded_continuity_uncertainty_and_visible_gaps(
    scheduler_client: httpx.AsyncClient,
    scheduler_app: Any,
    scheduler_config: AppConfig,
) -> None:
    await _local(scheduler_client)
    maximum = scheduler_config.max_preview_chunks

    contiguous = await _session(scheduler_client, "bounded-contiguous")
    for sequence in range(maximum + 1):
        assert repo.insert_chunk(
            scheduler_app.state.runtime.db,
            repo.ChunkRecord(
                session_id=contiguous,
                sequence=sequence,
                start_ms=sequence * 10,
                end_ms=(sequence + 1) * 10,
                sha256=f"{sequence:064x}",
                path=f"bounded/{sequence}.wav",
                status=repo.CHUNK_PENDING,
                error=None,
            ),
        )

    contiguous_status = await _status(scheduler_client, contiguous)
    assert contiguous_status["source_continuity_verified"] is False

    with_gap = await _session(scheduler_client, "bounded-visible-gap")
    sequences = [*range(10), *range(11, maximum + 2)]
    for sequence in sequences:
        assert repo.insert_chunk(
            scheduler_app.state.runtime.db,
            repo.ChunkRecord(
                session_id=with_gap,
                sequence=sequence,
                start_ms=sequence * 10,
                end_ms=(sequence + 1) * 10,
                sha256=f"{sequence:064x}",
                path=f"bounded-gap/{sequence}.wav",
                status=repo.CHUNK_PENDING,
                error=None,
            ),
        )

    gap_status = await _status(scheduler_client, with_gap)
    assert gap_status["source_continuity_verified"] is False
    assert gap_status["status"] == "stalled"
    assert gap_status["block_reason"] == "source_missing"


async def test_scheduler_coalesces_latest_target_and_never_overlaps_updates(
    scheduler_client: httpx.AsyncClient, scheduler_app: Any
) -> None:
    await _local(scheduler_client)
    session_id = await _session(scheduler_client)
    for sequence in range(4):
        await _store(scheduler_client, session_id, sequence)

    entered = asyncio.Event()
    release = asyncio.Event()
    calls: list[tuple[int, int, int]] = []
    active = 0
    maximum_active = 0

    async def controlled_update(
        selected_session: str, first: int, last: int, expected_revision: int
    ) -> LiveAsrDraftResponse:
        nonlocal active, maximum_active
        assert selected_session == session_id
        active += 1
        maximum_active = max(maximum_active, active)
        calls.append((first, last, expected_revision))
        entered.set()
        if len(calls) == 1:
            await release.wait()
        active -= 1
        return LiveAsrDraftResponse(draft=None)

    scheduler_app.state.runtime.live_asr.update = controlled_update

    first = await scheduler_client.post(
        f"/sessions/{session_id}/asr/live/advance", json={"through_sequence": 1}
    )
    assert first.status_code == 202, first.text
    await entered.wait()
    burst = await asyncio.gather(
        scheduler_client.post(
            f"/sessions/{session_id}/asr/live/advance", json={"through_sequence": 2}
        ),
        scheduler_client.post(
            f"/sessions/{session_id}/asr/live/advance", json={"through_sequence": 3}
        ),
        scheduler_client.post(
            f"/sessions/{session_id}/asr/live/advance", json={"through_sequence": 2}
        ),
    )
    assert all(response.status_code == 202 for response in burst)
    busy_status = await _status(scheduler_client, session_id)
    assert busy_status["captured_target_sequence"] == 3
    assert busy_status["accepted_count"] == 4
    release.set()
    terminal = await _wait_terminal(scheduler_client, session_id)

    assert maximum_active == 1
    assert calls == [(0, 1, 0), (0, 3, 0)]
    assert terminal["status"] == "complete"
    assert terminal["processed_window"] == {
        "first_sequence": 0,
        "last_sequence": 3,
        "start_ms": 0,
        "end_ms": 20_000,
    }
    assert terminal["captured_target_sequence"] == 3
    assert terminal["lag_ms"] == 20_000


async def test_scheduler_rejects_other_session_and_reports_source_failures_without_decode(
    scheduler_client: httpx.AsyncClient, scheduler_app: Any
) -> None:
    await _local(scheduler_client)
    first_session = await _session(scheduler_client, "first")
    second_session = await _session(scheduler_client, "second")
    await _store(scheduler_client, first_session, 0)
    await _store(scheduler_client, second_session, 0)
    entered = asyncio.Event()
    release = asyncio.Event()
    calls = 0

    async def blocked_update(*_args: object) -> LiveAsrDraftResponse:
        nonlocal calls
        calls += 1
        entered.set()
        await release.wait()
        return LiveAsrDraftResponse(draft=None)

    scheduler_app.state.runtime.live_asr.update = blocked_update
    accepted = await scheduler_client.post(
        f"/sessions/{first_session}/asr/live/advance", json={"through_sequence": 0}
    )
    assert accepted.status_code == 202
    await entered.wait()
    other = await scheduler_client.post(
        f"/sessions/{second_session}/asr/live/advance", json={"through_sequence": 0}
    )
    missing = await scheduler_client.post(
        f"/sessions/{first_session}/asr/live/advance", json={"through_sequence": 1}
    )

    assert other.status_code == 429
    assert missing.status_code == 404
    assert calls == 1
    release.set()
    await _wait_terminal(scheduler_client, first_session)


async def test_scheduler_stalls_on_gap_and_restart_is_transient(
    scheduler_client: httpx.AsyncClient, scheduler_app: Any, scheduler_config: AppConfig, outbound: FakeHttp
) -> None:
    await _local(scheduler_client)
    session_id = await _session(scheduler_client)
    await _store(scheduler_client, session_id, 0)
    await _store(scheduler_client, session_id, 2)
    calls = 0

    async def should_not_decode(*_args: object) -> LiveAsrDraftResponse:
        nonlocal calls
        calls += 1
        return LiveAsrDraftResponse(draft=None)

    scheduler_app.state.runtime.live_asr.update = should_not_decode
    response = await scheduler_client.post(
        f"/sessions/{session_id}/asr/live/advance", json={"through_sequence": 2}
    )
    assert response.status_code == 202
    terminal = await _wait_terminal(scheduler_client, session_id)
    assert terminal["status"] == "stalled"
    assert terminal["block_reason"] == "source_missing"
    assert calls == 0

    scheduler_app.state.runtime.close()
    restarted = create_app(
        scheduler_config,
        secret_store=MemorySecretStore(),
        http_client=outbound.client(),
    )
    try:
        decode_calls = 0

        async def must_not_decode_on_get(*_args: object) -> LiveAsrDraftResponse:
            nonlocal decode_calls
            decode_calls += 1
            raise AssertionError("scheduler status GET must remain read-only")

        restarted.state.runtime.live_asr.update = must_not_decode_on_get
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=restarted),
            base_url="http://127.0.0.1:8765",
            headers={"Authorization": f"Bearer {TOKEN}"},
        ) as client:
            with restarted.state.runtime.db.read() as connection:
                before = {
                    "sessions": connection.execute("SELECT count(*) FROM sessions").fetchone()[0],
                    "chunks": connection.execute("SELECT count(*) FROM chunks").fetchone()[0],
                    "drafts": connection.execute(
                        "SELECT count(*) FROM live_asr_drafts"
                    ).fetchone()[0],
                    "finality": connection.execute(
                        "SELECT count(*) FROM live_asr_finality"
                    ).fetchone()[0],
                }
            status = await _status(client, session_id)
            with restarted.state.runtime.db.read() as connection:
                after = {
                    "sessions": connection.execute("SELECT count(*) FROM sessions").fetchone()[0],
                    "chunks": connection.execute("SELECT count(*) FROM chunks").fetchone()[0],
                    "drafts": connection.execute(
                        "SELECT count(*) FROM live_asr_drafts"
                    ).fetchone()[0],
                    "finality": connection.execute(
                        "SELECT count(*) FROM live_asr_finality"
                    ).fetchone()[0],
                }
            assert status["status"] == "stalled"
            assert status["captured_target_sequence"] == 2
            assert status["stable_frontier_ms"] == 0
            assert status["lag_ms"] == 15_000
            assert status["block_reason"] == "source_missing"
            assert status["source_ended"] is False
            assert status["recovery_required"] is True
            assert decode_calls == 0
            assert after == before
    finally:
        restarted.state.runtime.close()


async def test_source_disappearing_after_admission_becomes_bounded_stall(
    scheduler_client: httpx.AsyncClient, scheduler_app: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    await _local(scheduler_client)
    session_id = await _session(scheduler_client)
    await _store(scheduler_client, session_id, 0)
    original = scheduler_app.state.runtime.window_asr.inspect
    calls = 0

    def disappearing(*args: object, **kwargs: object) -> Any:
        nonlocal calls
        calls += 1
        if calls > 1:
            raise PreviewSourceMissing("must not leak")
        return original(*args, **kwargs)

    monkeypatch.setattr(scheduler_app.state.runtime.window_asr, "inspect", disappearing)
    accepted = await scheduler_client.post(
        f"/sessions/{session_id}/asr/live/advance", json={"through_sequence": 0}
    )
    assert accepted.status_code == 202
    terminal = await _wait_terminal(scheduler_client, session_id)
    assert terminal["status"] == "stalled"
    assert terminal["block_reason"] == "source_missing"


async def test_unexpected_background_failure_becomes_visible_bounded_stall(
    scheduler_client: httpx.AsyncClient,
    scheduler_app: Any,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A scheduler task must never disappear while its public status stays `running`."""
    await _local(scheduler_client)
    caplog.set_level("ERROR", logger="audiohelper.live_scheduler")
    session_id = await _session(scheduler_client)
    await _store(scheduler_client, session_id, 0)

    async def crash(*_args: object) -> LiveAsrDraftResponse:
        raise RuntimeError("unexpected decoder integration failure")

    scheduler_app.state.runtime.live_asr.update = crash
    accepted = await scheduler_client.post(
        f"/sessions/{session_id}/asr/live/advance", json={"through_sequence": 0}
    )
    assert accepted.status_code == 202, accepted.text

    terminal = await _wait_terminal(scheduler_client, session_id)
    assert terminal["status"] == "stalled"
    assert terminal["block_reason"] == "decoder_failed"
    messages = [record.getMessage() for record in caplog.records]
    assert any("live_asr_scheduler_unexpected_failure" in item for item in messages)
    assert all("unexpected decoder integration failure" not in item for item in messages)


async def test_new_speech_after_quiet_window_is_processed_without_empty_final(
    scheduler_client: httpx.AsyncClient,
    scheduler_app: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Quiet evidence must not terminate later scheduling or create an empty transcript row."""
    await _local(scheduler_client)
    session_id = await _session(scheduler_client)
    engine = WindowEngine(
        [
            [],
            [(" New", 5.1, 5.5)],
            [(" New", 5.1, 5.5), (" Tail", 10.1, 10.5)],
        ]
    )
    monkeypatch.setattr("audiohelper.gateways.asr.detect_speech_presence", lambda _samples: True)
    monkeypatch.setattr("audiohelper.gateways.asr.load_local_whisper", lambda *_a, **_k: engine)

    await _store(scheduler_client, session_id, 0)
    first = await scheduler_client.post(
        f"/sessions/{session_id}/asr/live/advance", json={"through_sequence": 0}
    )
    assert first.status_code == 202, first.text
    assert (await _wait_terminal(scheduler_client, session_id))["status"] == "complete"

    await _store(scheduler_client, session_id, 1)
    second = await scheduler_client.post(
        f"/sessions/{session_id}/asr/live/advance", json={"through_sequence": 1}
    )
    assert second.status_code == 202, second.text
    assert (await _wait_terminal(scheduler_client, session_id))["status"] == "complete"

    await _store(scheduler_client, session_id, 2)
    third = await scheduler_client.post(
        f"/sessions/{session_id}/asr/live/advance", json={"through_sequence": 2}
    )
    assert third.status_code == 202, third.text
    assert (await _wait_terminal(scheduler_client, session_id))["status"] == "complete"

    detail = (await scheduler_client.get(f"/sessions/{session_id}")).json()
    assert [segment["text"] for segment in detail["segments"]] == ["New"]
    draft = (await scheduler_client.get(f"/sessions/{session_id}/asr/live")).json()["draft"]
    assert draft["text"] == "Tail"


async def test_stopped_session_runs_trusted_final_pass_and_restores_complete_state(
    scheduler_client: httpx.AsyncClient,
    scheduler_app: Any,
    scheduler_config: AppConfig,
    outbound: FakeHttp,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Stop must finish a tail or expose a recovery error, never call that state complete."""
    await _local(scheduler_client)
    created = await scheduler_client.post(
        "/sessions", json={"title": "stop-tail", "mode": "contextual_local"}
    )
    assert created.status_code == 200, created.text
    session_id = str(created.json()["id"])
    await _store(scheduler_client, session_id, 0)
    engine = WindowEngine([[(' Tail', 1.0, 1.5)]])
    monkeypatch.setattr("audiohelper.gateways.asr.detect_speech_presence", lambda _samples: True)
    monkeypatch.setattr("audiohelper.gateways.asr.load_local_whisper", lambda *_a, **_k: engine)

    accepted = await scheduler_client.post(
        f"/sessions/{session_id}/asr/live/advance", json={"through_sequence": 0}
    )
    assert accepted.status_code == 202, accepted.text
    assert (await _wait_terminal(scheduler_client, session_id))["status"] == "complete"
    stopped = await scheduler_client.patch(
        f"/sessions/{session_id}",
        json={"status": "stopped", "flush_transcription": False},
    )
    assert stopped.status_code == 200, stopped.text

    status = await _wait_terminal(scheduler_client, session_id)
    draft = (await scheduler_client.get(f"/sessions/{session_id}/asr/live")).json()["draft"]
    assert draft is not None and draft["text"] == ""
    assert status["status"] == "complete"
    assert status["block_reason"] is None
    assert status["source_ended"] is True
    assert status["recovery_required"] is False
    assert status["available_audio_processed"] is True
    assert [
        segment["text"]
        for segment in (await scheduler_client.get(f"/sessions/{session_id}")).json()["segments"]
    ] == ["Tail"]

    changed = await scheduler_client.put(
        "/settings",
        json={
            "asr": {"provider": "openai", "model": "whisper-1"},
            "contextual_local_enabled": False,
        },
    )
    assert changed.status_code == 200, changed.text

    scheduler_app.state.runtime.close()
    restarted = create_app(
        scheduler_config,
        secret_store=MemorySecretStore(),
        http_client=outbound.client(),
    )
    try:
        decode_calls = 0

        async def must_not_decode_on_get(*_args: object) -> LiveAsrDraftResponse:
            nonlocal decode_calls
            decode_calls += 1
            raise AssertionError("restart GET must remain read-only")

        restarted.state.runtime.live_asr.update = must_not_decode_on_get
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=restarted),
            base_url="http://127.0.0.1:8765",
            headers={"Authorization": f"Bearer {TOKEN}"},
        ) as client:
            restored = await _status(client, session_id)
            restored_draft = (
                await client.get(f"/sessions/{session_id}/asr/live")
            ).json()
        assert restored["capable"] is False
        assert restored["status"] == "complete"
        assert restored["block_reason"] is None
        assert restored["captured_target_sequence"] == 0
        assert restored["processed_window"]["last_sequence"] == 0
        assert restored["processed_window"]["start_ms"] == 0
        assert restored["processed_window"]["end_ms"] == 5_000
        assert restored["source_ended"] is True
        assert restored["recovery_required"] is False
        assert restored["available_audio_processed"] is True
        assert restored_draft["draft"]["text"] == ""
        assert restored_draft["resume_compatibility"]["can_resume"] is False
        assert decode_calls == 0
    finally:
        restarted.state.runtime.close()


async def test_stop_racing_active_decode_serializes_one_successful_final_pass(
    scheduler_client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    await _local(scheduler_client)
    created = await scheduler_client.post(
        "/sessions", json={"title": "stop-race", "mode": "contextual_local"}
    )
    session_id = str(created.json()["id"])
    await _store(scheduler_client, session_id, 0)
    entered = threading.Event()
    release = threading.Event()
    engine = WindowEngine([[(' Tail', 1.0, 1.5)]], entered=entered, release=release)
    monkeypatch.setattr("audiohelper.gateways.asr.detect_speech_presence", lambda _samples: True)
    monkeypatch.setattr("audiohelper.gateways.asr.load_local_whisper", lambda *_a, **_k: engine)

    accepted = await scheduler_client.post(
        f"/sessions/{session_id}/asr/live/advance", json={"through_sequence": 0}
    )
    assert accepted.status_code == 202, accepted.text
    await asyncio.wait_for(asyncio.to_thread(entered.wait), timeout=1)
    stopped = await scheduler_client.patch(
        f"/sessions/{session_id}",
        json={"status": "stopped", "flush_transcription": False},
    )
    assert stopped.status_code == 200, stopped.text
    release.set()

    terminal = await _wait_terminal(scheduler_client, session_id)
    assert terminal["status"] == "complete"
    assert terminal["block_reason"] is None
    assert terminal["source_ended"] is True
    assert terminal["recovery_required"] is False
    assert engine.calls == 2


async def test_late_durable_source_after_stop_cannot_leave_false_complete(
    scheduler_client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    await _local(scheduler_client)
    created = await scheduler_client.post(
        "/sessions", json={"title": "late-source", "mode": "contextual_local"}
    )
    session_id = str(created.json()["id"])
    engine = WindowEngine([[]])
    monkeypatch.setattr("audiohelper.gateways.asr.detect_speech_presence", lambda _samples: True)
    monkeypatch.setattr("audiohelper.gateways.asr.load_local_whisper", lambda *_a, **_k: engine)
    await _store(scheduler_client, session_id, 0)
    accepted = await scheduler_client.post(
        f"/sessions/{session_id}/asr/live/advance", json={"through_sequence": 0}
    )
    assert accepted.status_code == 202, accepted.text
    assert (await _wait_terminal(scheduler_client, session_id))["status"] == "complete"
    stopped = await scheduler_client.patch(
        f"/sessions/{session_id}",
        json={"status": "stopped", "flush_transcription": False},
    )
    assert stopped.status_code == 200, stopped.text

    await _store(scheduler_client, session_id, 1)
    status = await _status(scheduler_client, session_id)

    assert status["status"] == "stalled"
    assert status["captured_target_sequence"] == 1
    assert status["block_reason"] == "finality_blocked"
    assert status["source_ended"] is True
    assert status["recovery_required"] is True
    assert status["available_audio_processed"] is False


async def test_scheduler_real_local_adapter_rolls_over_with_extension_room(
    scheduler_client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level("INFO", logger="audiohelper.live_scheduler")
    await _local(scheduler_client)
    session_id = await _session(scheduler_client)
    for sequence in range(7):
        await _store(scheduler_client, session_id, sequence)
    hypotheses = [
        [(" Alpha", 1.0, 2.0), (" Beta", 10.0, 11.0), (" Tail", 24.0, 24.5)],
        [(" Alpha", 1.0, 2.0), (" Beta", 10.0, 11.0), (" Tail", 24.0, 24.5)],
        [(" Tail", 4.0, 4.5)],
        [(" Tail", 4.0, 4.5), (" New", 12.0, 12.5)],
    ]
    engine = WindowEngine(hypotheses)
    downloads: list[bool] = []
    monkeypatch.setattr("audiohelper.gateways.asr.detect_speech_presence", lambda _samples: True)

    def load(_model: str, *, allow_download: bool) -> WindowEngine:
        downloads.append(allow_download)
        return engine

    monkeypatch.setattr("audiohelper.gateways.asr.load_local_whisper", load)
    accepted = await scheduler_client.post(
        f"/sessions/{session_id}/asr/live/advance", json={"through_sequence": 6}
    )
    assert accepted.status_code == 202, accepted.text
    terminal = await _wait_terminal(scheduler_client, session_id)

    assert terminal["status"] == "complete"
    assert terminal["processed_window"] == {
        "first_sequence": 4,
        "last_sequence": 6,
        "start_ms": 20_000,
        "end_ms": 35_000,
    }
    assert engine.durations == [25.0, 30.0, 10.0, 15.0]
    assert max(engine.durations) == 30.0
    assert downloads == [False]
    assert terminal["stable_frontier_ms"] == 24_500
    decisions = [record.getMessage() for record in caplog.records]
    assert decisions == [
        "live_asr_scheduler_decision first_sequence=0 last_sequence=4 "
        "start_ms=0 end_ms=25000 reason=initial",
        "live_asr_scheduler_decision first_sequence=0 last_sequence=5 "
        "start_ms=0 end_ms=30000 reason=extend",
        "live_asr_scheduler_decision first_sequence=4 last_sequence=5 "
        "start_ms=20000 end_ms=30000 reason=rollover",
        "live_asr_scheduler_decision first_sequence=4 last_sequence=6 "
        "start_ms=20000 end_ms=35000 reason=extend",
    ]


async def test_rollover_retries_only_one_earlier_anchor_then_stalls(
    scheduler_client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    await _local(scheduler_client)
    session_id = await _session(scheduler_client)
    for sequence in range(7):
        await _store(scheduler_client, session_id, sequence)
    engine = WindowEngine(
        [
            [(" Alpha", 1.0, 2.0), (" Tail", 24.0, 24.5)],
            [(" Alpha", 1.0, 2.0), (" Tail", 24.0, 24.5)],
            [(" Wrong", 4.0, 4.5)],
            [(" Still-wrong", 9.0, 9.5)],
            [(" must-not-retry", 1.0, 2.0)],
        ]
    )
    monkeypatch.setattr("audiohelper.gateways.asr.detect_speech_presence", lambda _samples: True)
    monkeypatch.setattr("audiohelper.gateways.asr.load_local_whisper", lambda *_a, **_k: engine)

    accepted = await scheduler_client.post(
        f"/sessions/{session_id}/asr/live/advance", json={"through_sequence": 6}
    )
    assert accepted.status_code == 202
    terminal = await _wait_terminal(scheduler_client, session_id)

    assert terminal["status"] == "stalled"
    assert terminal["block_reason"] == "no_safe_anchor"
    assert engine.calls == 4
    assert engine.durations == [25.0, 30.0, 10.0, 15.0]


async def test_source_limit_and_cloud_are_rejected_before_decoder_admission(
    client: httpx.AsyncClient, app: Any
) -> None:
    session_id = await _session(client)
    await _store(client, session_id, 0)
    cloud = await client.post(
        f"/sessions/{session_id}/asr/live/advance", json={"through_sequence": 0}
    )
    assert cloud.status_code == 400
    assert app.state.runtime.live_scheduler._task is None

    await _local(client)
    object.__setattr__(app.state.runtime.config, "live_finality_enabled", True)
    object.__setattr__(app.state.runtime.config, "local_speech_gate", True)
    object.__setattr__(app.state.runtime.config, "max_chunk_bytes", 1_000)
    oversized = await client.post(
        f"/sessions/{session_id}/asr/live/advance", json={"through_sequence": 0}
    )
    assert oversized.status_code == 413
    assert app.state.runtime.live_scheduler._task is None


async def test_config_change_and_delete_stop_old_jobs_without_retry(
    scheduler_client: httpx.AsyncClient, scheduler_app: Any
) -> None:
    await _local(scheduler_client)
    session_id = await _session(scheduler_client)
    await _store(scheduler_client, session_id, 0)
    entered = asyncio.Event()
    release = asyncio.Event()
    calls = 0

    async def delayed(*_args: object) -> LiveAsrDraftResponse:
        nonlocal calls
        calls += 1
        entered.set()
        await release.wait()
        return LiveAsrDraftResponse(draft=None)

    scheduler_app.state.runtime.live_asr.update = delayed
    accepted = await scheduler_client.post(
        f"/sessions/{session_id}/asr/live/advance", json={"through_sequence": 0}
    )
    assert accepted.status_code == 202
    await entered.wait()
    changed = await scheduler_client.put("/settings", json={"transcript_language": "en"})
    assert changed.status_code == 200
    release.set()
    terminal = await _wait_terminal(scheduler_client, session_id)
    assert terminal["status"] == "stalled"
    assert terminal["block_reason"] == "config_changed"
    assert calls == 1

    # A new explicit admission is required; deleting during it cannot resurrect state.
    await _local(scheduler_client)
    entered.clear()
    release.clear()
    accepted = await scheduler_client.post(
        f"/sessions/{session_id}/asr/live/advance", json={"through_sequence": 0}
    )
    assert accepted.status_code == 202
    await entered.wait()
    deleted = await scheduler_client.delete(f"/sessions/{session_id}")
    assert deleted.status_code == 200
    release.set()
    for _ in range(100):
        if scheduler_app.state.runtime.live_scheduler._task is None:
            break
        await asyncio.sleep(0)
    assert scheduler_app.state.runtime.live_scheduler._state == "stalled"
    assert scheduler_app.state.runtime.live_scheduler._block_reason == "session_missing"
    assert calls == 2


async def test_manual_preview_observes_decoder_busy_while_scheduler_owns_it(
    scheduler_client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    await _local(scheduler_client)
    session_id = await _session(scheduler_client)
    await _store(scheduler_client, session_id, 0)
    entered = threading.Event()
    release = threading.Event()
    engine = WindowEngine(
        [[(" One", 0.5, 1.0)]],
        entered=entered,
        release=release,
    )
    monkeypatch.setattr("audiohelper.gateways.asr.detect_speech_presence", lambda _samples: True)
    monkeypatch.setattr("audiohelper.gateways.asr.load_local_whisper", lambda *_a, **_k: engine)
    accepted = await scheduler_client.post(
        f"/sessions/{session_id}/asr/live/advance", json={"through_sequence": 0}
    )
    assert accepted.status_code == 202
    assert await asyncio.to_thread(entered.wait, 5)
    manual = await scheduler_client.post(
        f"/sessions/{session_id}/asr/preview",
        json={"first_sequence": 0, "last_sequence": 0},
    )
    assert manual.status_code == 429
    release.set()
    await _wait_terminal(scheduler_client, session_id)
    assert engine.calls == 1
