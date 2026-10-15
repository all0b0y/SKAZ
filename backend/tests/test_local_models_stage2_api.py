"""Stage-2 local model contracts.

The local-model status/prepare/delete routes of the old interface are gone (the
Knowledge Wiki only starts a download from its health action and shows its
progress); their HTTP tests went with them, see the L1 report.

All cache mutations use a temporary, application-owned cache.  Runtime loading,
downloads and inference are replaced at the external SDK boundary; these tests
never touch the user's Hugging Face cache or fetch model weights.
"""

from __future__ import annotations

import asyncio
import logging
import sys
import threading
from pathlib import Path
from types import ModuleType, SimpleNamespace
from typing import Any

import httpx
import pytest

from skaz import local_models
from skaz.audio import parse_wav
from skaz.gateways import ProviderError
from skaz.gateways import asr as asr_gateway
from skaz.local_models import GIGACHAT_MODEL_ID, GIGACHAT_PROVIDER
from tests.conftest import make_wav


async def test_gigachat_profile_needs_no_key_but_is_asr_only(client: httpx.AsyncClient) -> None:
    saved = await client.put(
        "/settings",
        json={"asr": {"provider": GIGACHAT_PROVIDER, "model": GIGACHAT_MODEL_ID}},
    )
    rejected = await client.put(
        "/settings",
        json={"agent": {"provider": GIGACHAT_PROVIDER, "model": GIGACHAT_MODEL_ID}},
    )

    assert saved.status_code == 200
    assert saved.json()["provider_has_api_key"].get(GIGACHAT_PROVIDER) is None
    assert saved.json()["asr"]["verified"] is False
    assert rejected.status_code == 400


async def test_local_gigachat_rejects_api_key_material(
    client: httpx.AsyncClient,
    app: Any,
) -> None:
    """A local provider owns no credential: provider_keys does not accept its name."""
    rejected = await client.put(
        "/settings",
        json={
            "provider_keys": {GIGACHAT_PROVIDER: "synthetic-must-not-be-stored"},
            "asr": {"provider": GIGACHAT_PROVIDER, "model": GIGACHAT_MODEL_ID},
        },
    )

    assert rejected.status_code == 422
    assert "synthetic-must-not-be-stored" not in rejected.text
    assert app.state.runtime.secrets.get(GIGACHAT_PROVIDER) is None


def test_gigachat_download_uses_exact_repo_and_immutable_revision(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    captured: dict[str, Any] = {}

    def snapshot_download(**kwargs: Any) -> str:
        captured.update(kwargs)
        return str(tmp_path / "snapshot")

    monkeypatch.setattr("huggingface_hub.snapshot_download", snapshot_download)

    local_models.download_local_model(
        GIGACHAT_PROVIDER,
        GIGACHAT_MODEL_ID,
        cache_dir=tmp_path,
        progress=lambda _progress: None,
    )

    assert captured["repo_id"] == GIGACHAT_MODEL_ID
    assert captured["revision"] == local_models.GIGACHAT_REVISION
    assert captured["cache_dir"] == str(tmp_path)
    assert "allow_patterns" not in captured


def test_installed_huggingface_snapshot_progress_counts_transfer_bytes_once() -> None:
    """Mirror huggingface-hub 1.30's two parent byte bars at our callback seam.

    A normal HTTP chunk advances both reconstruction and transfer.  The UI's
    ``downloaded_bytes`` is network transfer, so observing both bars must not
    turn a 4,419-byte README into 8,838 reported bytes.
    """
    from huggingface_hub.utils._xet_progress_reporting import _update_transfer_bar
    from huggingface_hub.utils.tqdm import _create_progress_bar

    reports: list[local_models.DownloadProgress] = []
    progress_class = local_models._progress_tqdm(reports.append)
    reconstruction = _create_progress_bar(
        cls=progress_class,
        log_level=logging.INFO,
        name="huggingface_hub.snapshot_download",
        total=4_419,
        unit="B",
        desc="Reconstructing (incomplete total...)",
    )
    transfer = _create_progress_bar(
        cls=progress_class,
        log_level=logging.INFO,
        name="huggingface_hub.snapshot_download.transfer",
        total=4_419,
        unit="B",
        desc="Downloading bytes",
    )

    reconstruction.update(4_419)
    _update_transfer_bar(transfer, 4_419)
    reconstruction.close()
    transfer.close()

    assert reports[-1].downloaded_bytes == 4_419
    assert all(report.total_bytes is None for report in reports)


def test_gigachat_runtime_load_is_pinned_offline_and_request_guard_uses_public_api(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    captured: dict[str, Any] = {}
    engine = SimpleNamespace(model_dir="model-dir", manifest="manifest", config="config")

    class Runtime:
        @staticmethod
        def from_pretrained(repo_id: str, **kwargs: Any) -> Any:
            captured["load"] = (repo_id, kwargs)
            return engine

    def request_memory_preflight(*args: Any, **kwargs: Any) -> None:
        captured["request"] = (args, kwargs)

    package = ModuleType("gigachat_audio_mlx")
    runtime = ModuleType("gigachat_audio_mlx.runtime")
    runtime.GigaChatAudioRuntime = Runtime  # type: ignore[attr-defined]
    runtime.request_memory_preflight = request_memory_preflight  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "gigachat_audio_mlx", package)
    monkeypatch.setitem(sys.modules, "gigachat_audio_mlx.runtime", runtime)

    loaded = asr_gateway.load_local_gigachat(cache_dir=tmp_path)
    asr_gateway.run_gigachat_request_preflight(loaded, audio_seconds=5.0)

    assert loaded is engine
    assert captured["load"] == (
        GIGACHAT_MODEL_ID,
        {
            "revision": local_models.GIGACHAT_REVISION,
            "cache_dir": tmp_path,
            "local_files_only": True,
        },
    )
    assert captured["request"] == (
        ("model-dir", "manifest", "config"),
        {"audio_seconds": 5.0, "max_tokens": 512},
    )


async def test_gigachat_adapter_uses_public_audio_message_and_request_preflight(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    del tmp_path
    captured: dict[str, Any] = {}

    class Engine:
        def generate(self, messages: list[dict[str, Any]], **kwargs: Any) -> Any:
            audio_path = Path(messages[0]["content"][0]["path"])
            captured["messages"] = messages
            captured["audio"] = audio_path.read_bytes()
            captured["generate_kwargs"] = kwargs
            return SimpleNamespace(
                text="  original words  ",
                stats=SimpleNamespace(finish_reason="eos"),
            )

    engine = Engine()
    monkeypatch.setattr(asr_gateway.LocalGigaChatTranscriber, "_engine", lambda _self: engine)
    monkeypatch.setattr(
        asr_gateway,
        "run_gigachat_request_preflight",
        lambda actual, *, audio_seconds: captured.update(
            preflight_engine=actual,
            audio_seconds=audio_seconds,
        ),
    )
    audio = parse_wav(make_wav(1.0), max_seconds=5)

    pieces = await asr_gateway.LocalGigaChatTranscriber(cache_dir=None).transcribe(
        audio, language="ru"
    )

    assert captured["preflight_engine"] is engine
    assert captured["audio_seconds"] == pytest.approx(1.0)
    assert captured["audio"].startswith(b"RIFF")
    content = captured["messages"][0]["content"]
    assert [part["type"] for part in content] == ["audio", "text"]
    prompt = content[1]["text"]
    assert "original language" in prompt
    assert "untrusted user data" in prompt
    assert captured["generate_kwargs"] == {
        "max_tokens": 512,
        "temperature": 0,
        "top_p": 0,
    }
    assert pieces == [asr_gateway.TranscriptPiece(0, audio.duration_ms, "original words", None)]
    assert asr_gateway.LocalGigaChatTranscriber.can_verify_asr is False


async def test_gigachat_length_finish_is_a_visible_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = SimpleNamespace(
        generate=lambda *_args, **_kwargs: SimpleNamespace(
            text="partial transcript",
            stats=SimpleNamespace(finish_reason="length"),
        )
    )
    monkeypatch.setattr(asr_gateway.LocalGigaChatTranscriber, "_engine", lambda _self: engine)
    monkeypatch.setattr(asr_gateway, "run_gigachat_request_preflight", lambda *_a, **_k: None)
    audio = parse_wav(make_wav(1.0), max_seconds=5)

    with pytest.raises(ProviderError, match="output-token limit"):
        await asr_gateway.LocalGigaChatTranscriber(cache_dir=None).transcribe(
            audio, language="auto"
        )


def test_delete_refuses_allowlisted_repo_boundary_symlink(tmp_path: Path) -> None:
    cache = tmp_path / "isolated-hf"
    outside = tmp_path / "must-survive"
    outside.mkdir()
    sentinel = outside / "weights.bin"
    sentinel.write_bytes(b"keep")
    cache.mkdir()
    repo = cache / "models--Systran--faster-whisper-small"
    repo.symlink_to(outside, target_is_directory=True)

    with pytest.raises(local_models.CacheSafetyError, match="symlink"):
        local_models.delete_local_model_cache(
            "local-whisper",
            "small",
            cache_dir=cache,
        )

    assert repo.is_symlink()
    assert sentinel.read_bytes() == b"keep"


async def test_cancelled_thread_helper_waits_for_failure_but_cancellation_wins() -> None:
    entered = asyncio.Event()
    release = threading.Event()
    finished = threading.Event()
    loop = asyncio.get_running_loop()

    def failing_worker() -> None:
        loop.call_soon_threadsafe(entered.set)
        release.wait(timeout=5)
        finished.set()
        raise RuntimeError("worker failed after caller cancellation")

    task = asyncio.create_task(asr_gateway._to_thread_until_finished(failing_worker))
    await entered.wait()
    task.cancel()
    await asyncio.sleep(0)
    assert not task.done()

    release.set()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert finished.is_set()


async def test_preparation_progress_is_real_callback_bytes_without_fake_percentage(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """What the speech settings show while a download runs: bytes the downloader reported, no invented %."""
    entered = asyncio.Event()
    release = threading.Event()
    loop = asyncio.get_running_loop()

    def fake_download(
        _provider: str,
        _model: str,
        *,
        cache_dir: Path | None,
        progress: Any,
    ) -> None:
        del cache_dir
        progress(local_models.DownloadProgress(downloaded_bytes=1_048_576, completed_files=2))
        loop.call_soon_threadsafe(entered.set)
        release.wait(timeout=5)

    monkeypatch.setattr(asr_gateway, "download_local_model", fake_download)
    monkeypatch.setattr(asr_gateway, "load_local_whisper", lambda *_args, **_kwargs: object())
    monkeypatch.setattr(asr_gateway, "local_asr_available", lambda: True)
    preparations = client._transport.app.state.runtime.local_models  # type: ignore[attr-defined]

    started = await preparations.start("small", "local-whisper")
    await entered.wait()
    progress = preparations.progress("local-whisper", "small")
    speech = (await client.get("/kb/settings/speech")).json()["local_model"]
    release.set()
    for _ in range(100):
        if preparations._reports.get("local-whisper:small", ("",))[0] == "ready":
            break
        await asyncio.sleep(0.01)
    else:
        raise AssertionError("the local model never reached ready")

    assert started[0] == "installing"
    assert progress == local_models.DownloadProgress(downloaded_bytes=1_048_576, completed_files=2)
    assert (speech["state"], speech["progress"]) == ("downloading", None)

