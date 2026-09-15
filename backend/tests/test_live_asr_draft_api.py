from __future__ import annotations

import asyncio
import hashlib
import sqlite3
import threading
from collections.abc import Iterator
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx
import numpy as np
import pytest

from audiohelper.app import create_app
from audiohelper.config import AppConfig
from audiohelper.db import Database
from audiohelper.gateways.asr import LocalWhisperTranscriber
from audiohelper.secrets import MemorySecretStore
from tests.conftest import TOKEN, FakeHttp, make_wav


class RecordingEngine:
    def __init__(self, text: str = "durable draft", language: str = "ru") -> None:
        self.text = text
        self.language = language
        self.calls = 0

    def transcribe(
        self, samples: np.ndarray[Any, Any], *, language: str | None, vad_filter: bool
    ) -> tuple[list[Any], Any]:
        assert vad_filter is False
        self.calls += 1
        piece = SimpleNamespace(start=0.0, end=len(samples) / 16_000, text=self.text)
        return [piece], SimpleNamespace(language=self.language)


@pytest.fixture(autouse=True)
def clear_local_model_cache() -> Iterator[None]:
    LocalWhisperTranscriber._models.clear()
    yield
    LocalWhisperTranscriber._models.clear()


async def create_session(client: httpx.AsyncClient, title: str = "Live draft") -> str:
    response = await client.post("/sessions", json={"title": title})
    assert response.status_code == 200, response.text
    return str(response.json()["id"])


async def use_local_profile(
    client: httpx.AsyncClient, *, model: str = "small", language: str = "ru"
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


def test_schema_migration_is_additive_idempotent_and_preserves_old_sessions(tmp_path: Path) -> None:
    path = tmp_path / "legacy.sqlite3"
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
        "INSERT INTO sessions VALUES ('kept', 'Legacy', '2026-01-01T00:00:00Z', 'stopped', 7)"
    )
    connection.commit()
    connection.close()

    for _ in range(2):
        database = Database(path)
        with database.read() as migrated:
            assert migrated.execute("SELECT title FROM sessions WHERE id='kept'").fetchone()[0] == "Legacy"
            tables = {
                row[0]
                for row in migrated.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                ).fetchall()
            }
            assert {"live_asr_drafts", "settings_revisions"} <= tables
        database.close()


async def test_get_returns_none_and_live_routes_require_auth(
    client: httpx.AsyncClient, app: Any
) -> None:
    session_id = await create_session(client)
    response = await client.get(f"/sessions/{session_id}/asr/live")
    assert response.status_code == 200
    assert response.json() == {"draft": None}

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8765"
    ) as anonymous:
        read = await anonymous.get(f"/sessions/{session_id}/asr/live")
        update = await anonymous.post(
            f"/sessions/{session_id}/asr/live/update",
            json={"first_sequence": 0, "last_sequence": 0, "expected_revision": 0},
        )
    assert read.status_code == 401
    assert update.status_code == 401
    assert TOKEN not in read.text + update.text


async def test_update_persists_bounded_provenance_and_replay_is_idempotent(
    client: httpx.AsyncClient,
    app: Any,
    monkeypatch: pytest.MonkeyPatch,
    config: AppConfig,
) -> None:
    await use_local_profile(client)
    session_id = await create_session(client)
    first = make_wav(0.5, frequency=220)
    second = make_wav(0.5, frequency=440)
    await store(client, session_id, 4, first, start_ms=0, end_ms=500)
    await store(client, session_id, 9, second, start_ms=500, end_ms=1000)
    engine = RecordingEngine("единый долговечный черновик")
    monkeypatch.setattr("audiohelper.gateways.asr.load_local_whisper", lambda *_a, **_k: engine)
    payload = {"first_sequence": 4, "last_sequence": 9, "expected_revision": 0}

    created = await client.post(f"/sessions/{session_id}/asr/live/update", json=payload)
    repeated = await client.post(f"/sessions/{session_id}/asr/live/update", json=payload)

    assert created.status_code == 200, created.text
    assert repeated.status_code == 200, repeated.text
    assert repeated.json() == created.json()
    assert engine.calls == 1
    draft = created.json()["draft"]
    assert draft["state"] == "draft"
    assert draft["revision"] == 1
    assert draft["epoch"] == 1
    assert draft["text"] == "единый долговечный черновик"
    assert draft["provider"] == "local-whisper"
    assert draft["model"] == "small"
    assert draft["requested_language"] == "ru"
    assert len(draft["source_fingerprint"]) == 64
    assert len(draft["config_fingerprint"]) == 64
    assert [source["sequence"] for source in draft["sources"]] == [4, 9]
    assert draft["sources"][0]["sha256"] == hashlib.sha256(first).hexdigest()
    assert draft["sources"][1]["sha256"] == hashlib.sha256(second).hexdigest()
    assert (await client.get(f"/sessions/{session_id}/asr/live")).json() == created.json()
    engine.text = "manual preview remains transient"
    manual = await client.post(
        f"/sessions/{session_id}/asr/preview",
        json={"first_sequence": 4, "last_sequence": 9},
    )
    assert manual.status_code == 200, manual.text
    assert manual.json()["text"] == "manual preview remains transient"
    assert (await client.get(f"/sessions/{session_id}/asr/live")).json() == created.json()
    assert (config.audio_dir / session_id / "000004.wav").read_bytes() == first
    assert (config.audio_dir / session_id / "000009.wav").read_bytes() == second
    detail = (await client.get(f"/sessions/{session_id}")).json()
    assert detail["segments"] == []
    with app.state.runtime.db.read() as connection:
        assert connection.execute("SELECT count(*) FROM segments").fetchone()[0] == 0
        assert connection.execute("SELECT count(*) FROM segments_fts").fetchone()[0] == 0
        assert connection.execute("SELECT count(*) FROM notes").fetchone()[0] == 0
        assert connection.execute("SELECT count(*) FROM verifications").fetchone()[0] == 0
        rows = connection.execute(
            "SELECT status FROM chunks WHERE session_id=? ORDER BY sequence", (session_id,)
        ).fetchall()
        assert [row["status"] for row in rows] == ["pending", "pending"]


async def test_changed_payload_with_stale_revision_conflicts_without_decode(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    await use_local_profile(client)
    session_id = await create_session(client)
    body = make_wav(0.5)
    await store(client, session_id, 0, body, start_ms=0, end_ms=500)
    await store(client, session_id, 1, body, start_ms=500, end_ms=1000)
    engine = RecordingEngine()
    monkeypatch.setattr("audiohelper.gateways.asr.load_local_whisper", lambda *_a, **_k: engine)
    first = await client.post(
        f"/sessions/{session_id}/asr/live/update",
        json={"first_sequence": 0, "last_sequence": 0, "expected_revision": 0},
    )
    assert first.status_code == 200, first.text

    conflict = await client.post(
        f"/sessions/{session_id}/asr/live/update",
        json={"first_sequence": 0, "last_sequence": 1, "expected_revision": 0},
    )
    assert conflict.status_code == 409, conflict.text
    assert engine.calls == 1


async def test_current_revision_can_replace_range_without_advancing_epoch(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    await use_local_profile(client)
    session_id = await create_session(client)
    body = make_wav(0.5)
    await store(client, session_id, 0, body, start_ms=0, end_ms=500)
    await store(client, session_id, 1, body, start_ms=500, end_ms=1000)
    engine = RecordingEngine()
    monkeypatch.setattr("audiohelper.gateways.asr.load_local_whisper", lambda *_a, **_k: engine)
    first = await client.post(
        f"/sessions/{session_id}/asr/live/update",
        json={"first_sequence": 0, "last_sequence": 0, "expected_revision": 0},
    )
    assert first.status_code == 200, first.text

    second = await client.post(
        f"/sessions/{session_id}/asr/live/update",
        json={"first_sequence": 0, "last_sequence": 1, "expected_revision": 1},
    )
    assert second.status_code == 200, second.text
    assert second.json()["draft"]["revision"] == 2
    assert second.json()["draft"]["epoch"] == 1
    assert [source["sequence"] for source in second.json()["draft"]["sources"]] == [0, 1]
    assert engine.calls == 2


@pytest.mark.parametrize("damage", ["missing", "hash"])
async def test_untrusted_saved_sources_invalidate_read_and_update_before_decode(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    config: AppConfig,
    damage: str,
) -> None:
    await use_local_profile(client)
    session_id = await create_session(client)
    body = make_wav(0.5)
    await store(client, session_id, 0, body, start_ms=0, end_ms=500)
    engine = RecordingEngine()
    monkeypatch.setattr("audiohelper.gateways.asr.load_local_whisper", lambda *_a, **_k: engine)
    created = await client.post(
        f"/sessions/{session_id}/asr/live/update",
        json={"first_sequence": 0, "last_sequence": 0, "expected_revision": 0},
    )
    assert created.status_code == 200, created.text
    path = config.audio_dir / session_id / "000000.wav"
    if damage == "missing":
        path.unlink()
    else:
        path.write_bytes(make_wav(0.5, frequency=880))

    read = await client.get(f"/sessions/{session_id}/asr/live")
    update = await client.post(
        f"/sessions/{session_id}/asr/live/update",
        json={"first_sequence": 0, "last_sequence": 0, "expected_revision": 1},
    )
    assert read.status_code == 200, read.text
    restored = read.json()
    assert restored["draft"]["text"] == created.json()["draft"]["text"]
    assert restored["source_integrity"] == {
        "status": "missing" if damage == "missing" else "corrupt",
        "trusted": False,
        "detail": (
            "Saved draft source audio is missing."
            if damage == "missing"
            else "Saved draft source audio failed integrity validation."
        ),
    }
    assert restored["resume_compatibility"] == {
        "status": "source_unavailable",
        "can_resume": False,
        "requires_redecode": False,
        "detail": "Trusted source audio is required before this historical draft can resume.",
    }
    assert update.status_code in (404, 409), update.text
    assert engine.calls == 1


async def test_profile_change_during_decode_rejects_stale_completion_and_advances_epoch(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    await use_local_profile(client, model="small")
    session_id = await create_session(client)
    await store(client, session_id, 0, make_wav(0.5), start_ms=0, end_ms=500)
    await store(client, session_id, 1, make_wav(0.5), start_ms=500, end_ms=1000)
    entered = threading.Event()
    release = threading.Event()

    class BlockingOnSecondEngine(RecordingEngine):
        def transcribe(self, *args: Any, **kwargs: Any) -> tuple[list[Any], Any]:
            if self.calls == 1:
                entered.set()
                release.wait(timeout=5)
            return super().transcribe(*args, **kwargs)

    engines = {"small": BlockingOnSecondEngine("small"), "base": RecordingEngine("fresh")}
    monkeypatch.setattr(
        "audiohelper.gateways.asr.load_local_whisper", lambda model, **_kwargs: engines[model]
    )
    initial = await client.post(
        f"/sessions/{session_id}/asr/live/update",
        json={"first_sequence": 0, "last_sequence": 0, "expected_revision": 0},
    )
    assert initial.status_code == 200, initial.text
    request = asyncio.create_task(
        client.post(
            f"/sessions/{session_id}/asr/live/update",
            json={"first_sequence": 0, "last_sequence": 1, "expected_revision": 1},
        )
    )
    await asyncio.wait_for(asyncio.to_thread(entered.wait), timeout=1)
    changed = await client.put(
        "/settings", json={"asr": {"provider": "local-whisper", "model": "base"}}
    )
    assert changed.status_code == 200, changed.text
    release.set()
    stale = await request
    assert stale.status_code == 409, stale.text
    saved = await client.get(f"/sessions/{session_id}/asr/live")
    assert saved.status_code == 200, saved.text
    assert saved.json()["draft"]["text"] == "small"
    assert saved.json()["resume_compatibility"] == {
        "status": "config_changed",
        "can_resume": True,
        "requires_redecode": True,
        "detail": "Current ASR settings differ; explicit resume will re-decode trusted source audio.",
    }

    fresh = await client.post(
        f"/sessions/{session_id}/asr/live/update",
        json={"first_sequence": 0, "last_sequence": 1, "expected_revision": 1},
    )
    assert fresh.status_code == 200, fresh.text
    assert fresh.json()["draft"]["epoch"] == 2
    assert fresh.json()["draft"]["revision"] == 2
    assert fresh.json()["draft"]["model"] == "base"


async def test_change_then_change_back_still_invalidates_old_config_generation(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    await use_local_profile(client, model="small")
    session_id = await create_session(client)
    await store(client, session_id, 0, make_wav(0.5), start_ms=0, end_ms=500)
    engine = RecordingEngine()
    monkeypatch.setattr("audiohelper.gateways.asr.load_local_whisper", lambda *_a, **_k: engine)
    first = await client.post(
        f"/sessions/{session_id}/asr/live/update",
        json={"first_sequence": 0, "last_sequence": 0, "expected_revision": 0},
    )
    assert first.status_code == 200, first.text
    for model in ("base", "small"):
        changed = await client.put(
            "/settings", json={"asr": {"provider": "local-whisper", "model": model}}
        )
        assert changed.status_code == 200, changed.text

    saved = await client.get(f"/sessions/{session_id}/asr/live")
    assert saved.status_code == 200, saved.text
    assert saved.json()["resume_compatibility"]["status"] == "config_changed"
    assert saved.json()["resume_compatibility"]["requires_redecode"] is True
    refreshed = await client.post(
        f"/sessions/{session_id}/asr/live/update",
        json={"first_sequence": 0, "last_sequence": 0, "expected_revision": 1},
    )
    assert refreshed.status_code == 200, refreshed.text
    assert refreshed.json()["draft"]["revision"] == 2
    assert refreshed.json()["draft"]["epoch"] == 2
    assert engine.calls == 2


async def test_delete_during_decode_returns_404_and_cannot_resurrect_draft(
    client: httpx.AsyncClient, app: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    await use_local_profile(client)
    session_id = await create_session(client)
    await store(client, session_id, 0, make_wav(0.5), start_ms=0, end_ms=500)
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
            f"/sessions/{session_id}/asr/live/update",
            json={"first_sequence": 0, "last_sequence": 0, "expected_revision": 0},
        )
    )
    await asyncio.wait_for(asyncio.to_thread(entered.wait), timeout=1)
    assert (await client.delete(f"/sessions/{session_id}")).status_code == 200
    release.set()
    result = await task
    assert result.status_code == 404, result.text
    with app.state.runtime.db.read() as connection:
        assert connection.execute(
            "SELECT count(*) FROM live_asr_drafts WHERE session_id=?", (session_id,)
        ).fetchone()[0] == 0


async def test_live_update_busy_and_cancellation_keep_decoder_slot_bounded(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    await use_local_profile(client)
    session_id = await create_session(client)
    await store(client, session_id, 0, make_wav(0.5), start_ms=0, end_ms=500)
    entered = threading.Event()
    release = threading.Event()

    class BlockingEngine(RecordingEngine):
        def transcribe(self, *args: Any, **kwargs: Any) -> tuple[list[Any], Any]:
            entered.set()
            release.wait(timeout=5)
            return super().transcribe(*args, **kwargs)

    engine = BlockingEngine()
    monkeypatch.setattr("audiohelper.gateways.asr.load_local_whisper", lambda *_a, **_k: engine)
    payload = {"first_sequence": 0, "last_sequence": 0, "expected_revision": 0}
    first = asyncio.create_task(client.post(f"/sessions/{session_id}/asr/live/update", json=payload))
    await asyncio.wait_for(asyncio.to_thread(entered.wait), timeout=1)
    busy = await client.post(f"/sessions/{session_id}/asr/live/update", json=payload)
    assert busy.status_code == 429, busy.text
    first.cancel()
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await first

    recovered = await client.post(f"/sessions/{session_id}/asr/live/update", json=payload)
    assert recovered.status_code == 200, recovered.text
    assert engine.calls == 2


async def test_draft_text_bound_rejects_result_without_persistence(
    client: httpx.AsyncClient, app: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    await use_local_profile(client)
    session_id = await create_session(client)
    await store(client, session_id, 0, make_wav(0.5), start_ms=0, end_ms=500)
    object.__setattr__(app.state.runtime.config, "max_live_draft_chars", 8)
    monkeypatch.setattr(
        "audiohelper.gateways.asr.load_local_whisper", lambda *_a, **_k: RecordingEngine("too long text")
    )
    response = await client.post(
        f"/sessions/{session_id}/asr/live/update",
        json={"first_sequence": 0, "last_sequence": 0, "expected_revision": 0},
    )
    assert response.status_code == 413, response.text
    assert (await client.get(f"/sessions/{session_id}/asr/live")).json() == {"draft": None}


async def test_draft_survives_backend_restart_with_identical_source_refs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = AppConfig(token=TOKEN, data_dir=tmp_path / "data", request_timeout_s=5.0)
    engine = RecordingEngine("restart draft")
    monkeypatch.setattr("audiohelper.gateways.asr.load_local_whisper", lambda *_a, **_k: engine)
    first_app = create_app(
        config, secret_store=MemorySecretStore(), http_client=FakeHttp().client()
    )
    headers = {"Authorization": f"Bearer {TOKEN}"}
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=first_app),
        base_url="http://127.0.0.1:8765",
        headers=headers,
    ) as first_client:
        await use_local_profile(first_client)
        session_id = await create_session(first_client)
        await store(first_client, session_id, 0, make_wav(0.5), start_ms=0, end_ms=500)
        created = await first_client.post(
            f"/sessions/{session_id}/asr/live/update",
            json={"first_sequence": 0, "last_sequence": 0, "expected_revision": 0},
        )
        assert created.status_code == 200, created.text
        expected = created.json()
    await first_app.state.runtime.http.aclose()
    first_app.state.runtime.close()

    second_app = create_app(
        config, secret_store=MemorySecretStore(), http_client=FakeHttp().client()
    )
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=second_app),
            base_url="http://127.0.0.1:8765",
            headers=headers,
        ) as second_client:
            restored = await second_client.get(f"/sessions/{session_id}/asr/live")
        assert restored.status_code == 200, restored.text
        assert restored.json() == expected
        assert engine.calls == 1
    finally:
        await second_app.state.runtime.http.aclose()
        second_app.state.runtime.close()


async def test_saved_draft_remains_readable_after_asr_configuration_changes(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Reopening must not hide already persisted work behind the current config."""
    await use_local_profile(client)
    session_id = await create_session(client)
    await store(client, session_id, 0, make_wav(0.5), start_ms=0, end_ms=500)
    monkeypatch.setattr(
        "audiohelper.gateways.asr.load_local_whisper",
        lambda *_a, **_k: RecordingEngine("persisted before config change"),
    )
    created = await client.post(
        f"/sessions/{session_id}/asr/live/update",
        json={"first_sequence": 0, "last_sequence": 0, "expected_revision": 0},
    )
    assert created.status_code == 200, created.text

    changed = await client.put("/settings", json={"transcript_language": "en"})
    assert changed.status_code == 200, changed.text
    restored = await client.get(f"/sessions/{session_id}/asr/live")

    assert restored.status_code == 200, restored.text
    assert restored.json()["draft"]["text"] == "persisted before config change"
    assert restored.json()["source_integrity"] == {
        "status": "verified",
        "trusted": True,
    }
    assert restored.json()["resume_compatibility"] == {
        "status": "config_changed",
        "can_resume": True,
        "requires_redecode": True,
        "detail": "Current ASR settings differ; explicit resume will re-decode trusted source audio.",
    }
