from __future__ import annotations

import asyncio
import sqlite3
import threading
from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

import httpx
import numpy as np
import pytest

from audiohelper.app import create_app
from audiohelper.config import AppConfig
from audiohelper.db import Database
from audiohelper.gateways.asr import LocalWhisperTranscriber
from audiohelper.secrets import MemorySecretStore
from tests.conftest import TOKEN, FakeHttp, chat_completion, make_wav

Word = tuple[str, float, float]


def test_finality_environment_is_off_by_default_and_guard_must_be_positive(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AUDIOHELPER_TOKEN", TOKEN)
    monkeypatch.delenv("AUDIOHELPER_LIVE_FINALITY", raising=False)
    monkeypatch.delenv("AUDIOHELPER_LIVE_FINALITY_GUARD_MS", raising=False)
    default = AppConfig.from_env(0)
    assert default.live_finality_enabled is False
    assert default.live_finality_guard_ms == 750

    monkeypatch.setenv("AUDIOHELPER_LIVE_FINALITY", "1")
    monkeypatch.setenv("AUDIOHELPER_LIVE_FINALITY_GUARD_MS", "0")
    with pytest.raises(SystemExit, match="positive integer"):
        AppConfig.from_env(0)


class ScriptedWordEngine:
    def __init__(self, hypotheses: list[list[Word] | None], language: str = "en") -> None:
        self.hypotheses = hypotheses
        self.language = language
        self.calls = 0
        self.word_timestamp_flags: list[bool] = []

    def transcribe(
        self,
        samples: np.ndarray[Any, Any],
        *,
        language: str | None,
        vad_filter: bool,
        word_timestamps: bool = False,
    ) -> tuple[list[Any], Any]:
        assert vad_filter is False
        self.word_timestamp_flags.append(word_timestamps)
        selected = self.hypotheses[min(self.calls, len(self.hypotheses) - 1)]
        self.calls += 1
        if selected is None:
            segment = SimpleNamespace(
                start=0.0,
                end=len(samples) / 16_000,
                text="unsupported evidence",
                words=None,
            )
        else:
            words = [SimpleNamespace(word=text, start=start, end=end) for text, start, end in selected]
            segment = SimpleNamespace(
                start=words[0].start if words else 0.0,
                end=words[-1].end if words else 0.0,
                text="".join(word.word for word in words),
                words=words,
            )
        return [segment] if segment.text else [], SimpleNamespace(language=self.language)


class CoordinatedWriterEngine:
    """Mock only the external decoder while public HTTP requests race."""

    def __init__(self, *, block: str | None = None) -> None:
        self.block = block
        self.context_calls = 0
        self.legacy_calls = 0
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
        if word_timestamps:
            call = self.context_calls
            self.context_calls += 1
            if self.block == "contextual" and call == 1:
                self.entered.set()
                assert self.release.wait(timeout=5), "contextual decoder was not released"
            words = (
                [(" Race", 0.10, 0.30)]
                if call == 0
                else [(" Race", 0.11, 0.31), (" tail", 1.10, 1.30)]
            )
        else:
            self.legacy_calls += 1
            if self.block == "legacy":
                self.entered.set()
                assert self.release.wait(timeout=5), "legacy decoder was not released"
            words = [(" Legacy", 0.05, 0.20)]
        word_rows = [SimpleNamespace(word=text, start=start, end=end) for text, start, end in words]
        segment = SimpleNamespace(
            start=word_rows[0].start,
            end=word_rows[-1].end,
            text="".join(word.word for word in word_rows),
            words=word_rows,
        )
        return [segment], SimpleNamespace(language="en")


@pytest.fixture(autouse=True)
def clear_local_model_cache() -> Iterator[None]:
    LocalWhisperTranscriber._models.clear()
    yield
    LocalWhisperTranscriber._models.clear()


@pytest.fixture
def finality_config(tmp_path: Path) -> AppConfig:
    config = AppConfig(token=TOKEN, data_dir=tmp_path / "data", request_timeout_s=5.0)
    object.__setattr__(config, "live_finality_enabled", True)
    object.__setattr__(config, "live_finality_guard_ms", 200)
    return config


@pytest.fixture
def finality_app(finality_config: AppConfig, outbound: FakeHttp) -> Iterator[Any]:
    application = create_app(
        finality_config,
        secret_store=MemorySecretStore(),
        http_client=outbound.client(),
    )
    yield application
    application.state.runtime.close()


@pytest.fixture
async def finality_client(finality_app: Any) -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=finality_app),
        base_url="http://127.0.0.1:8765",
        headers={"Authorization": f"Bearer {TOKEN}"},
    ) as client:
        yield client


async def create_session(client: httpx.AsyncClient) -> str:
    response = await client.post("/sessions", json={"title": "Stable prefix"})
    assert response.status_code == 200, response.text
    return str(response.json()["id"])


async def use_local_profile(
    client: httpx.AsyncClient, *, model: str = "small", language: str = "en"
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


async def update(
    client: httpx.AsyncClient,
    session_id: str,
    first_sequence: int,
    last_sequence: int,
    expected_revision: int,
) -> httpx.Response:
    return await client.post(
        f"/sessions/{session_id}/asr/live/update",
        json={
            "first_sequence": first_sequence,
            "last_sequence": last_sequence,
            "expected_revision": expected_revision,
        },
    )


def final_storage_snapshot(application: Any, session_id: str) -> dict[str, list[tuple[Any, ...]]]:
    with application.state.runtime.db.read() as connection:
        return {
            "segments": [
                tuple(row)
                for row in connection.execute(
                    "SELECT id, sequence, start_ms, end_ms, text, language FROM segments "
                    "WHERE session_id=? ORDER BY start_ms, id",
                    (session_id,),
                ).fetchall()
            ],
            "fts": [
                tuple(row)
                for row in connection.execute(
                    "SELECT segment_id, session_id, text FROM segments_fts "
                    "WHERE session_id=? ORDER BY segment_id",
                    (session_id,),
                ).fetchall()
            ],
            "sources": [
                tuple(row)
                for row in connection.execute(
                    "SELECT segment_id, sequence, sample_start, sample_end, sha256 "
                    "FROM segment_sources WHERE session_id=? ORDER BY segment_id, sequence",
                    (session_id,),
                ).fetchall()
            ],
            "chunks": [
                tuple(row)
                for row in connection.execute(
                    "SELECT sequence, status, error FROM chunks "
                    "WHERE session_id=? ORDER BY sequence",
                    (session_id,),
                ).fetchall()
            ],
        }


async def test_contextual_final_on_legacy_session_blocks_upload_retry_and_default_flush(
    finality_client: httpx.AsyncClient,
    finality_app: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    await use_local_profile(finality_client)
    session_id = await create_session(finality_client)
    first = make_wav(0.75, frequency=220)
    second = make_wav(0.75, frequency=330)
    await store(finality_client, session_id, 0, first, start_ms=0, end_ms=750)
    await store(finality_client, session_id, 1, second, start_ms=750, end_ms=1500)
    engine = CoordinatedWriterEngine()
    monkeypatch.setattr("audiohelper.gateways.asr.load_local_whisper", lambda *_a, **_k: engine)

    assert (await update(finality_client, session_id, 0, 0, 0)).status_code == 200
    committed = await update(finality_client, session_id, 0, 1, 1)
    assert committed.status_code == 200, committed.text
    final_id = committed.json()["finalized_segments"][0]["id"]
    before = final_storage_snapshot(finality_app, session_id)

    upload = await finality_client.post(
        f"/sessions/{session_id}/audio",
        params={"sequence": 2, "start_ms": 1500, "end_ms": 2000},
        content=make_wav(0.5, frequency=440),
        headers={"Content-Type": "audio/wav"},
    )
    retry = await finality_client.post(
        f"/sessions/{session_id}/audio",
        params={"sequence": 2, "start_ms": 1500, "end_ms": 2000},
        content=make_wav(0.5, frequency=440),
        headers={"Content-Type": "audio/wav"},
    )
    flushed = await finality_client.patch(f"/sessions/{session_id}", json={"status": "paused"})

    assert upload.status_code == retry.status_code == flushed.status_code == 409
    assert {upload.json()["detail"], retry.json()["detail"], flushed.json()["detail"]} == {
        "Session final transcript is owned by the contextual writer; legacy finalization is not allowed."
    }
    assert engine.legacy_calls == 0
    assert final_storage_snapshot(finality_app, session_id) == before
    detail = (await finality_client.get(f"/sessions/{session_id}")).json()
    assert detail["session"]["mode"] == "legacy"
    assert detail["segments"][0]["id"] == final_id
    assert (await finality_client.get(f"/sessions/{session_id}/audio/0")).content == first
    assert (await finality_client.get(f"/sessions/{session_id}/audio/1")).content == second


async def test_legacy_final_blocks_contextual_update_before_decoder_and_preserves_source(
    finality_client: httpx.AsyncClient,
    finality_app: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    await use_local_profile(finality_client)
    session_id = await create_session(finality_client)
    legacy_audio = make_wav(0.5, frequency=260)
    engine = CoordinatedWriterEngine()
    monkeypatch.setattr("audiohelper.gateways.asr.load_local_whisper", lambda *_a, **_k: engine)
    uploaded = await finality_client.post(
        f"/sessions/{session_id}/audio",
        params={"sequence": 0, "start_ms": 0, "end_ms": 500},
        content=legacy_audio,
        headers={"Content-Type": "audio/wav"},
    )
    assert uploaded.status_code == 200, uploaded.text
    before = final_storage_snapshot(finality_app, session_id)

    blocked = await update(finality_client, session_id, 0, 0, 0)

    assert blocked.status_code == 409
    assert blocked.json()["detail"] == (
        "Session final transcript is owned by the legacy writer; contextual finalization is not allowed."
    )
    assert engine.context_calls == 0
    assert final_storage_snapshot(finality_app, session_id) == before
    assert (await finality_client.get(f"/sessions/{session_id}/audio/0")).content == legacy_audio


@pytest.mark.parametrize("delayed_writer", ["contextual", "legacy"])
async def test_opposite_writer_race_commits_only_the_transaction_winner(
    finality_client: httpx.AsyncClient,
    finality_app: Any,
    monkeypatch: pytest.MonkeyPatch,
    delayed_writer: str,
) -> None:
    await use_local_profile(finality_client)
    session_id = await create_session(finality_client)
    first = make_wav(0.75, frequency=510)
    second = make_wav(0.75, frequency=610)
    legacy_audio = make_wav(0.5, frequency=710)
    await store(finality_client, session_id, 0, first, start_ms=0, end_ms=750)
    await store(finality_client, session_id, 1, second, start_ms=750, end_ms=1500)
    engine = CoordinatedWriterEngine(block=delayed_writer)
    monkeypatch.setattr("audiohelper.gateways.asr.load_local_whisper", lambda *_a, **_k: engine)

    async def legacy_upload() -> httpx.Response:
        return await finality_client.post(
            f"/sessions/{session_id}/audio",
            params={"sequence": 2, "start_ms": 1500, "end_ms": 2000},
            content=legacy_audio,
            headers={"Content-Type": "audio/wav"},
        )

    if delayed_writer == "contextual":
        assert (await update(finality_client, session_id, 0, 0, 0)).status_code == 200
        delayed = asyncio.create_task(update(finality_client, session_id, 0, 1, 1))
        assert await asyncio.to_thread(engine.entered.wait, 2)
        winner = await legacy_upload()
    else:
        delayed = asyncio.create_task(legacy_upload())
        assert await asyncio.to_thread(engine.entered.wait, 2)
        assert (await update(finality_client, session_id, 0, 0, 0)).status_code == 200
        winner = await update(finality_client, session_id, 0, 1, 1)
    engine.release.set()
    loser = await delayed

    assert winner.status_code == 200, winner.text
    assert loser.status_code == 409, loser.text
    rows = final_storage_snapshot(finality_app, session_id)
    assert len(rows["segments"]) == 1
    assert len(rows["fts"]) == 1
    if delayed_writer == "contextual":
        assert rows["segments"][0][4] == "Legacy"
        assert rows["sources"] == []
        assert rows["chunks"][-1] == (2, "done", None)
    else:
        assert rows["segments"][0][4] == "Race"
        assert len(rows["sources"]) == 1
        assert rows["sources"][0][0] == rows["segments"][0][0]
        assert rows["chunks"][-1] == (2, "pending", None)
    assert (await finality_client.get(f"/sessions/{session_id}/audio/0")).content == first
    assert (await finality_client.get(f"/sessions/{session_id}/audio/1")).content == second
    assert (await finality_client.get(f"/sessions/{session_id}/audio/2")).content == legacy_audio


async def test_default_off_keeps_live_draft_and_preview_read_only(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    await use_local_profile(client)
    session_id = await create_session(client)
    first = make_wav(0.75, frequency=220)
    second = make_wav(0.75, frequency=330)
    await store(client, session_id, 0, first, start_ms=0, end_ms=750)
    await store(client, session_id, 1, second, start_ms=750, end_ms=1500)
    engine = ScriptedWordEngine([[(' legacy draft', 0.1, 0.5)]])
    monkeypatch.setattr("audiohelper.gateways.asr.load_local_whisper", lambda *_a, **_k: engine)

    created = await update(client, session_id, 0, 0, 0)
    extended = await update(client, session_id, 0, 1, 1)
    preview = await client.post(
        f"/sessions/{session_id}/asr/preview",
        json={"first_sequence": 0, "last_sequence": 1},
    )

    assert created.status_code == extended.status_code == preview.status_code == 200
    assert extended.json()["draft"]["text"] == "legacy draft"
    assert "finality" not in extended.json()["draft"]
    assert "finalized_segments" not in extended.json()
    assert (await client.get(f"/sessions/{session_id}")).json()["segments"] == []
    assert engine.word_timestamp_flags == [False, False, False]


async def test_added_audio_commits_repeat_words_with_sources_and_hides_tail_from_search(
    finality_client: httpx.AsyncClient,
    finality_app: Any,
    outbound: FakeHttp,
    monkeypatch: pytest.MonkeyPatch,
    finality_config: AppConfig,
) -> None:
    await use_local_profile(finality_client)
    session_id = await create_session(finality_client)
    bodies = [make_wav(0.75, frequency=220 + index * 110) for index in range(3)]
    for sequence, body in enumerate(bodies):
        await store(
            finality_client,
            session_id,
            sequence,
            body,
            start_ms=sequence * 750,
            end_ms=(sequence + 1) * 750,
        )
    engine = ScriptedWordEngine(
        [
            [(' Alpha', 0.10, 0.30), (' go', 0.80, 0.95), (' go', 1.05, 1.20), (' old', 1.30, 1.42)],
            [(' Alpha', 0.11, 0.31), (' go', 0.81, 0.96), (' go', 1.06, 1.21), (' revised-tail', 1.80, 2.05)],
        ]
    )
    monkeypatch.setattr("audiohelper.gateways.asr.load_local_whisper", lambda *_a, **_k: engine)

    baseline = await update(finality_client, session_id, 0, 1, 0)
    assert baseline.status_code == 200, baseline.text
    assert baseline.json()["finalized_segments"] == []
    assert (await finality_client.get(f"/sessions/{session_id}")).json()["segments"] == []
    assert (await finality_client.post(f"/sessions/{session_id}/notes", json={})).status_code == 400
    no_final_answer = await finality_client.post(
        f"/sessions/{session_id}/ask", json={"question": "unrelated", "scope": "search"}
    )
    assert no_final_answer.status_code == 200
    assert outbound.requests == []

    committed = await update(finality_client, session_id, 0, 2, 1)
    assert committed.status_code == 200, committed.text
    body = committed.json()
    assert body["draft"]["text"] == "revised-tail"
    assert body["draft"]["text_scope"] == "unstable_tail"
    assert body["draft"]["finality"] == {
        "enabled": True,
        "status": "advanced",
        "stable_frontier_ms": 1210,
        "active_anchor_ms": 0,
        "stable_token_offset": 0,
    }
    assert len(body["finalized_segments"]) == 1
    finalized = body["finalized_segments"][0]
    assert finalized["text"] == "Alpha go go"
    assert [source["sequence"] for source in finalized["sources"]] == [0, 1]
    assert finalized["sources"][0]["sample_start"] == 1760
    assert finalized["sources"][0]["sample_end"] == 12000
    assert finalized["sources"][1]["sample_start"] == 0
    assert finalized["sources"][1]["sample_end"] == 7360

    detail = (await finality_client.get(f"/sessions/{session_id}")).json()
    assert detail["segments"] == [finalized]
    manifest = (await finality_client.get(f"/sessions/{session_id}/audio")).json()["chunks"]
    assert [chunk["segment_ids"] for chunk in manifest] == [
        [finalized["id"]],
        [finalized["id"]],
        [],
    ]
    for sequence, original in enumerate(bodies):
        assert (await finality_client.get(f"/sessions/{session_id}/audio/{sequence}")).content == original
        assert (finality_config.audio_dir / session_id / f"{sequence:06d}.wav").read_bytes() == original

    outbound.json_route(
        "GET",
        "openrouter.ai/api/v1/models",
        {
            "data": [
                {
                    "id": "local/test-agent",
                    "name": "Test agent",
                    "architecture": {"input_modalities": ["text"], "output_modalities": ["text"]},
                }
            ]
        },
    )
    configured = await finality_client.put(
        "/settings",
        json={"provider_keys": {"openrouter": "test-key"}, "agent": {"provider": "openrouter", "model": "local/test-agent"},
            "cloud_consent": True,
        },
    )
    assert configured.status_code == 200, configured.text
    outbound.json_route("POST", "chat/completions", chat_completion("Found [S1]", "local/test-agent"))
    searched = await finality_client.post(
        f"/sessions/{session_id}/ask", json={"question": "Alpha", "scope": "search"}
    )
    assert searched.status_code == 200, searched.text
    assert searched.json()["citations"][0]["segment_id"] == finalized["id"]
    prompt = "\n".join(message["content"] for message in outbound.last_body["messages"])
    assert "Alpha go go" in prompt
    assert "revised-tail" not in prompt
    with finality_app.state.runtime.db.read() as connection:
        assert connection.execute(
            "SELECT count(*) FROM segments_fts WHERE segment_id=?", (finalized["id"],)
        ).fetchone()[0] == 1


@pytest.mark.parametrize(
    ("first_surface", "second_surface"),
    [(" Word,", " Word"), (" Word?", " Word"), (" Word.", " Word")],
)
async def test_trailing_sentence_punctuation_does_not_break_lexical_word_agreement(
    finality_client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    first_surface: str,
    second_surface: str,
) -> None:
    await use_local_profile(finality_client)
    session_id = await create_session(finality_client)
    await store(finality_client, session_id, 0, make_wav(0.75), start_ms=0, end_ms=750)
    await store(finality_client, session_id, 1, make_wav(0.75), start_ms=750, end_ms=1500)
    engine = ScriptedWordEngine(
        [[(first_surface, 0.1, 0.3)], [(second_surface, 0.11, 0.31), (" tail", 1.1, 1.3)]]
    )
    monkeypatch.setattr("audiohelper.gateways.asr.load_local_whisper", lambda *_a, **_k: engine)

    assert (await update(finality_client, session_id, 0, 0, 0)).status_code == 200
    committed = await update(finality_client, session_id, 0, 1, 1)

    assert committed.status_code == 200, committed.text
    assert committed.json()["finalized_segments"][0]["text"] == second_surface.strip()
    assert committed.json()["draft"]["text"] == "tail"
    assert committed.json()["draft"]["text_scope"] == "unstable_tail"


@pytest.mark.parametrize(
    ("first_surface", "conflicting_surface"),
    [(" 1.5", " 15"), (" -5", " 5"), (" can't", " cant"), (" well-known", " wellknown")],
)
async def test_internal_word_punctuation_is_not_collapsed(
    finality_client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    first_surface: str,
    conflicting_surface: str,
) -> None:
    await use_local_profile(finality_client)
    session_id = await create_session(finality_client)
    await store(finality_client, session_id, 0, make_wav(0.75), start_ms=0, end_ms=750)
    await store(finality_client, session_id, 1, make_wav(0.75), start_ms=750, end_ms=1500)
    engine = ScriptedWordEngine(
        [[(first_surface, 0.1, 0.3)], [(conflicting_surface, 0.11, 0.31), (" tail", 1.1, 1.3)]]
    )
    monkeypatch.setattr("audiohelper.gateways.asr.load_local_whisper", lambda *_a, **_k: engine)

    assert (await update(finality_client, session_id, 0, 0, 0)).status_code == 200
    conflicting = await update(finality_client, session_id, 0, 1, 1)

    assert conflicting.status_code == 200, conflicting.text
    assert conflicting.json()["draft"]["finality"]["status"] == "stable"
    assert conflicting.json()["draft"]["text"] == f"{conflicting_surface.strip()} tail"
    assert conflicting.json()["draft"]["text_scope"] == "unstable_tail"
    assert conflicting.json()["finalized_segments"] == []


async def test_retry_stale_revision_and_new_epoch_do_not_duplicate_final_prefix(
    finality_client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    await use_local_profile(finality_client)
    session_id = await create_session(finality_client)
    for sequence in range(4):
        await store(
            finality_client,
            session_id,
            sequence,
            make_wav(0.75, frequency=300 + sequence),
            start_ms=sequence * 750,
            end_ms=(sequence + 1) * 750,
        )
    small = ScriptedWordEngine(
        [
            [(' One', 0.1, 0.3), (' two', 0.5, 0.7)],
            [(' One', 0.1, 0.3), (' two', 0.5, 0.7), (' tail', 1.8, 2.0)],
        ]
    )
    base = ScriptedWordEngine(
        [
            [(' One', 0.1, 0.3), (' two', 0.5, 0.7), (' three', 1.1, 1.3)],
            [(' One', 0.1, 0.3), (' two', 0.5, 0.7), (' three', 1.1, 1.3), (' tail', 2.6, 2.8)],
        ]
    )
    engines = {"small": small, "base": base}
    monkeypatch.setattr(
        "audiohelper.gateways.asr.load_local_whisper", lambda model, **_kwargs: engines[model]
    )

    assert (await update(finality_client, session_id, 0, 1, 0)).status_code == 200
    committed = await update(finality_client, session_id, 0, 2, 1)
    assert committed.status_code == 200, committed.text
    repeated = await update(finality_client, session_id, 0, 2, 1)
    assert repeated.json() == committed.json()
    assert small.calls == 2
    stale = await update(finality_client, session_id, 0, 3, 1)
    assert stale.status_code == 409
    assert small.calls == 2

    changed = await finality_client.put(
        "/settings", json={"asr": {"provider": "local-whisper", "model": "base"}}
    )
    assert changed.status_code == 200, changed.text
    new_epoch = await update(finality_client, session_id, 0, 2, 2)
    assert new_epoch.status_code == 200, new_epoch.text
    assert new_epoch.json()["draft"]["epoch"] == 2
    assert new_epoch.json()["finalized_segments"] == []
    advanced = await update(finality_client, session_id, 0, 3, 3)
    assert advanced.status_code == 200, advanced.text
    assert advanced.json()["finalized_segments"][0]["text"] == "three"
    texts = [
        segment["text"]
        for segment in (await finality_client.get(f"/sessions/{session_id}")).json()["segments"]
    ]
    assert texts == ["One two", "three"]


@pytest.mark.parametrize(
    ("words", "reason"),
    [
        (None, "word_timestamps_unavailable"),
        ([(' bad', float('nan'), 0.2)], "invalid_word_timestamps"),
        ([(' later', 0.4, 0.5), (' backwards', 0.2, 0.3)], "invalid_word_timestamps"),
        ([(' outside', 0.1, 2.0)], "invalid_word_timestamps"),
    ],
)
async def test_unsupported_or_invalid_word_evidence_keeps_explicit_draft(
    finality_client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    words: list[Word] | None,
    reason: str,
) -> None:
    await use_local_profile(finality_client)
    session_id = await create_session(finality_client)
    await store(finality_client, session_id, 0, make_wav(0.75), start_ms=0, end_ms=750)
    engine = ScriptedWordEngine([words])
    monkeypatch.setattr("audiohelper.gateways.asr.load_local_whisper", lambda *_a, **_k: engine)

    response = await update(finality_client, session_id, 0, 0, 0)

    assert response.status_code == 200, response.text
    assert response.json()["draft"]["text"]
    assert response.json()["draft"]["finality"]["status"] == "blocked"
    assert response.json()["draft"]["finality"]["blocked_reason"] == reason
    assert response.json()["finalized_segments"] == []
    assert (await finality_client.get(f"/sessions/{session_id}")).json()["segments"] == []


async def test_failed_final_transaction_restores_draft_frontier_fts_and_manifest(
    finality_client: httpx.AsyncClient,
    finality_app: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    await use_local_profile(finality_client)
    session_id = await create_session(finality_client)
    await store(finality_client, session_id, 0, make_wav(0.75), start_ms=0, end_ms=750)
    await store(finality_client, session_id, 1, make_wav(0.75), start_ms=750, end_ms=1500)
    engine = ScriptedWordEngine(
        [[(' Atomic', 0.1, 0.3)], [(' Atomic', 0.1, 0.3), (' tail', 1.0, 1.2)]]
    )
    monkeypatch.setattr("audiohelper.gateways.asr.load_local_whisper", lambda *_a, **_k: engine)
    baseline = await update(finality_client, session_id, 0, 0, 0)
    assert baseline.status_code == 200, baseline.text
    before = (await finality_client.get(f"/sessions/{session_id}/asr/live")).json()
    with finality_app.state.runtime.db.write() as connection:
        connection.execute(
            """
            CREATE TRIGGER fail_finality_source BEFORE INSERT ON segment_sources
            BEGIN SELECT RAISE(FAIL, 'injected transaction failure'); END
            """
        )

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=finality_app, raise_app_exceptions=False),
        base_url="http://127.0.0.1:8765",
        headers={"Authorization": f"Bearer {TOKEN}"},
    ) as failure_client:
        failed = await update(failure_client, session_id, 0, 1, 1)
    assert failed.status_code == 500
    assert (await finality_client.get(f"/sessions/{session_id}/asr/live")).json() == before
    assert (await finality_client.get(f"/sessions/{session_id}")).json()["segments"] == []
    manifest = (await finality_client.get(f"/sessions/{session_id}/audio")).json()["chunks"]
    assert [chunk["segment_ids"] for chunk in manifest] == [[], []]
    with finality_app.state.runtime.db.read() as connection:
        assert connection.execute("SELECT count(*) FROM segments_fts").fetchone()[0] == 0


async def test_changed_window_start_restarts_agreement_before_first_final(
    finality_client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    await use_local_profile(finality_client)
    session_id = await create_session(finality_client)
    for sequence in range(4):
        await store(
            finality_client,
            session_id,
            sequence,
            make_wav(0.5, frequency=400 + sequence),
            start_ms=sequence * 500,
            end_ms=(sequence + 1) * 500,
        )
    engine = ScriptedWordEngine(
        [
            [(' Anchor', 0.1, 0.3)],
            [(' Anchor', 0.1, 0.3)],
            [(' Anchor', 0.11, 0.31), (' tail', 1.2, 1.4)],
        ]
    )
    monkeypatch.setattr("audiohelper.gateways.asr.load_local_whisper", lambda *_a, **_k: engine)

    assert (await update(finality_client, session_id, 0, 1, 0)).status_code == 200
    restarted = await update(finality_client, session_id, 1, 2, 1)
    assert restarted.status_code == 200, restarted.text
    assert restarted.json()["draft"]["finality"]["status"] == "awaiting_agreement"
    assert restarted.json()["finalized_segments"] == []
    advanced = await update(finality_client, session_id, 1, 3, 2)
    assert advanced.status_code == 200, advanced.text
    assert advanced.json()["finalized_segments"][0]["text"] == "Anchor"


@pytest.mark.parametrize("conflict_kind", ["window_start", "lexical"])
async def test_conflict_after_commit_preserves_whole_new_hypothesis_and_old_final(
    finality_client: httpx.AsyncClient,
    finality_app: Any,
    monkeypatch: pytest.MonkeyPatch,
    conflict_kind: str,
) -> None:
    await use_local_profile(finality_client)
    session_id = await create_session(finality_client)
    for sequence in range(4):
        await store(
            finality_client,
            session_id,
            sequence,
            make_wav(0.75, frequency=400 + sequence),
            start_ms=sequence * 750,
            end_ms=(sequence + 1) * 750,
        )
    third = (
        [(" Conflict", 0.1, 0.3), (" new", 0.5, 0.7), (" tail", 1.0, 1.2)]
        if conflict_kind == "lexical"
        else [(" Committed", 0.1, 0.3), (" new", 0.5, 0.7), (" tail", 1.0, 1.2)]
    )
    engine = ScriptedWordEngine(
        [
            [(" Committed", 0.1, 0.3)],
            [(" Committed", 0.11, 0.31), (" old-tail", 1.0, 1.2)],
            third,
        ]
    )
    monkeypatch.setattr("audiohelper.gateways.asr.load_local_whisper", lambda *_a, **_k: engine)

    assert (await update(finality_client, session_id, 0, 0, 0)).status_code == 200
    committed = await update(finality_client, session_id, 0, 1, 1)
    old_final = committed.json()["finalized_segments"][0]
    first_sequence = 1 if conflict_kind == "window_start" else 0
    conflicting = await update(finality_client, session_id, first_sequence, 2, 2)

    assert conflicting.status_code == 200, conflicting.text
    expected_reason = (
        "rollover_after_stable_frontier"
        if conflict_kind == "window_start"
        else "stable_prefix_mismatch"
    )
    assert conflicting.json()["draft"]["finality"]["blocked_reason"] == expected_reason
    assert conflicting.json()["draft"]["text"] == "".join(word[0] for word in third).strip()
    assert conflicting.json()["draft"]["text_scope"] == "whole_window"
    assert conflicting.json()["finalized_segments"] == []
    assert (await finality_client.get(f"/sessions/{session_id}")).json()["segments"] == [old_final]

    restarted = create_app(
        finality_app.state.runtime.config,
        secret_store=MemorySecretStore(),
        http_client=FakeHttp().client(),
    )
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=restarted),
            base_url="http://127.0.0.1:8765",
            headers={"Authorization": f"Bearer {TOKEN}"},
        ) as client:
            restored = await client.get(f"/sessions/{session_id}/asr/live")
            detail = await client.get(f"/sessions/{session_id}")
        assert restored.status_code == detail.status_code == 200
        assert restored.json()["draft"]["text"] == "".join(word[0] for word in third).strip()
        assert restored.json()["draft"]["text_scope"] == "whole_window"
        assert detail.json()["segments"] == [old_final]
    finally:
        restarted.state.runtime.close()


async def test_session_delete_cascades_finality_and_source_associations(
    finality_client: httpx.AsyncClient,
    finality_app: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    await use_local_profile(finality_client)
    session_id = await create_session(finality_client)
    await store(finality_client, session_id, 0, make_wav(0.5), start_ms=0, end_ms=500)
    await store(finality_client, session_id, 1, make_wav(0.5), start_ms=500, end_ms=1000)
    engine = ScriptedWordEngine(
        [[(' Cascade', 0.1, 0.2)], [(' Cascade', 0.1, 0.2), (' tail', 0.8, 0.9)]]
    )
    monkeypatch.setattr("audiohelper.gateways.asr.load_local_whisper", lambda *_a, **_k: engine)
    assert (await update(finality_client, session_id, 0, 0, 0)).status_code == 200
    committed = await update(finality_client, session_id, 0, 1, 1)
    assert committed.status_code == 200, committed.text
    assert committed.json()["finalized_segments"]

    deleted = await finality_client.delete(f"/sessions/{session_id}")

    assert deleted.status_code == 200
    assert (await finality_client.get(f"/sessions/{session_id}")).status_code == 404
    with finality_app.state.runtime.db.read() as connection:
        for table in ("live_asr_drafts", "live_asr_finality", "segments", "segment_sources"):
            assert connection.execute(
                f"SELECT count(*) FROM {table} WHERE session_id=?", (session_id,)
            ).fetchone()[0] == 0


async def test_restart_preserves_frontier_and_exact_retry_does_not_refinalize(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = AppConfig(token=TOKEN, data_dir=tmp_path / "restart", request_timeout_s=5.0)
    object.__setattr__(config, "live_finality_enabled", True)
    object.__setattr__(config, "live_finality_guard_ms", 200)
    engine = ScriptedWordEngine(
        [[(' Restart', 0.1, 0.3)], [(' Restart', 0.1, 0.3), (' tail', 1.0, 1.2)]]
    )
    monkeypatch.setattr("audiohelper.gateways.asr.load_local_whisper", lambda *_a, **_k: engine)
    headers = {"Authorization": f"Bearer {TOKEN}"}
    first_app = create_app(config, secret_store=MemorySecretStore(), http_client=FakeHttp().client())
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=first_app),
        base_url="http://127.0.0.1:8765",
        headers=headers,
    ) as client:
        await use_local_profile(client)
        session_id = await create_session(client)
        await store(client, session_id, 0, make_wav(0.75), start_ms=0, end_ms=750)
        await store(client, session_id, 1, make_wav(0.75), start_ms=750, end_ms=1500)
        assert (await update(client, session_id, 0, 0, 0)).status_code == 200
        committed = await update(client, session_id, 0, 1, 1)
        assert committed.status_code == 200, committed.text
        expected = committed.json()
    await first_app.state.runtime.http.aclose()
    first_app.state.runtime.close()

    second_app = create_app(config, secret_store=MemorySecretStore(), http_client=FakeHttp().client())
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=second_app),
            base_url="http://127.0.0.1:8765",
            headers=headers,
        ) as client:
            restored = await client.get(f"/sessions/{session_id}/asr/live")
            repeated = await update(client, session_id, 0, 1, 1)
            detail = await client.get(f"/sessions/{session_id}")
        assert restored.status_code == repeated.status_code == detail.status_code == 200
        assert repeated.json() == expected
        assert [segment["text"] for segment in detail.json()["segments"]] == ["Restart"]
        assert engine.calls == 2
    finally:
        await second_app.state.runtime.http.aclose()
        second_app.state.runtime.close()


async def test_restart_policy_changes_never_reuse_idempotency_or_duplicate_final(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    data_dir = tmp_path / "policy-restart"
    engine = ScriptedWordEngine(
        [
            [(" Policy", 0.1, 0.3)],
            [(" Policy", 0.11, 0.31), (" tail", 1.0, 1.2)],
            [(" Policy", 0.11, 0.31), (" tail", 1.0, 1.2)],
            [(" Policy", 0.11, 0.31), (" tail", 1.0, 1.2)],
            [(" Policy", 0.11, 0.31), (" tail", 1.0, 1.2)],
        ]
    )
    monkeypatch.setattr("audiohelper.gateways.asr.load_local_whisper", lambda *_a, **_k: engine)
    headers = {"Authorization": f"Bearer {TOKEN}"}

    async def run_app(config: AppConfig, operation: Any) -> Any:
        app = create_app(config, secret_store=MemorySecretStore(), http_client=FakeHttp().client())
        try:
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app),
                base_url="http://127.0.0.1:8765",
                headers=headers,
            ) as client:
                return await operation(client)
        finally:
            await app.state.runtime.http.aclose()
            app.state.runtime.close()

    enabled_200 = AppConfig(
        token=TOKEN, data_dir=data_dir, request_timeout_s=5.0,
        live_finality_enabled=True, live_finality_guard_ms=200,
    )

    async def establish(client: httpx.AsyncClient) -> tuple[str, dict[str, Any]]:
        await use_local_profile(client)
        session_id = await create_session(client)
        await store(client, session_id, 0, make_wav(0.75), start_ms=0, end_ms=750)
        await store(client, session_id, 1, make_wav(0.75), start_ms=750, end_ms=1500)
        assert (await update(client, session_id, 0, 0, 0)).status_code == 200
        committed = await update(client, session_id, 0, 1, 1)
        assert committed.status_code == 200, committed.text
        return session_id, committed.json()["finalized_segments"][0]

    session_id, old_final = await run_app(enabled_200, establish)

    enabled_400 = AppConfig(
        token=TOKEN, data_dir=data_dir, request_timeout_s=5.0,
        live_finality_enabled=True, live_finality_guard_ms=400,
    )

    async def changed_guard(client: httpx.AsyncClient) -> dict[str, Any]:
        historical = await client.get(f"/sessions/{session_id}/asr/live")
        assert historical.status_code == 200, historical.text
        assert historical.json()["resume_compatibility"]["status"] == "config_changed"
        assert historical.json()["resume_compatibility"]["requires_redecode"] is True
        refreshed = await update(client, session_id, 0, 1, 2)
        assert refreshed.status_code == 200, refreshed.text
        return cast(dict[str, Any], refreshed.json())

    guard_result = await run_app(enabled_400, changed_guard)
    assert guard_result["draft"]["epoch"] == 2
    assert guard_result["draft"]["finality"]["status"] == "awaiting_agreement"
    assert guard_result["finalized_segments"] == []
    assert engine.calls == 3

    disabled = AppConfig(token=TOKEN, data_dir=data_dir, request_timeout_s=5.0)

    async def turn_off(client: httpx.AsyncClient) -> dict[str, Any]:
        historical = await client.get(f"/sessions/{session_id}/asr/live")
        assert historical.status_code == 200, historical.text
        assert historical.json()["resume_compatibility"]["status"] == "config_changed"
        refreshed = await update(client, session_id, 0, 1, 3)
        assert refreshed.status_code == 200, refreshed.text
        repeated = await update(client, session_id, 0, 1, 3)
        assert repeated.json() == refreshed.json()
        detail = await client.get(f"/sessions/{session_id}")
        assert detail.json()["segments"] == [old_final]
        return cast(dict[str, Any], refreshed.json())

    disabled_result = await run_app(disabled, turn_off)
    assert disabled_result["draft"]["epoch"] == 3
    assert "finality" not in disabled_result["draft"]
    assert "text_scope" not in disabled_result["draft"]
    assert "finalized_segments" not in disabled_result
    assert engine.calls == 4

    async def turn_on(client: httpx.AsyncClient) -> dict[str, Any]:
        historical = await client.get(f"/sessions/{session_id}/asr/live")
        assert historical.status_code == 200, historical.text
        assert historical.json()["resume_compatibility"]["status"] == "config_changed"
        refreshed = await update(client, session_id, 0, 1, 4)
        assert refreshed.status_code == 200, refreshed.text
        assert (await client.get(f"/sessions/{session_id}")).json()["segments"] == [old_final]
        return cast(dict[str, Any], refreshed.json())

    reenabled_result = await run_app(enabled_400, turn_on)
    assert reenabled_result["draft"]["epoch"] == 4
    assert reenabled_result["draft"]["finality"]["status"] == "awaiting_agreement"
    assert reenabled_result["finalized_segments"] == []
    assert engine.calls == 5


def test_finality_schema_migration_adds_bounded_rollover_metadata(tmp_path: Path) -> None:
    path = tmp_path / "legacy-finality.sqlite3"
    connection = sqlite3.connect(path)
    connection.execute(
        """
        CREATE TABLE sessions (
            id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL,
            status TEXT NOT NULL, duration_ms INTEGER NOT NULL DEFAULT 0
        )
        """
    )
    connection.execute(
        """
        CREATE TABLE live_asr_finality (
            session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
            stable_text TEXT NOT NULL DEFAULT '',
            stable_tokens_json TEXT NOT NULL DEFAULT '[]',
            stable_frontier_ms INTEGER NOT NULL DEFAULT 0,
            agreement_epoch INTEGER NOT NULL,
            previous_window_start_ms INTEGER,
            previous_window_end_ms INTEGER,
            previous_words_json TEXT NOT NULL DEFAULT '[]',
            last_revision INTEGER NOT NULL DEFAULT 0,
            last_segment_ids_json TEXT NOT NULL DEFAULT '[]',
            updated_at TEXT NOT NULL
        )
        """
    )
    connection.execute(
        "INSERT INTO sessions VALUES ('kept', 'Legacy', 'now', 'recording', 0)"
    )
    connection.execute(
        """
        INSERT INTO live_asr_finality VALUES (
            'kept', 'old words', '["old","words"]', 900, 1,
            0, 1000, '[]', 2, '[]', 'now'
        )
        """
    )
    connection.commit()
    connection.close()

    for _ in range(2):
        database = Database(path)
        with database.read() as migrated:
            row = migrated.execute(
                "SELECT active_anchor_ms, stable_token_offset FROM live_asr_finality "
                "WHERE session_id='kept'"
            ).fetchone()
            assert tuple(row) == (0, 0)
        database.close()


async def test_rollover_crosses_thirty_seconds_without_reinserting_overlap(
    finality_client: httpx.AsyncClient,
    finality_app: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    await use_local_profile(finality_client)
    session_id = await create_session(finality_client)
    for sequence in range(8):
        await store(
            finality_client,
            session_id,
            sequence,
            make_wav(5.0, frequency=240 + sequence),
            start_ms=sequence * 5_000,
            end_ms=(sequence + 1) * 5_000,
        )
    engine = ScriptedWordEngine(
        [
            [(" Old", 4.0, 4.5), (" go", 10.5, 11.0), (" go", 12.0, 12.5), (" bridge", 14.0, 14.5)],
            [
                (" Old", 4.01, 4.51),
                (" go", 10.51, 11.01),
                (" go", 12.01, 12.51),
                (" bridge", 14.01, 14.51),
                (" future", 20.0, 20.5),
            ],
            [
                (" go", 0.5, 1.0),
                (" go", 2.0, 2.5),
                (" bridge", 4.0, 4.5),
                (" future", 10.0, 10.5),
                (" beyond", 21.0, 21.5),
                (" edge", 24.4, 24.7),
            ],
            [
                (" go", 0.51, 1.01),
                (" go", 2.01, 2.51),
                (" bridge", 4.01, 4.51),
                (" future", 10.01, 10.51),
                (" beyond", 21.01, 21.51),
                (" tail", 29.4, 29.7),
            ],
        ]
    )
    monkeypatch.setattr("audiohelper.gateways.asr.load_local_whisper", lambda *_a, **_k: engine)

    first = await update(finality_client, session_id, 0, 2, 0)
    committed = await update(finality_client, session_id, 0, 4, 1)
    rollover = await update(finality_client, session_id, 2, 6, 2)
    repeated = await update(finality_client, session_id, 2, 6, 2)
    progressed = await update(finality_client, session_id, 2, 7, 3)

    assert first.status_code == committed.status_code == rollover.status_code == 200
    assert repeated.json() == rollover.json()
    assert engine.calls == 4
    old_final = committed.json()["finalized_segments"][0]
    assert old_final["text"] == "Old go go bridge"
    assert rollover.json()["draft"]["finality"] == {
        "enabled": True,
        "status": "awaiting_agreement",
        "stable_frontier_ms": 14_510,
        "active_anchor_ms": 10_000,
        "stable_token_offset": 1,
    }
    assert rollover.json()["draft"]["text"] == "future beyond edge"
    assert progressed.status_code == 200, progressed.text
    new_final = progressed.json()["finalized_segments"][0]
    assert new_final["text"] == "future beyond"
    assert new_final["end_ms"] == 31_510
    assert [source["sequence"] for source in new_final["sources"]] == [4, 5, 6]
    detail = (await finality_client.get(f"/sessions/{session_id}")).json()
    assert [segment["id"] for segment in detail["segments"]] == [old_final["id"], new_final["id"]]
    assert [segment["text"] for segment in detail["segments"]] == [
        "Old go go bridge",
        "future beyond",
    ]
    with finality_app.state.runtime.db.read() as connection:
        assert connection.execute("SELECT count(*) FROM segments_fts").fetchone()[0] == 2
        state = connection.execute(
            "SELECT stable_tokens_json, stable_token_offset FROM live_asr_finality "
            "WHERE session_id=?",
            (session_id,),
        ).fetchone()
    assert state[0] == '["go","go","bridge","future","beyond"]'
    assert state[1] == 1


async def test_rollover_rejects_ambiguous_midword_chunk_boundary_with_whole_draft(
    finality_client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    await use_local_profile(finality_client)
    session_id = await create_session(finality_client)
    for sequence in range(5):
        await store(
            finality_client,
            session_id,
            sequence,
            make_wav(5.0, frequency=320 + sequence),
            start_ms=sequence * 5_000,
            end_ms=(sequence + 1) * 5_000,
        )
    engine = ScriptedWordEngine(
        [
            [(" Split", 9.8, 10.3)],
            [(" Split", 9.81, 10.31), (" old-tail", 19.0, 19.5)],
            [(" Different", 0.0, 0.3), (" retained", 5.0, 5.5)],
        ]
    )
    monkeypatch.setattr("audiohelper.gateways.asr.load_local_whisper", lambda *_a, **_k: engine)

    assert (await update(finality_client, session_id, 0, 2, 0)).status_code == 200
    committed = await update(finality_client, session_id, 0, 3, 1)
    old_final = committed.json()["finalized_segments"][0]
    blocked = await update(finality_client, session_id, 2, 4, 2)

    assert blocked.status_code == 200, blocked.text
    assert blocked.json()["draft"]["finality"]["blocked_reason"] == (
        "rollover_word_boundary_ambiguous"
    )
    assert blocked.json()["draft"]["text_scope"] == "whole_window"
    assert blocked.json()["draft"]["text"] == "Different retained"
    assert blocked.json()["finalized_segments"] == []
    assert (await finality_client.get(f"/sessions/{session_id}")).json()["segments"] == [old_final]


async def test_rollover_without_trustworthy_overlap_is_blocked(
    finality_client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    await use_local_profile(finality_client)
    session_id = await create_session(finality_client)
    for sequence in range(5):
        await store(
            finality_client,
            session_id,
            sequence,
            make_wav(5.0, frequency=360 + sequence),
            start_ms=sequence * 5_000,
            end_ms=(sequence + 1) * 5_000,
        )
    engine = ScriptedWordEngine(
        [
            [(" Overlap", 12.0, 12.5)],
            [(" Overlap", 12.01, 12.51), (" old-tail", 19.0, 19.5)],
            [(" Different", 0.1, 0.4), (" retained", 5.0, 5.5)],
        ]
    )
    monkeypatch.setattr("audiohelper.gateways.asr.load_local_whisper", lambda *_a, **_k: engine)

    assert (await update(finality_client, session_id, 0, 2, 0)).status_code == 200
    assert (await update(finality_client, session_id, 0, 3, 1)).status_code == 200
    blocked = await update(finality_client, session_id, 2, 4, 2)

    assert blocked.status_code == 200, blocked.text
    assert blocked.json()["draft"]["finality"]["blocked_reason"] == (
        "rollover_overlap_unverified"
    )
    assert blocked.json()["draft"]["text_scope"] == "whole_window"
    assert blocked.json()["draft"]["text"] == "Different retained"
    assert blocked.json()["finalized_segments"] == []


async def test_rollover_after_frontier_is_blocked_and_survives_restart(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = AppConfig(
        token=TOKEN,
        data_dir=tmp_path / "rollover-restart",
        request_timeout_s=5.0,
        live_finality_enabled=True,
        live_finality_guard_ms=200,
    )
    engine = ScriptedWordEngine(
        [
            [(" Kept", 4.0, 4.5)],
            [(" Kept", 4.01, 4.51), (" tail", 9.0, 9.5)],
            [(" Whole", 0.2, 0.5), (" conflict", 1.0, 1.5)],
        ]
    )
    monkeypatch.setattr("audiohelper.gateways.asr.load_local_whisper", lambda *_a, **_k: engine)
    headers = {"Authorization": f"Bearer {TOKEN}"}
    first_app = create_app(config, secret_store=MemorySecretStore(), http_client=FakeHttp().client())
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=first_app),
        base_url="http://127.0.0.1:8765",
        headers=headers,
    ) as client:
        await use_local_profile(client)
        session_id = await create_session(client)
        for sequence in range(4):
            await store(
                client,
                session_id,
                sequence,
                make_wav(5.0, frequency=400 + sequence),
                start_ms=sequence * 5_000,
                end_ms=(sequence + 1) * 5_000,
            )
        assert (await update(client, session_id, 0, 1, 0)).status_code == 200
        committed = await update(client, session_id, 0, 2, 1)
        old_final = committed.json()["finalized_segments"][0]
        blocked = await update(client, session_id, 1, 3, 2)
        assert blocked.json()["draft"]["finality"]["blocked_reason"] == (
            "rollover_after_stable_frontier"
        )
        assert blocked.json()["draft"]["text_scope"] == "whole_window"
        expected = blocked.json()
    await first_app.state.runtime.http.aclose()
    first_app.state.runtime.close()

    second_app = create_app(config, secret_store=MemorySecretStore(), http_client=FakeHttp().client())
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=second_app),
            base_url="http://127.0.0.1:8765",
            headers=headers,
        ) as client:
            restored = await client.get(f"/sessions/{session_id}/asr/live")
            detail = await client.get(f"/sessions/{session_id}")
        assert restored.status_code == 200
        assert restored.json()["draft"] == expected["draft"]
        assert detail.json()["segments"] == [old_final]
    finally:
        await second_app.state.runtime.http.aclose()
        second_app.state.runtime.close()


async def test_unambiguous_split_word_rollover_restores_and_advances_after_restart(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = AppConfig(
        token=TOKEN,
        data_dir=tmp_path / "split-rollover-restart",
        request_timeout_s=5.0,
        live_finality_enabled=True,
        live_finality_guard_ms=200,
    )
    engine = ScriptedWordEngine(
        [
            [(" Split", 9.8, 10.3)],
            [(" Split", 9.81, 10.31), (" old-tail", 19.0, 19.5)],
            [(" Split", 0.0, 0.31), (" future", 5.0, 5.5), (" tail", 14.4, 14.7)],
            [
                (" Split", 0.01, 0.32),
                (" future", 5.01, 5.51),
                (" tail", 14.41, 14.71),
                (" later", 19.4, 19.7),
            ],
        ]
    )
    monkeypatch.setattr("audiohelper.gateways.asr.load_local_whisper", lambda *_a, **_k: engine)
    headers = {"Authorization": f"Bearer {TOKEN}"}
    first_app = create_app(config, secret_store=MemorySecretStore(), http_client=FakeHttp().client())
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=first_app),
        base_url="http://127.0.0.1:8765",
        headers=headers,
    ) as client:
        await use_local_profile(client)
        session_id = await create_session(client)
        for sequence in range(6):
            await store(
                client,
                session_id,
                sequence,
                make_wav(5.0, frequency=500 + sequence),
                start_ms=sequence * 5_000,
                end_ms=(sequence + 1) * 5_000,
            )
        assert (await update(client, session_id, 0, 2, 0)).status_code == 200
        committed = await update(client, session_id, 0, 3, 1)
        old_final = committed.json()["finalized_segments"][0]
        rollover = await update(client, session_id, 2, 4, 2)
        assert rollover.status_code == 200, rollover.text
        assert rollover.json()["draft"]["finality"]["status"] == "awaiting_agreement"
        assert rollover.json()["draft"]["finality"]["active_anchor_ms"] == 10_000
        assert rollover.json()["draft"]["text"] == "future tail"
    await first_app.state.runtime.http.aclose()
    first_app.state.runtime.close()

    second_app = create_app(config, secret_store=MemorySecretStore(), http_client=FakeHttp().client())
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=second_app),
            base_url="http://127.0.0.1:8765",
            headers=headers,
        ) as client:
            restored = await client.get(f"/sessions/{session_id}/asr/live")
            progressed = await update(client, session_id, 2, 5, 3)
            detail = await client.get(f"/sessions/{session_id}")
        assert restored.status_code == progressed.status_code == 200
        assert restored.json()["draft"] == rollover.json()["draft"]
        new_final = progressed.json()["finalized_segments"][0]
        assert new_final["text"] == "future tail"
        assert [segment["id"] for segment in detail.json()["segments"]] == [
            old_final["id"],
            new_final["id"],
        ]
        assert [segment["text"] for segment in detail.json()["segments"]] == [
            "Split",
            "future tail",
        ]
    finally:
        await second_app.state.runtime.http.aclose()
        second_app.state.runtime.close()
