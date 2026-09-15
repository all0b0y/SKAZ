"""Explicit user opt-in for the experimental contextual local mode.

The process flags ``AUDIOHELPER_LIVE_FINALITY`` / ``AUDIOHELPER_LOCAL_SPEECH_GATE``
stay a developer override. These tests describe the user-facing seam: with no
process override at all, an explicit persisted settings opt-in is what enables
the contextual runtime capabilities, reading capability never enables anything,
and the legacy/cloud path keeps its own gate semantics.
"""

from __future__ import annotations

import asyncio
import threading
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Any

import httpx
import pytest

from audiohelper.app import create_app
from audiohelper.config import AppConfig
from audiohelper.schemas import LiveAsrDraftResponse
from audiohelper.secrets import MemorySecretStore
from tests.conftest import TOKEN, FakeHttp, make_wav

LOCAL_PROFILE = {"asr": {"provider": "local-whisper", "model": "small"}}


@asynccontextmanager
async def _opened(application: Any) -> AsyncIterator[httpx.AsyncClient]:
    """A client for an application instance that is closed afterwards."""
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=application),
            base_url="http://127.0.0.1:8765",
            headers={"Authorization": f"Bearer {TOKEN}"},
        ) as opened:
            yield opened
    finally:
        application.state.runtime.close()


async def _enable(client: httpx.AsyncClient, enabled: bool) -> httpx.Response:
    return await client.put("/settings", json={"contextual_local_enabled": enabled})


async def _contextual_session(client: httpx.AsyncClient) -> str:
    created = await client.post(
        "/sessions", json={"title": "contextual", "mode": "contextual_local"}
    )
    assert created.status_code == 200, created.text
    return str(created.json()["id"])


async def _store(client: httpx.AsyncClient, session_id: str, sequence: int) -> None:
    start = sequence * 5_000
    response = await client.post(
        f"/sessions/{session_id}/audio/store",
        params={"sequence": sequence, "start_ms": start, "end_ms": start + 5_000},
        content=make_wav(5.0, frequency=220 + sequence),
        headers={"Content-Type": "audio/wav"},
    )
    assert response.status_code in (200, 201), response.text


async def _wait_terminal(client: httpx.AsyncClient, session_id: str) -> dict[str, Any]:
    for _ in range(100):
        status = await client.get(f"/sessions/{session_id}/asr/live/scheduler")
        body = dict(status.json())
        if body["status"] in {"complete", "stalled", "stopped"}:
            return body
        await asyncio.sleep(0)
    raise AssertionError("scheduler did not reach a terminal state")


async def test_opt_in_is_off_by_default_and_named_as_the_blocker(
    client: httpx.AsyncClient,
) -> None:
    stored = await client.get("/settings")
    assert stored.status_code == 200
    assert stored.json()["contextual_local_enabled"] is False

    assert (await client.put("/settings", json=LOCAL_PROFILE)).status_code == 200
    capabilities = (await client.get("/asr/live/capabilities")).json()

    assert capabilities["capable"] is False
    assert capabilities["requirements"] == {
        "local_profile_selected": True,
        "contextual_local_enabled": False,
        "live_finality_enabled": False,
        "local_speech_gate_enabled": False,
    }
    assert "settings" in capabilities["detail"].lower()


async def test_explicit_opt_in_enables_the_contextual_runtime_capabilities(
    client: httpx.AsyncClient, app: Any
) -> None:
    await client.put("/settings", json=LOCAL_PROFILE)
    saved = await _enable(client, True)

    assert saved.status_code == 200
    assert saved.json()["contextual_local_enabled"] is True

    capabilities = (await client.get("/asr/live/capabilities")).json()
    assert capabilities["capable"] is True
    assert capabilities["requirements"] == {
        "local_profile_selected": True,
        "contextual_local_enabled": True,
        "live_finality_enabled": True,
        "local_speech_gate_enabled": True,
    }

    created = await client.post(
        "/sessions", json={"title": "contextual", "mode": "contextual_local"}
    )
    scheduler = await client.get(f"/sessions/{created.json()['id']}/asr/live/scheduler")
    assert scheduler.status_code == 200
    assert scheduler.json()["capable"] is True
    assert app.state.runtime.live_scheduler.capable() is True


async def test_reading_capability_never_enables_the_mode(
    client: httpx.AsyncClient, app: Any
) -> None:
    await client.put("/settings", json=LOCAL_PROFILE)

    for _ in range(3):
        assert (await client.get("/asr/live/capabilities")).json()["capable"] is False

    runtime = app.state.runtime
    assert runtime.settings_store.load().contextual_local_enabled is False
    assert runtime.live_finality_enabled is False
    assert runtime.local_speech_gate is False
    assert runtime.live_scheduler.capable() is False


async def test_opt_in_survives_a_backend_restart(
    config: AppConfig, outbound: FakeHttp
) -> None:
    first = create_app(config, secret_store=MemorySecretStore(), http_client=outbound.client())
    async with _opened(first) as client:
        await client.put("/settings", json=LOCAL_PROFILE)
        assert (await _enable(client, True)).status_code == 200

    second = create_app(config, secret_store=MemorySecretStore(), http_client=outbound.client())
    async with _opened(second) as client:
        restored = await client.get("/asr/live/capabilities")
        assert restored.json()["capable"] is True
        assert (await client.get("/settings")).json()["contextual_local_enabled"] is True


async def test_opting_out_disables_the_runtime_capabilities_again(
    client: httpx.AsyncClient, app: Any
) -> None:
    await client.put("/settings", json=LOCAL_PROFILE)
    await _enable(client, True)
    created = await client.post(
        "/sessions", json={"title": "contextual", "mode": "contextual_local"}
    )
    session_id = created.json()["id"]

    assert (await _enable(client, False)).status_code == 200

    capabilities = (await client.get("/asr/live/capabilities")).json()
    assert capabilities["capable"] is False
    assert capabilities["requirements"]["contextual_local_enabled"] is False
    assert app.state.runtime.live_scheduler.capable() is False
    advance = await client.post(
        f"/sessions/{session_id}/asr/live/advance", json={"through_sequence": 0}
    )
    assert advance.status_code == 400


async def test_opt_in_alone_does_not_make_a_cloud_profile_contextual(
    client: httpx.AsyncClient,
) -> None:
    await client.put("/settings", json=LOCAL_PROFILE)
    await _enable(client, True)

    await client.put("/settings", json={"asr": {"provider": "openai", "model": "whisper-1"}})
    capabilities = (await client.get("/asr/live/capabilities")).json()

    assert capabilities["capable"] is False
    assert capabilities["requirements"]["local_profile_selected"] is False
    assert capabilities["requirements"]["contextual_local_enabled"] is True
    assert "local-whisper" in capabilities["detail"]


async def test_opt_in_does_not_change_the_legacy_process_gate_or_session_default(
    client: httpx.AsyncClient, app: Any
) -> None:
    await client.put("/settings", json=LOCAL_PROFILE)
    await _enable(client, True)

    # The legacy per-chunk path keeps reading the process-level flag, so opting
    # into the contextual mode never changes legacy/cloud gate semantics.
    assert app.state.runtime.config.local_speech_gate is False
    assert app.state.runtime.config.live_finality_enabled is False
    created = await client.post("/sessions", json={"title": "old client"})
    assert created.json()["mode"] == "legacy"


async def test_process_override_still_enables_capability_without_the_setting(
    client: httpx.AsyncClient, app: Any
) -> None:
    object.__setattr__(app.state.runtime.config, "live_finality_enabled", True)
    object.__setattr__(app.state.runtime.config, "local_speech_gate", True)
    await client.put("/settings", json=LOCAL_PROFILE)

    capabilities = (await client.get("/asr/live/capabilities")).json()

    assert capabilities["capable"] is True
    assert capabilities["requirements"]["contextual_local_enabled"] is False


async def test_opting_out_mid_flight_stops_the_admitted_job_without_forcing_a_final(
    client: httpx.AsyncClient, app: Any
) -> None:
    await client.put("/settings", json={**LOCAL_PROFILE, "transcript_language": "ru"})
    await _enable(client, True)
    session_id = await _contextual_session(client)
    await _store(client, session_id, 0)

    entered = asyncio.Event()
    release = asyncio.Event()
    calls = 0

    async def delayed(*_args: object) -> LiveAsrDraftResponse:
        nonlocal calls
        calls += 1
        entered.set()
        await release.wait()
        return LiveAsrDraftResponse(draft=None)

    app.state.runtime.live_asr.update = delayed
    accepted = await client.post(
        f"/sessions/{session_id}/asr/live/advance", json={"through_sequence": 0}
    )
    assert accepted.status_code == 202
    await entered.wait()

    assert (await _enable(client, False)).status_code == 200
    release.set()

    terminal = await _wait_terminal(client, session_id)
    assert terminal["block_reason"] == "config_changed"
    assert terminal["status"] in {"stalled", "stopped"}
    assert terminal["capable"] is False
    # The withdrawn opt-in stops the job instead of running another window, and
    # nothing is finalized on the way out: the tail stays a draft.
    assert calls == 1
    detail = await client.get(f"/sessions/{session_id}")
    assert detail.json()["segments"] == []
    retry = await client.post(
        f"/sessions/{session_id}/asr/live/advance", json={"through_sequence": 0}
    )
    assert retry.status_code == 400


async def test_toggling_off_and_on_mid_flight_still_invalidates_the_running_decode(
    client: httpx.AsyncClient, app: Any
) -> None:
    """The effective flags return to equal values, so only the generation guards this."""
    await client.put("/settings", json={**LOCAL_PROFILE, "transcript_language": "ru"})
    await _enable(client, True)
    session_id = await _contextual_session(client)
    await _store(client, session_id, 0)

    entered = asyncio.Event()
    release = asyncio.Event()
    calls = 0

    async def delayed(*_args: object) -> LiveAsrDraftResponse:
        nonlocal calls
        calls += 1
        entered.set()
        await release.wait()
        return LiveAsrDraftResponse(draft=None)

    app.state.runtime.live_asr.update = delayed
    accepted = await client.post(
        f"/sessions/{session_id}/asr/live/advance", json={"through_sequence": 0}
    )
    assert accepted.status_code == 202
    await entered.wait()
    before = app.state.runtime.settings_store.load_asr_snapshot()[1]

    assert (await _enable(client, False)).status_code == 200
    assert (await _enable(client, True)).status_code == 200
    release.set()

    after = app.state.runtime.settings_store.load_asr_snapshot()[1]
    assert after > before
    terminal = await _wait_terminal(client, session_id)
    assert terminal["block_reason"] == "config_changed"
    assert terminal["capable"] is True  # capability is back, the old job is not
    assert calls == 1
    detail = await client.get(f"/sessions/{session_id}")
    assert detail.json()["segments"] == []

    # The restored capability still requires a new explicit admission.
    readmitted = await client.post(
        f"/sessions/{session_id}/asr/live/advance", json={"through_sequence": 0}
    )
    assert readmitted.status_code == 202


class _BlockingEngine:
    """A local decoder stand-in that parks inside ``transcribe`` until released.

    It replaces the faster-whisper engine only, so the real window preparation,
    decode-result handling, staleness checks and commit path all run.
    """

    def __init__(self, entered: threading.Event, release: threading.Event) -> None:
        self.entered = entered
        self.release = release
        self.calls = 0

    def transcribe(
        self,
        samples: Any,
        *,
        language: str | None,
        vad_filter: bool,
        word_timestamps: bool = False,
    ) -> tuple[list[Any], Any]:
        self.calls += 1
        self.entered.set()
        assert self.release.wait(timeout=10)
        words = [SimpleNamespace(word=" Alpha", start=1.0, end=2.0)]
        segment = SimpleNamespace(text=" Alpha", words=words, start=1.0, end=2.0)
        return [segment], SimpleNamespace(language=language or "ru")


async def test_toggling_off_and_on_during_a_real_decode_never_commits_the_stale_window(
    client: httpx.AsyncClient, app: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The decoder edge: only the real commit path can show a stale window is refused."""
    await client.put("/settings", json={**LOCAL_PROFILE, "transcript_language": "ru"})
    await _enable(client, True)
    session_id = await _contextual_session(client)
    await _store(client, session_id, 0)

    engine = _BlockingEngine(threading.Event(), threading.Event())
    monkeypatch.setattr("audiohelper.gateways.asr.detect_speech_presence", lambda _samples: True)
    monkeypatch.setattr(
        "audiohelper.gateways.asr.load_local_whisper",
        lambda _model, *, allow_download: engine,
    )

    accepted = await client.post(
        f"/sessions/{session_id}/asr/live/advance", json={"through_sequence": 0}
    )
    assert accepted.status_code == 202
    assert await asyncio.to_thread(engine.entered.wait, 10)

    assert (await _enable(client, False)).status_code == 200
    assert (await _enable(client, True)).status_code == 200
    engine.release.set()

    terminal = await _wait_terminal(client, session_id)
    assert engine.calls == 1
    # The decoded window was produced under a configuration the user withdrew,
    # so nothing from it may become a draft, a final or a stable frontier.
    assert terminal["block_reason"] in {"source_conflict", "config_changed"}
    assert terminal["stable_frontier_ms"] == 0
    assert terminal["processed_window"] is None
    detail = await client.get(f"/sessions/{session_id}")
    assert detail.json()["segments"] == []
    live = await client.get(f"/sessions/{session_id}/asr/live")
    assert live.status_code in (200, 404)
    if live.status_code == 200:
        assert live.json()["draft"] is None


async def test_unknown_settings_fields_are_still_rejected(client: httpx.AsyncClient) -> None:
    response = await client.put("/settings", json={"contextual_local": True})
    assert response.status_code == 422
