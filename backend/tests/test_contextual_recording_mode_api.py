from __future__ import annotations

import sqlite3
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import httpx

from audiohelper import repository as repo
from audiohelper.db import Database
from audiohelper.schemas import Segment
from tests.conftest import make_wav


async def test_session_mode_is_additive_explicit_and_defaults_legacy(
    client: httpx.AsyncClient, app: Any
) -> None:
    legacy = await client.post("/sessions", json={"title": "old client"})
    contextual = await client.post(
        "/sessions", json={"title": "local context", "mode": "contextual_local"}
    )

    assert legacy.status_code == 200
    assert legacy.json()["mode"] == "legacy"
    assert contextual.status_code == 200
    assert contextual.json()["mode"] == "contextual_local"
    persisted = repo.get_session(app.state.runtime.db, contextual.json()["id"])
    assert persisted is not None and persisted.mode == "contextual_local"


def test_contextual_mode_survives_database_restart(tmp_path: Path) -> None:
    path = tmp_path / "restart.sqlite3"
    first = Database(path)
    created = repo.create_session(first, "context", mode="contextual_local")
    first.close()
    reopened = Database(path)
    try:
        restored = repo.get_session(reopened, created.id)
        assert restored is not None and restored.mode == "contextual_local"
    finally:
        reopened.close()


def test_existing_session_rows_migrate_to_legacy_without_rewrite(tmp_path: Path) -> None:
    path = tmp_path / "old.sqlite3"
    connection = sqlite3.connect(path)
    connection.execute(
        "CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, "
        "created_at TEXT NOT NULL, status TEXT NOT NULL, duration_ms INTEGER NOT NULL DEFAULT 0)"
    )
    connection.execute(
        "INSERT INTO sessions VALUES ('old', 'Old', 'now', 'stopped', 12)"
    )
    connection.commit()
    connection.close()
    migrated = Database(path)
    try:
        restored = repo.get_session(migrated, "old")
        assert restored is not None and restored.mode == "legacy"
    finally:
        migrated.close()


async def test_capability_is_read_only_off_by_default_and_uses_only_profile_and_flags(
    client: httpx.AsyncClient, app: Any
) -> None:
    app.state.runtime.local_models = SimpleNamespace(
        status=AsyncMock(side_effect=AssertionError("capability must not inspect weights")),
        close=lambda: None,
    )
    disabled = await client.get("/asr/live/capabilities")
    selected = await client.put(
        "/settings", json={"asr": {"provider": "local-whisper", "model": "small"}}
    )
    still_disabled = await client.get("/asr/live/capabilities")

    assert disabled.status_code == 200
    assert selected.status_code == 200
    assert still_disabled.json() == {
        "mode": "contextual_local",
        "capable": False,
        "requirements": {
            "local_profile_selected": True,
            "contextual_local_enabled": False,
            "live_finality_enabled": False,
            "local_speech_gate_enabled": False,
        },
        "detail": (
            "Turn on experimental contextual local mode in Settings; it enables local "
            "live finality and the local speech gate for new recordings."
        ),
    }
    app.state.runtime.local_models.status.assert_not_called()


async def test_capability_requires_authentication(client: httpx.AsyncClient) -> None:
    response = await client.get("/asr/live/capabilities", headers={"Authorization": ""})
    assert response.status_code == 401


async def test_capability_is_available_only_when_both_flags_and_local_profile_are_selected(
    client: httpx.AsyncClient, app: Any
) -> None:
    object.__setattr__(app.state.runtime.config, "live_finality_enabled", True)
    object.__setattr__(app.state.runtime.config, "local_speech_gate", True)
    await client.put(
        "/settings", json={"asr": {"provider": "local-whisper", "model": "small"}}
    )
    response = await client.get("/asr/live/capabilities")
    assert response.status_code == 200
    assert response.json()["capable"] is True
    assert response.json()["requirements"] == {
        "local_profile_selected": True,
        # The process override stays sufficient on its own; the UI opt-in is
        # reported separately so a blocked UI can name the missing action.
        "contextual_local_enabled": False,
        "live_finality_enabled": True,
        "local_speech_gate_enabled": True,
    }


async def test_contextual_session_rejects_legacy_upload_before_decoder(
    client: httpx.AsyncClient, app: Any
) -> None:
    created = await client.post(
        "/sessions", json={"title": "context", "mode": "contextual_local"}
    )
    session_id = created.json()["id"]
    ingest = AsyncMock(side_effect=AssertionError("legacy decoder path must not run"))
    flush = AsyncMock(return_value=[])
    app.state.runtime.ingestion.ingest = ingest
    app.state.runtime.ingestion.flush = flush

    response = await client.post(
        f"/sessions/{session_id}/audio",
        params={"sequence": 0, "start_ms": 0, "end_ms": 100},
        content=make_wav(0.1),
        headers={"Content-Type": "audio/wav"},
    )

    assert response.status_code == 409
    assert "contextual" in response.json()["detail"].lower()
    ingest.assert_not_called()
    paused = await client.patch(f"/sessions/{session_id}", json={"status": "paused"})
    assert paused.status_code == 200
    assert paused.json()["status"] == "paused"
    flush.assert_not_called()


async def test_legacy_session_with_finals_cannot_enter_contextual_writer(
    client: httpx.AsyncClient, app: Any
) -> None:
    object.__setattr__(app.state.runtime.config, "live_finality_enabled", True)
    object.__setattr__(app.state.runtime.config, "local_speech_gate", True)
    await client.put(
        "/settings",
        json={"asr": {"provider": "local-whisper", "model": "small"}},
    )
    created = await client.post("/sessions", json={"title": "legacy"})
    session_id = created.json()["id"]
    repo.replace_chunk_segments(
        app.state.runtime.db,
        session_id,
        0,
        [Segment(id="legacy-final", start_ms=0, end_ms=50, text="legacy")],
    )
    update = AsyncMock(side_effect=AssertionError("contextual final writer must not run"))
    app.state.runtime.live_asr.update = update

    response = await client.post(
        f"/sessions/{session_id}/asr/live/advance", json={"through_sequence": 0}
    )

    assert response.status_code == 409
    assert "legacy" in response.json()["detail"].lower()
    update.assert_not_called()
