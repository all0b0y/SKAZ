"""The live route must not ship snapshot fields no client reads.

Baseline profile (docs/BASELINE-PROFILE.md): at minute 60 the live response was
34.5 MiB, of which `final_stream_tokens` (10.5 MiB) and
`final_translation_projection` (2.6 MiB) are read by nothing in `frontend/src`
or `electron`, and every translation field is dead weight in a transcription
recording. The durable form these are derived from is unchanged — only the
per-second response is trimmed.
"""
from __future__ import annotations

import json
import time
from typing import Any

import pytest
from starlette.testclient import TestClient

from audiohelper.app import create_app
from audiohelper.config import AppConfig
from audiohelper.gateways import soniox
from audiohelper.secrets import MemorySecretStore
from tests.conftest import FakeHttp
from tests.test_native_live_ws import AUTH, packet
from tests.test_native_soniox_ws import ProviderSocket

# Derived from frontend/src/api/nativeLive.ts and the components that read it.
# This is the allow-list for the per-second response, not a claim that every
# entry is rendered: `origin` is one short string describing the recording and
# is cheap to keep, whereas anything token-shaped must earn its place here.
LIVE_RESPONSE_ALLOWED = {
    "session_id", "sample_rate", "saved_samples", "next_sequence", "audio_retained",
    "recording_mode", "translation_target_language", "used_languages", "transcription",
    "final_tokens", "live_translation_projection", "final_translation_tokens",
    "partial_translation_tokens", "speakers", "connections", "gaps", "origin",
}
NEVER_READ = {"final_stream_tokens", "final_translation_projection", "partial_stream_tokens"}
TRANSLATION_ONLY = {
    "live_translation_projection", "final_translation_tokens", "partial_translation_tokens",
}


def _record(
    config: AppConfig, outbound: FakeHttp, monkeypatch: pytest.MonkeyPatch, mode: str,
) -> dict[str, Any]:
    def token(text: str, status: str, start: int) -> dict[str, Any]:
        body = {"text": text, "speaker": "1", "translation_status": status,
                "language": "en", "confidence": .9, "is_final": True}
        if status != "translation":
            body |= {"start_ms": start, "end_ms": start + 20}
        return body

    class Socket(ProviderSocket):
        async def send(self, message: str | bytes) -> None:
            if isinstance(message, str):
                return
            if message:
                self.audio.append(message)
                return
            tokens = [token("Good", "original" if mode == "translation" else "none", 0)]
            if mode == "translation":
                tokens.append(token("Gut", "translation", 0))
            await self.responses.put(json.dumps({
                "tokens": tokens, "final_audio_proc_ms": 100,
                "total_audio_proc_ms": 100, "finished": True,
            }))

    async def connect(*args: Any, **kwargs: Any) -> ProviderSocket:
        return Socket()

    monkeypatch.setattr(soniox, "connect", connect)
    secrets = MemorySecretStore()
    secrets.set("soniox", "fixture-key-not-real")
    app = create_app(config, secret_store=secrets, http_client=outbound.client())
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as http:
        assert http.put("/settings", headers=AUTH, json={
            "native_recording_mode": mode, "translation_target_language": "de",
            "cloud_consent": True,
        }).status_code == 200
        sid = http.post("/sessions", headers=AUTH, json={"title": mode}).json()["id"]
        with http.websocket_connect(f"ws://127.0.0.1/sessions/{sid}/live/stream", headers=AUTH) as ws:
            ws.send_json({"type": "open", "sample_rate": 16000})
            ws.receive_json()
            deadline = time.monotonic() + 2
            while http.get(f"/sessions/{sid}/live", headers=AUTH).json()["transcription"] != "streaming":
                assert time.monotonic() < deadline
            ws.send_bytes(packet(0, 0))
            assert ws.receive_json()["type"] == "audio.saved"
            ws.send_json({"type": "end"})
            assert ws.receive_json()["transcription_complete"] is True
        return http.get(f"/sessions/{sid}/live", headers=AUTH).json()


def test_live_response_omits_fields_no_client_reads(
    config: AppConfig, outbound: FakeHttp, monkeypatch: pytest.MonkeyPatch,
) -> None:
    snapshot = _record(config, outbound, monkeypatch, "translation")
    assert not NEVER_READ & snapshot.keys()
    # The text the user sees still arrives, with speakers and source links.
    projection = snapshot["live_translation_projection"]
    assert [t["text"] for t in projection["original_tokens"]] == ["Good"]
    assert [t["text"] for t in projection["translation_tokens"]] == ["Gut"]
    assert projection["monologues"][0]["speaker_number"] == 1
    assert projection["original_tokens"][0]["segment_id"] is not None


def test_transcription_recording_ships_no_translation_fields(
    config: AppConfig, outbound: FakeHttp, monkeypatch: pytest.MonkeyPatch,
) -> None:
    snapshot = _record(config, outbound, monkeypatch, "transcription")
    assert not NEVER_READ & snapshot.keys()
    assert not TRANSLATION_ONLY & snapshot.keys()
    assert [t["text"] for t in snapshot["final_tokens"]] == ["Good"]
    assert snapshot["final_tokens"][0]["speaker_number"] == 1


def test_live_response_ships_nothing_the_renderer_cannot_name(
    config: AppConfig, outbound: FakeHttp, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Guards against a new heavy field silently entering the per-second path."""
    for mode in ("translation", "transcription"):
        snapshot = _record(config, outbound, monkeypatch, mode)
        assert not snapshot.keys() - LIVE_RESPONSE_ALLOWED, (
            f"{mode}: unknown fields in the live response — either a client reads "
            f"them (add to nativeLive.ts and to LIVE_RESPONSE_ALLOWED) or they "
            f"must not be sent every second."
        )
