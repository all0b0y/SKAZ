"""Explicit local-ASR model preparation, driven through the public HTTP API.

MECHANISM ONLY. The faster-whisper loader is monkeypatched in every test here, so
nothing is ever downloaded and no checkpoint is ever loaded. These tests prove the
state machine, the catalog gate, the single-slot rule and the error sanitisation —
they say nothing about real transcription quality, WER, latency or model behaviour.
Real speech acceptance lives outside the test suite (docs/ASR-RELIABILITY-SPEC.md).
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field

import httpx
import pytest

from audiohelper.gateways import asr as asr_gateway
from tests.conftest import make_wav


@dataclass
class FakeLoader:
    """Records every engine load instead of touching faster-whisper or the network."""

    calls: list[tuple[str, bool]] = field(default_factory=list)
    #: Raised by the allow_download=True step.
    download_error: Exception | None = None
    #: Raised by the local (allow_download=False) step until a download succeeded.
    local_error: Exception | None = None
    downloaded: set[str] = field(default_factory=set)
    #: Blocks the download step until released, to observe the "loading" state.
    gate: asyncio.Event | None = None
    loop: asyncio.AbstractEventLoop | None = None

    def __call__(self, model: str, *, allow_download: bool) -> object:
        self.calls.append((model, allow_download))
        if allow_download:
            if self.gate is not None and self.loop is not None:
                # to_thread runs this off the loop, so a blocking wait is safe here.
                asyncio.run_coroutine_threadsafe(self.gate.wait(), self.loop).result(timeout=5)
            if self.download_error is not None:
                raise self.download_error
            self.downloaded.add(model)
            return object()
        if self.local_error is not None and model not in self.downloaded:
            raise self.local_error
        return object()


@pytest.fixture
def loader(monkeypatch: pytest.MonkeyPatch) -> FakeLoader:
    fake = FakeLoader(local_error=FileNotFoundError("no local snapshot for the checkpoint"))
    monkeypatch.setattr(asr_gateway, "load_local_whisper", fake)
    monkeypatch.setattr(
        asr_gateway,
        "download_local_model",
        lambda _provider, model, **_kwargs: fake(model, allow_download=True),
    )
    monkeypatch.setattr(asr_gateway, "local_asr_available", lambda: True)
    # The transcriber's engine cache is process-wide; isolate it from other tests.
    monkeypatch.setattr(asr_gateway.LocalWhisperTranscriber, "_models", {})
    return fake


async def _poll(client: httpx.AsyncClient, model: str, *, until: set[str]) -> dict[str, object]:
    """Poll the status endpoint the way the UI does, with a bounded number of tries."""
    for _ in range(200):
        payload = (await client.get("/models/local/status", params={"model": model})).json()
        if payload["state"] in until:
            return dict(payload)
        await asyncio.sleep(0.01)
    raise AssertionError(f"model {model} never reached {until}")


@pytest.mark.parametrize(
    "unknown",
    ["../../../etc/passwd", "/tmp/weights", "openai/whisper-large-v3", "", "small "],
)
async def test_unknown_model_id_is_rejected_before_any_loader_call(
    client: httpx.AsyncClient, loader: FakeLoader, unknown: str
) -> None:
    prepare = await client.post("/models/local/prepare", json={"model": unknown})
    status = await client.get("/models/local/status", params={"model": unknown})

    assert prepare.status_code == 400
    assert status.status_code == 400
    assert loader.calls == []


async def test_status_reports_not_installed_without_downloading_anything(
    client: httpx.AsyncClient, loader: FakeLoader
) -> None:
    response = await client.get("/models/local/status", params={"model": "small"})

    assert response.status_code == 200
    body = response.json()
    assert {key: body[key] for key in ("model", "state", "error")} == {
        "model": "small",
        "state": "not_installed",
        "error": None,
    }
    # A status probe may only ever load from local files.
    assert loader.calls == [("small", False)]


async def test_prepare_downloads_then_verifies_a_local_load_before_ready(
    client: httpx.AsyncClient, loader: FakeLoader
) -> None:
    started = await client.post("/models/local/prepare", json={"model": "small"})
    assert started.status_code == 200
    assert started.json()["state"] == "installing"

    final = await _poll(client, "small", until={"ready", "error", "dependency_missing"})

    assert {key: final[key] for key in ("model", "state", "error")} == {
        "model": "small",
        "state": "ready",
        "error": None,
    }
    # Downloading is not enough: "ready" requires a second, network-free load.
    assert loader.calls == [("small", True), ("small", False)]


async def test_second_preparation_of_another_model_is_rejected_while_one_runs(
    client: httpx.AsyncClient, loader: FakeLoader
) -> None:
    loader.loop = asyncio.get_running_loop()
    loader.gate = asyncio.Event()

    first = await client.post("/models/local/prepare", json={"model": "small"})
    assert first.json()["state"] == "installing"
    conflict = await client.post("/models/local/prepare", json={"model": "medium"})
    same = await client.post("/models/local/prepare", json={"model": "small"})

    assert conflict.status_code == 409
    assert "small" in conflict.json()["detail"]
    assert same.status_code == 200 and same.json()["state"] == "installing"
    other_status = await client.get("/models/local/status", params={"model": "medium"})
    assert other_status.json()["state"] != "installing"
    assert [call for call in loader.calls if call[1]] == [("small", True)]

    loader.gate.set()
    assert (await _poll(client, "small", until={"ready", "error"}))["state"] == "ready"


async def test_missing_faster_whisper_is_its_own_state_not_a_generic_error(
    client: httpx.AsyncClient, loader: FakeLoader, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(asr_gateway, "local_asr_available", lambda: False)

    prepare = await client.post("/models/local/prepare", json={"model": "small"})

    assert prepare.status_code == 200
    body = prepare.json()
    assert body["state"] == "dependency_missing"
    assert "faster-whisper" in (body["error"] or "")
    assert "local-asr" in (body["error"] or "")
    # A missing dependency is never fixed by downloading weights.
    assert loader.calls == []


async def test_download_failure_reports_error_without_leaking_exception_text(
    client: httpx.AsyncClient, loader: FakeLoader
) -> None:
    loader.download_error = OSError(
        "failed writing /Users/secret/.cache/huggingface/token PRIVATE_TRACE Authorization: Bearer abc"
    )

    await client.post("/models/local/prepare", json={"model": "small"})
    final = await _poll(client, "small", until={"ready", "error"})
    raw = (await client.get("/models/local/status", params={"model": "small"})).text

    assert final["state"] == "error"
    assert final["error"]
    for leak in ("PRIVATE_TRACE", "Authorization", "Bearer", ".cache/huggingface"):
        assert leak not in raw


async def test_transcription_never_gains_a_download_path(
    client: httpx.AsyncClient, loader: FakeLoader
) -> None:
    """Preparing a model must not make the normal ASR path able to download."""
    await client.post("/models/local/prepare", json={"model": "small"})
    assert (await _poll(client, "small", until={"ready", "error"}))["state"] == "ready"
    loader.calls.clear()
    loader.downloaded.clear()  # the transcription path must fail rather than fetch weights

    session = (await client.post("/sessions", json={"title": "local asr"})).json()
    upload = await client.post(
        f"/sessions/{session['id']}/audio",
        params={"sequence": 0, "start_ms": 0, "end_ms": 1000},
        content=make_wav(1.0),
        headers={"Content-Type": "audio/wav"},
    )

    assert upload.status_code == 400
    assert loader.calls == [("small", False)]
