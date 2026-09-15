from __future__ import annotations

import asyncio
import threading
from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx
import numpy as np
import pytest

from audiohelper.app import create_app
from audiohelper.config import AppConfig
from audiohelper.gateways.asr import LocalWhisperTranscriber
from audiohelper.secrets import MemorySecretStore
from tests.conftest import TOKEN, FakeHttp, make_wav

Word = tuple[str, float, float]


class FragmentEngine:
    def __init__(self, hypotheses: list[list[Word]], *, block_call: int | None = None) -> None:
        self.hypotheses = hypotheses
        self.block_call = block_call
        self.calls = 0
        self.entered = threading.Event()
        self.release = threading.Event()

    def transcribe(
        self,
        samples: np.ndarray[Any, Any],
        *,
        language: str | None,
        vad_filter: bool,
        word_timestamps: bool = False,
    ) -> tuple[list[Any], Any]:
        assert vad_filter is False
        assert word_timestamps is True
        call = self.calls
        self.calls += 1
        if self.block_call == call:
            self.entered.set()
            assert self.release.wait(timeout=5)
        selected = self.hypotheses[min(call, len(self.hypotheses) - 1)]
        words = [SimpleNamespace(word=text, start=start, end=end) for text, start, end in selected]
        segment = SimpleNamespace(
            start=words[0].start if words else 0.0,
            end=words[-1].end if words else 0.0,
            text="".join(word.word for word in words),
            words=words,
        )
        return ([segment] if words else []), SimpleNamespace(language="en")


class FailingFinalEngine(FragmentEngine):
    def transcribe(self, *args: Any, **kwargs: Any) -> tuple[list[Any], Any]:
        if self.calls == 1:
            self.calls += 1
            raise RuntimeError("fixture final-pass failure")
        return super().transcribe(*args, **kwargs)


@pytest.fixture(autouse=True)
def clear_local_model_cache(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    LocalWhisperTranscriber._models.clear()
    monkeypatch.setattr("audiohelper.gateways.asr.detect_speech_presence", lambda _samples: True)
    yield
    LocalWhisperTranscriber._models.clear()


@pytest.fixture
def fragment_config(tmp_path: Path) -> AppConfig:
    config = AppConfig(token=TOKEN, data_dir=tmp_path / "data", request_timeout_s=5.0)
    object.__setattr__(config, "live_finality_enabled", True)
    object.__setattr__(config, "local_speech_gate", True)
    object.__setattr__(config, "live_finality_guard_ms", 200)
    return config


@pytest.fixture
def fragment_app(fragment_config: AppConfig, outbound: FakeHttp) -> Iterator[Any]:
    application = create_app(
        fragment_config,
        secret_store=MemorySecretStore(),
        http_client=outbound.client(),
    )
    yield application
    application.state.runtime.close()


@pytest.fixture
async def fragment_client(fragment_app: Any) -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=fragment_app),
        base_url="http://127.0.0.1:8765",
        headers={"Authorization": f"Bearer {TOKEN}"},
    ) as client:
        yield client


async def _session(client: httpx.AsyncClient) -> str:
    created = await client.post(
        "/sessions", json={"title": "protected fragments", "mode": "contextual_local"}
    )
    assert created.status_code == 200, created.text
    return str(created.json()["id"])


async def _local(client: httpx.AsyncClient) -> None:
    response = await client.put(
        "/settings",
        json={
            "asr": {"provider": "local-whisper", "model": "small"},
            "transcript_language": "en",
        },
    )
    assert response.status_code == 200, response.text


async def _store(client: httpx.AsyncClient, session_id: str, sequence: int) -> None:
    response = await client.post(
        f"/sessions/{session_id}/audio/store",
        params={"sequence": sequence, "start_ms": sequence * 1_000, "end_ms": (sequence + 1) * 1_000},
        content=make_wav(1.0, frequency=220 + sequence * 40),
        headers={"Content-Type": "audio/wav"},
    )
    assert response.status_code == 201, response.text


async def _update(
    client: httpx.AsyncClient,
    session_id: str,
    last_sequence: int,
    expected_revision: int,
) -> httpx.Response:
    return await client.post(
        f"/sessions/{session_id}/asr/live/update",
        json={
            "first_sequence": 0,
            "last_sequence": last_sequence,
            "expected_revision": expected_revision,
        },
    )


async def _fragments(client: httpx.AsyncClient, session_id: str) -> list[dict[str, Any]]:
    response = await client.get(f"/sessions/{session_id}/asr/fragments")
    assert response.status_code == 200, response.text
    return list(response.json()["fragments"])


async def _wait_scheduler_terminal(
    client: httpx.AsyncClient, session_id: str
) -> dict[str, Any]:
    for _ in range(100):
        response = await client.get(f"/sessions/{session_id}/asr/live/scheduler")
        assert response.status_code == 200, response.text
        status = dict(response.json())
        if status["status"] in {"complete", "stalled", "stopped"}:
            return status
        await asyncio.sleep(0)
    raise AssertionError("source-ended final pass did not terminate")


async def test_edit_uses_absolute_range_and_later_speech_becomes_a_separate_tail(
    fragment_client: httpx.AsyncClient,
    fragment_app: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    await _local(fragment_client)
    session_id = await _session(fragment_client)
    await _store(fragment_client, session_id, 0)
    await _store(fragment_client, session_id, 1)
    engine = FragmentEngine(
        [
            [(" Alpha", 0.10, 0.30), (" beta", 0.50, 0.70)],
            [(" Alpha", 0.11, 0.31), (" beta", 0.51, 0.71), (" later", 1.20, 1.40)],
            [
                (" Alpha", 0.11, 0.31),
                (" beta", 0.51, 0.71),
                (" later", 1.21, 1.41),
                (" newest", 2.20, 2.40),
            ],
        ]
    )
    monkeypatch.setattr("audiohelper.gateways.asr.load_local_whisper", lambda *_a, **_k: engine)

    first = await _update(fragment_client, session_id, 0, 0)
    assert first.status_code == 200, first.text
    [fragment] = await _fragments(fragment_client, session_id)
    assert fragment["state"] == "open"
    assert fragment["text"] == "Alpha beta"
    assert fragment["start_ms"] == 100
    assert fragment["observed_end_ms"] == fragment["protected_through_ms"] == 700
    assert fragment["can_edit"] is True
    original_sources = fragment["sources"]
    original_range_fingerprint = fragment["range_fingerprint"]

    edited = await fragment_client.put(
        f"/sessions/{session_id}/asr/fragments/{fragment['fragment_id']}/text",
        json={
            "text": "Alpha beta expanded into several human words",
            "expected_revision": fragment["revision"],
            "range_fingerprint": original_range_fingerprint,
        },
    )
    assert edited.status_code == 200, edited.text
    edited_fragment = edited.json()
    assert edited_fragment["revision"] == fragment["revision"] + 1
    assert edited_fragment["text"] == "Alpha beta expanded into several human words"
    assert edited_fragment["start_ms"] == 100
    assert edited_fragment["observed_end_ms"] == edited_fragment["protected_through_ms"] == 700
    assert edited_fragment["sources"] == original_sources
    assert edited_fragment["range_fingerprint"] == original_range_fingerprint

    extended = await _update(fragment_client, session_id, 1, 1)
    assert extended.status_code == 200, extended.text
    rows = await _fragments(fragment_client, session_id)
    protected = next(row for row in rows if row["fragment_id"] == fragment["fragment_id"])
    tail = next(row for row in rows if row["fragment_id"] != fragment["fragment_id"])
    assert protected["state"] == "complete"
    assert protected["text"] == "Alpha beta expanded into several human words"
    assert protected["completion_provenance"] == "live_agreement"
    assert protected["can_accept"] is True
    assert tail["state"] == "open"
    assert tail["text"] == "later"
    assert tail["start_ms"] == 1_200
    assert tail["observed_end_ms"] == 1_400

    detail = (await fragment_client.get(f"/sessions/{session_id}")).json()
    assert [(item["text"], item["start_ms"], item["end_ms"]) for item in detail["segments"]] == [
        ("Alpha beta expanded into several human words", 100, 700)
    ]
    with fragment_app.state.runtime.db.read() as connection:
        assert connection.execute(
            "SELECT COUNT(*) FROM segments_fts WHERE session_id=?", (session_id,)
        ).fetchone()[0] == 1
        assert connection.execute(
            "SELECT COUNT(*) FROM segment_sources WHERE session_id=?", (session_id,)
        ).fetchone()[0] == len(original_sources)

    shortened = await fragment_client.put(
        f"/sessions/{session_id}/asr/fragments/{tail['fragment_id']}/text",
        json={
            "text": "L",
            "expected_revision": tail["revision"],
            "range_fingerprint": tail["range_fingerprint"],
        },
    )
    assert shortened.status_code == 200, shortened.text
    assert shortened.json()["start_ms"] == 1_200
    assert shortened.json()["observed_end_ms"] == 1_400
    await _store(fragment_client, session_id, 2)
    progressed = await _update(fragment_client, session_id, 2, 2)
    assert progressed.status_code == 200, progressed.text
    final_rows = await _fragments(fragment_client, session_id)
    assert [row["text"] for row in final_rows] == [
        "Alpha beta expanded into several human words",
        "L",
        "newest",
    ]
    assert [row["state"] for row in final_rows] == ["complete", "complete", "open"]


async def test_accept_requires_complete_revision_and_is_idempotent(
    fragment_client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    await _local(fragment_client)
    session_id = await _session(fragment_client)
    await _store(fragment_client, session_id, 0)
    await _store(fragment_client, session_id, 1)
    engine = FragmentEngine(
        [
            [(" Ready", 0.10, 0.30)],
            [(" Ready", 0.11, 0.31), (" tail", 1.20, 1.40)],
        ]
    )
    monkeypatch.setattr("audiohelper.gateways.asr.load_local_whisper", lambda *_a, **_k: engine)
    assert (await _update(fragment_client, session_id, 0, 0)).status_code == 200
    [open_fragment] = await _fragments(fragment_client, session_id)

    unready = await fragment_client.post(
        f"/sessions/{session_id}/asr/fragments/{open_fragment['fragment_id']}/accept",
        json={
            "expected_revision": open_fragment["revision"],
            "range_fingerprint": open_fragment["range_fingerprint"],
            "idempotency_key": "review-1",
        },
    )
    assert unready.status_code == 409
    assert unready.json()["detail"] == "Fragment processing is not complete."

    assert (await _update(fragment_client, session_id, 1, 1)).status_code == 200
    complete = next(
        row for row in await _fragments(fragment_client, session_id)
        if row["fragment_id"] == open_fragment["fragment_id"]
    )
    payload = {
        "expected_revision": complete["revision"],
        "range_fingerprint": complete["range_fingerprint"],
        "idempotency_key": "review-1",
    }
    first = await fragment_client.post(
        f"/sessions/{session_id}/asr/fragments/{complete['fragment_id']}/accept", json=payload
    )
    second = await fragment_client.post(
        f"/sessions/{session_id}/asr/fragments/{complete['fragment_id']}/accept", json=payload
    )
    assert first.status_code == second.status_code == 200
    assert first.json() == second.json()
    assert first.json()["accepted_at"] is not None
    assert first.json()["revision"] == complete["revision"] + 1

    stale = await fragment_client.post(
        f"/sessions/{session_id}/asr/fragments/{complete['fragment_id']}/accept",
        json={**payload, "idempotency_key": "review-2"},
    )
    assert stale.status_code == 409


async def test_edit_during_decode_invalidates_old_result_but_preserves_new_audio_for_retry(
    fragment_client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    await _local(fragment_client)
    session_id = await _session(fragment_client)
    await _store(fragment_client, session_id, 0)
    await _store(fragment_client, session_id, 1)
    engine = FragmentEngine(
        [
            [(" Original", 0.10, 0.40)],
            [(" Original", 0.11, 0.41), (" new", 1.20, 1.40)],
            [(" Original", 0.11, 0.41), (" new", 1.20, 1.40)],
        ],
        block_call=1,
    )
    monkeypatch.setattr("audiohelper.gateways.asr.load_local_whisper", lambda *_a, **_k: engine)
    assert (await _update(fragment_client, session_id, 0, 0)).status_code == 200
    [fragment] = await _fragments(fragment_client, session_id)

    delayed = asyncio.create_task(_update(fragment_client, session_id, 1, 1))
    assert await asyncio.to_thread(engine.entered.wait, 2)
    edited = await fragment_client.put(
        f"/sessions/{session_id}/asr/fragments/{fragment['fragment_id']}/text",
        json={
            "text": "Human correction",
            "expected_revision": fragment["revision"],
            "range_fingerprint": fragment["range_fingerprint"],
        },
    )
    assert edited.status_code == 200, edited.text
    engine.release.set()
    stale = await delayed
    assert stale.status_code == 409
    [protected] = await _fragments(fragment_client, session_id)
    assert protected["text"] == "Human correction"

    retried = await _update(fragment_client, session_id, 1, 1)
    assert retried.status_code == 200, retried.text
    rows = await _fragments(fragment_client, session_id)
    assert any(row["text"] == "Human correction" for row in rows)
    assert any(row["text"] == "new" for row in rows)


async def test_fragment_source_corruption_is_visible_and_blocks_edit(
    fragment_client: httpx.AsyncClient,
    fragment_app: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    await _local(fragment_client)
    session_id = await _session(fragment_client)
    await _store(fragment_client, session_id, 0)
    engine = FragmentEngine([[(" Stored", 0.10, 0.40)]])
    monkeypatch.setattr("audiohelper.gateways.asr.load_local_whisper", lambda *_a, **_k: engine)
    assert (await _update(fragment_client, session_id, 0, 0)).status_code == 200
    [fragment] = await _fragments(fragment_client, session_id)
    with fragment_app.state.runtime.db.read() as connection:
        path = Path(connection.execute(
            "SELECT path FROM chunks WHERE session_id=? AND sequence=0", (session_id,)
        ).fetchone()[0])
    path.write_bytes(b"corrupt")

    [corrupt] = await _fragments(fragment_client, session_id)
    assert corrupt["source_integrity"] == "corrupt"
    assert corrupt["can_edit"] is False
    blocked = await fragment_client.put(
        f"/sessions/{session_id}/asr/fragments/{fragment['fragment_id']}/text",
        json={
            "text": "must not persist",
            "expected_revision": fragment["revision"],
            "range_fingerprint": fragment["range_fingerprint"],
        },
    )
    assert blocked.status_code == 409
    assert "source" in blocked.json()["detail"].lower()


async def test_source_end_runs_one_trusted_final_pass_and_completes_without_punctuation(
    fragment_client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    await _local(fragment_client)
    session_id = await _session(fragment_client)
    await _store(fragment_client, session_id, 0)
    engine = FragmentEngine(
        [
            [(" unfinished sentence", 0.20, 0.80)],
            [(" unfinished sentence", 0.21, 0.81)],
        ]
    )
    monkeypatch.setattr("audiohelper.gateways.asr.detect_speech_presence", lambda _samples: True)
    monkeypatch.setattr("audiohelper.gateways.asr.load_local_whisper", lambda *_a, **_k: engine)
    assert (await _update(fragment_client, session_id, 0, 0)).status_code == 200

    stopped = await fragment_client.patch(
        f"/sessions/{session_id}",
        json={"status": "stopped", "flush_transcription": False},
    )
    assert stopped.status_code == 200, stopped.text
    terminal = await _wait_scheduler_terminal(fragment_client, session_id)
    assert terminal["status"] == "complete", terminal
    assert terminal["source_ended"] is True
    assert terminal["recovery_required"] is False
    assert engine.calls == 2

    [fragment] = await _fragments(fragment_client, session_id)
    assert fragment["state"] == "complete"
    assert fragment["completion_provenance"] == "source_ended_final_pass"
    detail = (await fragment_client.get(f"/sessions/{session_id}")).json()
    assert [segment["text"] for segment in detail["segments"]] == ["unfinished sentence"]
    live = (await fragment_client.get(f"/sessions/{session_id}/asr/live")).json()
    assert live["draft"]["text"] == ""


async def test_invalid_final_pass_is_recoverable_and_not_retried_by_repeated_stop(
    fragment_client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    await _local(fragment_client)
    session_id = await _session(fragment_client)
    await _store(fragment_client, session_id, 0)
    engine = FragmentEngine(
        [
            [(" retained", 0.20, 0.80)],
            [(" retained", 0.20, 6.00)],
            [(" retained", 0.21, 0.81)],
        ]
    )
    monkeypatch.setattr("audiohelper.gateways.asr.detect_speech_presence", lambda _samples: True)
    monkeypatch.setattr("audiohelper.gateways.asr.load_local_whisper", lambda *_a, **_k: engine)
    assert (await _update(fragment_client, session_id, 0, 0)).status_code == 200

    for _ in range(2):
        stopped = await fragment_client.patch(
            f"/sessions/{session_id}",
            json={"status": "stopped", "flush_transcription": False},
        )
        assert stopped.status_code == 200
        terminal = await _wait_scheduler_terminal(fragment_client, session_id)
        assert terminal["status"] == "stalled"
        assert terminal["block_reason"] == "finality_blocked"
    assert engine.calls == 2
    [fragment] = await _fragments(fragment_client, session_id)
    assert fragment["state"] == "error"
    assert fragment["state_reason"] == "finality_blocked"
    assert fragment["text"] == "retained"
    assert (await fragment_client.get(f"/sessions/{session_id}")).json()["segments"] == []

    retried = await fragment_client.post(
        f"/sessions/{session_id}/asr/live/advance", json={"through_sequence": 0}
    )
    assert retried.status_code == 202, retried.text
    assert (await _wait_scheduler_terminal(fragment_client, session_id))["status"] == "complete"
    assert engine.calls == 3


async def test_missing_source_before_final_pass_is_visible_and_does_not_create_final(
    fragment_client: httpx.AsyncClient,
    fragment_app: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    await _local(fragment_client)
    session_id = await _session(fragment_client)
    await _store(fragment_client, session_id, 0)
    engine = FragmentEngine([[(" retained", 0.20, 0.80)]])
    monkeypatch.setattr("audiohelper.gateways.asr.detect_speech_presence", lambda _samples: True)
    monkeypatch.setattr("audiohelper.gateways.asr.load_local_whisper", lambda *_a, **_k: engine)
    assert (await _update(fragment_client, session_id, 0, 0)).status_code == 200
    with fragment_app.state.runtime.db.read() as connection:
        source_path = Path(connection.execute(
            "SELECT path FROM chunks WHERE session_id=? AND sequence=0", (session_id,)
        ).fetchone()[0])
    source_path.unlink()

    assert (await fragment_client.patch(
        f"/sessions/{session_id}",
        json={"status": "stopped", "flush_transcription": False},
    )).status_code == 200
    terminal = await _wait_scheduler_terminal(fragment_client, session_id)
    assert terminal["status"] == "stalled"
    assert terminal["block_reason"] == "source_missing"
    [fragment] = await _fragments(fragment_client, session_id)
    assert fragment["state"] == "error"
    assert fragment["state_reason"] == "source_missing"
    assert fragment["source_integrity"] == "missing"
    assert (await fragment_client.get(f"/sessions/{session_id}")).json()["segments"] == []


@pytest.mark.parametrize("failure", ["corrupt", "decoder"])
async def test_corrupt_or_failing_final_pass_preserves_recoverable_fragment(
    fragment_client: httpx.AsyncClient,
    fragment_app: Any,
    monkeypatch: pytest.MonkeyPatch,
    failure: str,
) -> None:
    await _local(fragment_client)
    session_id = await _session(fragment_client)
    await _store(fragment_client, session_id, 0)
    engine: FragmentEngine = (
        FailingFinalEngine([[(" retained", 0.20, 0.80)]])
        if failure == "decoder"
        else FragmentEngine([[(" retained", 0.20, 0.80)]])
    )
    monkeypatch.setattr("audiohelper.gateways.asr.load_local_whisper", lambda *_a, **_k: engine)
    assert (await _update(fragment_client, session_id, 0, 0)).status_code == 200
    if failure == "corrupt":
        with fragment_app.state.runtime.db.read() as connection:
            source_path = Path(connection.execute(
                "SELECT path FROM chunks WHERE session_id=? AND sequence=0", (session_id,)
            ).fetchone()[0])
        source_path.write_bytes(b"not the authenticated wav")

    assert (await fragment_client.patch(
        f"/sessions/{session_id}",
        json={"status": "stopped", "flush_transcription": False},
    )).status_code == 200
    terminal = await _wait_scheduler_terminal(fragment_client, session_id)
    assert terminal["status"] == "stalled"
    assert terminal["block_reason"] == (
        "source_conflict" if failure == "corrupt" else "decoder_failed"
    )
    [fragment] = await _fragments(fragment_client, session_id)
    assert fragment["state"] == "error"
    assert fragment["text"] == "retained"
    assert fragment["state_reason"] == terminal["block_reason"]
    assert (await fragment_client.get(f"/sessions/{session_id}")).json()["segments"] == []


async def test_protected_text_and_absolute_range_survive_restart_and_config_change(
    fragment_config: AppConfig,
    outbound: FakeHttp,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = FragmentEngine([[(" original", 0.20, 0.80)]])
    monkeypatch.setattr("audiohelper.gateways.asr.load_local_whisper", lambda *_a, **_k: engine)
    headers = {"Authorization": f"Bearer {TOKEN}"}
    first_app = create_app(
        fragment_config,
        secret_store=MemorySecretStore(),
        http_client=outbound.client(),
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=first_app),
        base_url="http://127.0.0.1:8765",
        headers=headers,
    ) as client:
        await _local(client)
        session_id = await _session(client)
        await _store(client, session_id, 0)
        assert (await _update(client, session_id, 0, 0)).status_code == 200
        [fragment] = await _fragments(client, session_id)
        edited = await client.put(
            f"/sessions/{session_id}/asr/fragments/{fragment['fragment_id']}/text",
            json={
                "text": "persistent human text",
                "expected_revision": fragment["revision"],
                "range_fingerprint": fragment["range_fingerprint"],
            },
        )
        assert edited.status_code == 200
        expected = edited.json()
    await first_app.state.runtime.http.aclose()
    first_app.state.runtime.close()

    restarted = create_app(
        fragment_config,
        secret_store=MemorySecretStore(),
        http_client=outbound.client(),
    )
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=restarted),
            base_url="http://127.0.0.1:8765",
            headers=headers,
        ) as client:
            [restored] = await _fragments(client, session_id)
            assert restored["fragment_id"] == expected["fragment_id"]
            assert restored["text"] == "persistent human text"
            assert restored["range_fingerprint"] == expected["range_fingerprint"]
            assert restored["start_ms"] == expected["start_ms"]
            assert restored["observed_end_ms"] == expected["observed_end_ms"]
            changed = await client.put(
                "/settings",
                json={"asr": {"provider": "local-whisper", "model": "base"}},
            )
            assert changed.status_code == 200
            [after_config] = await _fragments(client, session_id)
            assert after_config["text"] == "persistent human text"
            assert after_config["range_fingerprint"] == expected["range_fingerprint"]
    finally:
        await restarted.state.runtime.http.aclose()
        restarted.state.runtime.close()
