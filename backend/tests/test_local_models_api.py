"""Explicit local-ASR model preparation (``LocalModelPreparations.start``).

The model routes of the old interface are gone; the Knowledge Wiki starts a
download from the speech health action (``knowledge/settings/health.py``) and shows
the state the manager reports (``knowledge/settings/speech.py`` reads it), so these
tests drive ``start`` the same way and read that same state.

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

from skaz.gateways import asr as asr_gateway
from tests.sessions_support import runtime_of


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


def report(client: httpx.AsyncClient, model: str) -> tuple[str, str | None] | None:
    """The manager's last report for a checkpoint, as the speech settings read it."""
    known = runtime_of(client).local_models._reports.get(f"local-whisper:{model}")
    return None if known is None else (known[0], known[1])


async def _poll(client: httpx.AsyncClient, model: str, *, until: set[str]) -> tuple[str, str | None]:
    """Wait for the background preparation with a bounded number of tries."""
    for _ in range(200):
        known = report(client, model)
        if known is not None and known[0] in until:
            return known
        await asyncio.sleep(0.01)
    raise AssertionError(f"model {model} never reached {until}")


async def test_prepare_downloads_then_verifies_a_local_load_before_ready(
    client: httpx.AsyncClient, loader: FakeLoader
) -> None:
    started = await runtime_of(client).local_models.start("small")
    assert started[0] == "installing"

    final = await _poll(client, "small", until={"ready", "error", "dependency_missing"})

    assert final == ("ready", None)
    # Downloading is not enough: "ready" requires a second, network-free load.
    assert loader.calls == [("small", True), ("small", False)]


async def test_second_preparation_of_another_model_is_rejected_while_one_runs(
    client: httpx.AsyncClient, loader: FakeLoader
) -> None:
    loader.loop = asyncio.get_running_loop()
    loader.gate = asyncio.Event()
    preparations = runtime_of(client).local_models

    first = await preparations.start("small")
    assert first[0] == "installing"
    with pytest.raises(asr_gateway.LocalModelBusy) as conflict:
        await preparations.start("medium")
    same = await preparations.start("small")

    assert "small" in conflict.value.active
    assert same[0] == "installing"
    assert report(client, "medium") is None
    for _ in range(200):  # the download step runs in the background task
        if loader.calls:
            break
        await asyncio.sleep(0.01)
    assert [call for call in loader.calls if call[1]] == [("small", True)]

    loader.gate.set()
    assert (await _poll(client, "small", until={"ready", "error"}))[0] == "ready"


async def test_missing_faster_whisper_is_its_own_state_not_a_generic_error(
    client: httpx.AsyncClient, loader: FakeLoader, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(asr_gateway, "local_asr_available", lambda: False)

    state, error = await runtime_of(client).local_models.start("small")

    assert state == "dependency_missing"
    assert "faster-whisper" in (error or "")
    assert "local-asr" in (error or "")
    # A missing dependency is never fixed by downloading weights.
    assert loader.calls == []


async def test_download_failure_reports_error_without_leaking_exception_text(
    client: httpx.AsyncClient, loader: FakeLoader
) -> None:
    loader.download_error = OSError(
        "failed writing /Users/secret/.cache/huggingface/token PRIVATE_TRACE Authorization: Bearer ***"
    )

    await runtime_of(client).local_models.start("small")
    state, error = await _poll(client, "small", until={"ready", "error"})
    speech = (await client.get("/kb/settings/speech")).text

    assert state == "error"
    assert error
    for leak in ("PRIVATE_TRACE", "Authorization", "Bearer", ".cache/huggingface"):
        assert leak not in error
        assert leak not in speech
