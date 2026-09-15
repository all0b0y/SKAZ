"""Stage-2 local model contracts through authenticated public HTTP seams.

All cache mutations use a temporary, application-owned cache.  Runtime loading,
downloads and inference are replaced at the external SDK boundary; these tests
never touch the user's Hugging Face cache or fetch model weights.
"""

from __future__ import annotations

import asyncio
import logging
import sys
import threading
from contextlib import suppress
from dataclasses import replace
from pathlib import Path
from types import ModuleType, SimpleNamespace
from typing import Any

import httpx
import pytest

from audiohelper import local_models
from audiohelper.app import create_app
from audiohelper.audio import parse_wav
from audiohelper.catalog import GIGACHAT_MODEL_ID, GIGACHAT_PROVIDER
from audiohelper.gateways import ProviderError
from audiohelper.gateways import asr as asr_gateway
from audiohelper.secrets import MemorySecretStore
from tests.conftest import TOKEN, FakeHttp, make_wav


async def test_exact_gigachat_audio_model_is_an_honest_local_legacy_option(
    client: httpx.AsyncClient,
) -> None:
    response = await client.get(
        "/models", params={"provider": GIGACHAT_PROVIDER, "task": "asr"}
    )

    assert response.status_code == 200
    body = response.json()
    assert body["error"] is None
    assert len(body["models"]) == 1
    model = body["models"][0]
    assert model == {
        "id": GIGACHAT_MODEL_ID,
        "name": "GigaChat Audio MLX (BF16)",
        "input_modalities": ["audio"],
        "output_modalities": ["text"],
        "max_output_tokens": 512,
        "pricing": None,
        "asr_contract": "legacy",
        "recommended": False,
        "verified": False,
        "note": model["note"],
    }
    note = model["note"].lower()
    assert "audio-language" in note
    assert "chunk" in note
    assert "local-whisper" in note

    text_catalog = await client.get(
        "/models", params={"provider": GIGACHAT_PROVIDER, "task": "agent"}
    )
    assert text_catalog.json() == {"models": [], "error": None}


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
    assert saved.json()["asr"]["has_api_key"] is False
    assert saved.json()["asr"]["verified"] is False
    assert rejected.status_code == 400


async def test_local_gigachat_rejects_api_key_material(
    client: httpx.AsyncClient,
    app: Any,
) -> None:
    rejected = await client.put(
        "/settings",
        json={
            "asr": {
                "provider": GIGACHAT_PROVIDER,
                "model": GIGACHAT_MODEL_ID,
                "api_key": "synthetic-must-not-be-stored",
            }
        },
    )

    assert rejected.status_code == 400
    assert "synthetic-must-not-be-stored" not in rejected.text
    assert app.state.runtime.secrets.get(GIGACHAT_PROVIDER) is None


async def test_gigachat_ingestion_needs_no_cloud_consent_and_never_falls_back(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        asr_gateway,
        "gigachat_host_status",
        lambda: local_models.HostStatus(False, "deterministic hardware blocker", 16, 32),
    )
    monkeypatch.setattr(
        asr_gateway,
        "load_local_whisper",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("GigaChat must never fall back to Whisper")
        ),
    )
    saved = await client.put(
        "/settings",
        json={"asr": {"provider": GIGACHAT_PROVIDER, "model": GIGACHAT_MODEL_ID}},
    )
    session = (await client.post("/sessions", json={"title": "local GigaChat"})).json()

    uploaded = await client.post(
        f"/sessions/{session['id']}/audio",
        params={"sequence": 0, "start_ms": 0, "end_ms": 1000},
        content=make_wav(1.0),
        headers={"Content-Type": "audio/wav"},
    )

    assert saved.status_code == 200
    assert uploaded.status_code == 400
    assert "hardware blocker" in uploaded.text
    assert "cloud consent" not in uploaded.text.lower()


async def test_real_host_preflight_blocks_bf16_before_dependency_or_download(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    called = False

    def forbidden(*_args: Any, **_kwargs: Any) -> None:
        nonlocal called
        called = True
        raise AssertionError("hardware-blocked preparation must not download")

    monkeypatch.setattr(asr_gateway, "physical_memory_bytes", lambda: 17_179_869_184)
    monkeypatch.setattr(asr_gateway, "local_platform", lambda: ("darwin", "arm64"))
    monkeypatch.setattr(asr_gateway, "download_local_model", forbidden)
    response = await client.get(
        "/models/local/status",
        params={"provider": GIGACHAT_PROVIDER, "model": GIGACHAT_MODEL_ID},
    )
    prepare = await client.post(
        "/models/local/prepare",
        json={"provider": GIGACHAT_PROVIDER, "model": GIGACHAT_MODEL_ID},
    )
    assert response.status_code == 200
    assert response.json()["state"] == "unsupported"
    assert response.json()["hardware"]["physical_memory_bytes"] == 17_179_869_184
    assert (
        response.json()["hardware"]["required_memory_bytes"]
        > response.json()["hardware"]["physical_memory_bytes"]
    )
    assert response.json()["shared_cache"] is True
    assert "other applications" in response.json()["warning"]
    assert prepare.json()["state"] == "unsupported"
    assert called is False


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


@pytest.mark.parametrize("endpoint", ["prepare", "status", "delete"])
async def test_unknown_or_mismatched_local_identity_never_reaches_cache(
    client: httpx.AsyncClient, endpoint: str
) -> None:
    if endpoint == "status":
        response = await client.get(
            "/models/local/status",
            params={"provider": GIGACHAT_PROVIDER, "model": "../other"},
        )
    elif endpoint == "delete":
        response = await client.request(
            "DELETE",
            "/models/local",
            json={
                "provider": GIGACHAT_PROVIDER,
                "model": "../other",
                "confirmation_model": "../other",
            },
        )
    else:
        response = await client.post(
            "/models/local/prepare",
            json={"provider": GIGACHAT_PROVIDER, "model": "../other"},
        )

    assert response.status_code == 400


async def test_delete_requires_exact_confirmation(client: httpx.AsyncClient) -> None:
    response = await client.request(
        "DELETE",
        "/models/local",
        json={
            "provider": GIGACHAT_PROVIDER,
            "model": GIGACHAT_MODEL_ID,
            "confirmation_model": "wrong",
        },
    )

    assert response.status_code == 400


async def test_local_model_deletion_requires_backend_authentication(
    app: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        asr_gateway,
        "delete_local_model_cache",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("unauthenticated deletion must not reach the cache")
        ),
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://127.0.0.1:8765",
    ) as unauthenticated:
        response = await unauthenticated.request(
            "DELETE",
            "/models/local",
            json={
                "provider": "local-whisper",
                "model": "small",
                "confirmation_model": "small",
            },
        )

    assert response.status_code == 401


async def test_delete_removes_only_allowlisted_repo_and_status_stays_offline_absent(
    config: Any,
    outbound: FakeHttp,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cache = tmp_path / "isolated-hf"
    model_repo = cache / "models--Systran--faster-whisper-small"
    other_repo = cache / "models--someone--other-model"
    (model_repo / "blobs").mkdir(parents=True)
    (model_repo / "blobs" / "partial.incomplete").write_bytes(b"partial")
    (other_repo / "blobs").mkdir(parents=True)
    (other_repo / "blobs" / "keep").write_bytes(b"keep")
    model_lock = cache / ".locks" / "models--Systran--faster-whisper-small" / "model.lock"
    sibling_lock = cache / ".locks" / "models--someone--other-model" / "keep.lock"
    model_lock.parent.mkdir(parents=True)
    sibling_lock.parent.mkdir(parents=True)
    model_lock.write_bytes(b"partial lock")
    sibling_lock.write_bytes(b"keep lock")
    isolated = replace(config, local_model_cache_dir=cache)
    application = create_app(
        isolated, secret_store=MemorySecretStore(), http_client=outbound.client()
    )
    monkeypatch.setattr(
        asr_gateway,
        "load_local_whisper",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(FileNotFoundError("offline miss")),
    )
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=application),
            base_url="http://127.0.0.1:8765",
            headers={"Authorization": f"Bearer {TOKEN}"},
        ) as isolated_client:
            deleted = await isolated_client.request(
                "DELETE",
                "/models/local",
                json={
                    "provider": "local-whisper",
                    "model": "small",
                    "confirmation_model": "small",
                },
            )
            status = await isolated_client.get(
                "/models/local/status",
                params={"provider": "local-whisper", "model": "small"},
            )
    finally:
        application.state.runtime.close()

    assert deleted.status_code == 200
    assert deleted.json()["state"] == "not_installed"
    assert not model_repo.exists()
    assert not model_lock.parent.exists()
    assert (other_repo / "blobs" / "keep").read_bytes() == b"keep"
    assert sibling_lock.read_bytes() == b"keep lock"
    assert status.json()["state"] == "not_installed"


async def test_unsupported_status_exposes_cached_artifacts_and_delete_keeps_blocker(
    config: Any,
    outbound: FakeHttp,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cache = tmp_path / "isolated-hf"
    model_repo = cache / "models--ai-babai--gigachat-audio-mlx"
    (model_repo / "blobs").mkdir(parents=True)
    (model_repo / "blobs" / "partial.incomplete").write_bytes(b"partial")
    application = create_app(
        replace(config, local_model_cache_dir=cache),
        secret_store=MemorySecretStore(),
        http_client=outbound.client(),
    )
    monkeypatch.setattr(
        asr_gateway,
        "gigachat_host_status",
        lambda: local_models.HostStatus(False, "deterministic hardware blocker", 16, 32),
    )
    monkeypatch.setattr(
        asr_gateway,
        "load_local_gigachat",
        lambda **_kwargs: (_ for _ in ()).throw(
            AssertionError("unsupported status/delete must not load the model")
        ),
    )
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=application),
            base_url="http://127.0.0.1:8765",
            headers={"Authorization": f"Bearer {TOKEN}"},
        ) as isolated_client:
            before = await isolated_client.get(
                "/models/local/status",
                params={"provider": GIGACHAT_PROVIDER, "model": GIGACHAT_MODEL_ID},
            )
            deleted = await isolated_client.request(
                "DELETE",
                "/models/local",
                json={
                    "provider": GIGACHAT_PROVIDER,
                    "model": GIGACHAT_MODEL_ID,
                    "confirmation_model": GIGACHAT_MODEL_ID,
                },
            )
    finally:
        application.state.runtime.close()

    assert before.status_code == 200
    assert before.json()["state"] == "unsupported"
    assert before.json()["cached"] is True
    assert deleted.status_code == 200
    assert deleted.json()["state"] == "unsupported"
    assert deleted.json()["cached"] is False
    assert not model_repo.exists()


async def test_dependency_missing_status_still_exposes_cached_artifacts(
    config: Any,
    outbound: FakeHttp,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cache = tmp_path / "isolated-hf"
    model_repo = cache / "models--Systran--faster-whisper-small"
    (model_repo / "blobs").mkdir(parents=True)
    (model_repo / "blobs" / "model.bin").write_bytes(b"cached")
    application = create_app(
        replace(config, local_model_cache_dir=cache),
        secret_store=MemorySecretStore(),
        http_client=outbound.client(),
    )
    monkeypatch.setattr(asr_gateway, "local_asr_available", lambda: False)
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=application),
            base_url="http://127.0.0.1:8765",
            headers={"Authorization": f"Bearer {TOKEN}"},
        ) as isolated_client:
            status = await isolated_client.get(
                "/models/local/status",
                params={"provider": "local-whisper", "model": "small"},
            )
    finally:
        application.state.runtime.close()

    assert status.status_code == 200
    assert status.json()["state"] == "dependency_missing"
    assert status.json()["cached"] is True


async def test_public_status_exposes_real_callback_bytes_without_fake_percentage(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
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

    started = await client.post(
        "/models/local/prepare",
        json={"provider": "local-whisper", "model": "small"},
    )
    await entered.wait()
    status = await client.get(
        "/models/local/status",
        params={"provider": "local-whisper", "model": "small"},
    )
    release.set()
    for _ in range(100):
        terminal = await client.get(
            "/models/local/status",
            params={"provider": "local-whisper", "model": "small"},
        )
        if terminal.json()["state"] == "ready":
            break
        await asyncio.sleep(0.01)
    else:
        raise AssertionError("public local-model status never reached ready")

    assert started.json()["state"] == "installing"
    assert status.json()["state"] == "installing"
    assert status.json()["progress"] == {
        "stage": "downloading",
        "downloaded_bytes": 1_048_576,
        "completed_files": 2,
        "total_bytes": None,
        "total_files": None,
    }


async def test_delete_refuses_cache_tree_with_escaping_symlink(
    config: Any,
    outbound: FakeHttp,
    tmp_path: Path,
) -> None:
    cache = tmp_path / "isolated-hf"
    repo = cache / "models--Systran--faster-whisper-small"
    outside = tmp_path / "must-survive"
    repo.mkdir(parents=True)
    outside.write_text("keep", encoding="utf-8")
    (repo / "escape").symlink_to(outside)
    application = create_app(
        replace(config, local_model_cache_dir=cache),
        secret_store=MemorySecretStore(),
        http_client=outbound.client(),
    )
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=application),
            base_url="http://127.0.0.1:8765",
            headers={"Authorization": f"Bearer {TOKEN}"},
        ) as isolated_client:
            deleted = await isolated_client.request(
                "DELETE",
                "/models/local",
                json={
                    "provider": "local-whisper",
                    "model": "small",
                    "confirmation_model": "small",
                },
            )
    finally:
        application.state.runtime.close()

    assert deleted.status_code == 409
    assert outside.read_text(encoding="utf-8") == "keep"
    assert repo.exists()


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


async def test_delete_is_blocked_while_install_worker_is_active(
    config: Any,
    outbound: FakeHttp,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cache = tmp_path / "isolated-hf"
    partial = cache / "models--Systran--faster-whisper-small" / "blobs" / "partial.incomplete"
    partial.parent.mkdir(parents=True)
    partial.write_bytes(b"partial")
    entered = asyncio.Event()
    release = threading.Event()
    loop = asyncio.get_running_loop()

    def blocking_download(*_args: Any, **_kwargs: Any) -> None:
        loop.call_soon_threadsafe(entered.set)
        release.wait(timeout=5)

    monkeypatch.setattr(asr_gateway, "local_asr_available", lambda: True)
    monkeypatch.setattr(asr_gateway, "download_local_model", blocking_download)
    monkeypatch.setattr(asr_gateway, "load_local_whisper", lambda *_args, **_kwargs: object())
    application = create_app(
        replace(config, local_model_cache_dir=cache),
        secret_store=MemorySecretStore(),
        http_client=outbound.client(),
    )
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=application),
            base_url="http://127.0.0.1:8765",
            headers={"Authorization": f"Bearer {TOKEN}"},
        ) as isolated_client:
            started = await isolated_client.post(
                "/models/local/prepare",
                json={"provider": "local-whisper", "model": "small"},
            )
            await entered.wait()
            conflict = await isolated_client.request(
                "DELETE",
                "/models/local",
                json={
                    "provider": "local-whisper",
                    "model": "small",
                    "confirmation_model": "small",
                },
            )
            assert started.json()["state"] == "installing"
            assert conflict.status_code == 409
            assert partial.read_bytes() == b"partial"
    finally:
        release.set()
        application.state.runtime.close()


async def test_delete_permission_error_is_visible_without_leaking_cache_path(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        asr_gateway,
        "delete_local_model_cache",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            PermissionError("/Users/private/.cache/huggingface/token")
        ),
    )

    response = await client.request(
        "DELETE",
        "/models/local",
        json={
            "provider": "local-whisper",
            "model": "small",
            "confirmation_model": "small",
        },
    )

    assert response.status_code == 409
    assert "permissions" in response.json()["detail"]
    assert "/Users/private" not in response.text


async def test_partial_delete_failure_invalidates_ready_before_next_public_status(
    config: Any,
    outbound: FakeHttp,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cache = tmp_path / "isolated-hf"
    repo = cache / "models--Systran--faster-whisper-small"
    lock_repo = cache / ".locks" / "models--Systran--faster-whisper-small"
    (repo / "blobs").mkdir(parents=True)
    (repo / "blobs" / "model.bin").write_bytes(b"cached")
    lock_repo.mkdir(parents=True)
    (lock_repo / "model.lock").write_bytes(b"locked")
    loader_calls = 0

    def offline_loader(*_args: Any, **_kwargs: Any) -> object:
        nonlocal loader_calls
        loader_calls += 1
        if repo.exists():
            return object()
        raise FileNotFoundError("offline miss after partial deletion")

    real_rmtree = local_models.shutil.rmtree

    def remove_repo_then_fail_on_locks(path: Path, *args: Any, **kwargs: Any) -> None:
        target = Path(path)
        if target == repo:
            real_rmtree(target, *args, **kwargs)
            return
        if target == lock_repo:
            raise OSError("/Users/private/.cache/huggingface/lock cleanup failed")
        raise AssertionError(f"unexpected deletion target: {target.name}")

    monkeypatch.setattr(asr_gateway, "local_asr_available", lambda: True)
    monkeypatch.setattr(asr_gateway, "load_local_whisper", offline_loader)
    application = create_app(
        replace(config, local_model_cache_dir=cache),
        secret_store=MemorySecretStore(),
        http_client=outbound.client(),
    )
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=application),
            base_url="http://127.0.0.1:8765",
            headers={"Authorization": f"Bearer {TOKEN}"},
        ) as isolated_client:
            ready = await isolated_client.get(
                "/models/local/status",
                params={"provider": "local-whisper", "model": "small"},
            )
            monkeypatch.setattr(local_models.shutil, "rmtree", remove_repo_then_fail_on_locks)
            failed = await isolated_client.request(
                "DELETE",
                "/models/local",
                json={
                    "provider": "local-whisper",
                    "model": "small",
                    "confirmation_model": "small",
                },
            )
            status = await isolated_client.get(
                "/models/local/status",
                params={"provider": "local-whisper", "model": "small"},
            )
    finally:
        application.state.runtime.close()

    assert ready.status_code == 200
    assert ready.json()["state"] == "ready"
    assert failed.status_code == 409
    assert "permissions" in failed.json()["detail"]
    assert "/Users/private" not in failed.text
    assert not repo.exists()
    assert lock_repo.exists()
    assert status.status_code == 200
    assert status.json()["state"] == "not_installed"
    assert loader_calls == 2


async def test_delete_rejects_worker_inference_after_request_cancellation(
    client: httpx.AsyncClient, app: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    entered = asyncio.Event()
    release = threading.Event()

    class BlockingTranscriber:
        provider = "local-whisper"
        model = "small"
        can_verify_asr = True

        async def transcribe(self, *_args: Any, **_kwargs: Any) -> list[Any]:
            entered.set()
            await asr_gateway._to_thread_until_finished(release.wait)
            return []

    runtime = app.state.runtime
    monkeypatch.setattr(
        asr_gateway,
        "delete_local_model_cache",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("busy deletion must never reach any filesystem cache")
        ),
    )
    monkeypatch.setattr(
        runtime.ingestion,
        "_transcriber",
        lambda: asyncio.sleep(0, result=BlockingTranscriber()),
    )
    session = (await client.post("/sessions", json={"title": "busy"})).json()
    upload = asyncio.create_task(
        client.post(
            f"/sessions/{session['id']}/audio",
            params={"sequence": 0, "start_ms": 0, "end_ms": 1000},
            content=make_wav(1.0),
            headers={"Content-Type": "audio/wav"},
        )
    )
    await entered.wait()
    upload.cancel()
    await asyncio.sleep(0)

    conflict = await client.request(
        "DELETE",
        "/models/local",
        json={
            "provider": "local-whisper",
            "model": "small",
            "confirmation_model": "small",
        },
    )
    release.set()
    with suppress(asyncio.CancelledError):
        await upload

    assert conflict.status_code == 409


async def test_cancelled_delete_keeps_guard_until_worker_finishes_and_rechecks_status(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    entered = asyncio.Event()
    release = threading.Event()
    loop = asyncio.get_running_loop()

    monkeypatch.setattr(asr_gateway, "local_asr_available", lambda: True)
    monkeypatch.setattr(asr_gateway, "load_local_whisper", lambda *_args, **_kwargs: object())
    ready = await client.get(
        "/models/local/status",
        params={"provider": "local-whisper", "model": "small"},
    )
    assert ready.json()["state"] == "ready"

    def blocking_delete(*_args: Any, **_kwargs: Any) -> local_models.DeleteResult:
        loop.call_soon_threadsafe(entered.set)
        release.wait(timeout=5)
        return local_models.DeleteResult(True, 123, 1)

    monkeypatch.setattr(asr_gateway, "delete_local_model_cache", blocking_delete)
    deleting = asyncio.create_task(
        client.request(
            "DELETE",
            "/models/local",
            json={
                "provider": "local-whisper",
                "model": "small",
                "confirmation_model": "small",
            },
        )
    )
    await entered.wait()
    deleting.cancel()
    await asyncio.sleep(0)

    conflict = await client.post(
        "/models/local/prepare",
        json={"provider": "local-whisper", "model": "small"},
    )
    assert conflict.status_code == 409

    release.set()
    with suppress(asyncio.CancelledError):
        await deleting
    monkeypatch.setattr(
        asr_gateway,
        "load_local_whisper",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(FileNotFoundError("offline miss")),
    )
    status = await client.get(
        "/models/local/status",
        params={"provider": "local-whisper", "model": "small"},
    )
    assert status.json()["state"] == "not_installed"


async def test_status_during_delete_is_blocked_without_starting_an_offline_loader(
    config: Any,
    outbound: FakeHttp,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cache = tmp_path / "isolated-hf"
    entered = asyncio.Event()
    release = threading.Event()
    loop = asyncio.get_running_loop()
    loader_calls = 0

    def blocking_delete(*_args: Any, **_kwargs: Any) -> local_models.DeleteResult:
        loop.call_soon_threadsafe(entered.set)
        release.wait(timeout=5)
        return local_models.DeleteResult(False, 0, 0)

    def offline_loader(*_args: Any, **_kwargs: Any) -> object:
        nonlocal loader_calls
        loader_calls += 1
        raise FileNotFoundError("offline miss")

    monkeypatch.setattr(asr_gateway, "local_asr_available", lambda: True)
    monkeypatch.setattr(asr_gateway, "delete_local_model_cache", blocking_delete)
    monkeypatch.setattr(asr_gateway, "load_local_whisper", offline_loader)
    application = create_app(
        replace(config, local_model_cache_dir=cache),
        secret_store=MemorySecretStore(),
        http_client=outbound.client(),
    )
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=application),
            base_url="http://127.0.0.1:8765",
            headers={"Authorization": f"Bearer {TOKEN}"},
        ) as isolated_client:
            deleting = asyncio.create_task(
                isolated_client.request(
                    "DELETE",
                    "/models/local",
                    json={
                        "provider": "local-whisper",
                        "model": "small",
                        "confirmation_model": "small",
                    },
                )
            )
            await entered.wait()
            status = await isolated_client.get(
                "/models/local/status",
                params={"provider": "local-whisper", "model": "small"},
            )
            calls_while_deleting = loader_calls
            release.set()
            await deleting
    finally:
        release.set()
        application.state.runtime.close()

    assert status.status_code == 409
    assert calls_while_deleting == 0


async def test_status_during_first_active_use_is_blocked_without_loading_a_second_engine(
    config: Any,
    outbound: FakeHttp,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    loader_calls = 0

    def offline_loader(*_args: Any, **_kwargs: Any) -> object:
        nonlocal loader_calls
        loader_calls += 1
        raise FileNotFoundError("offline miss")

    monkeypatch.setattr(asr_gateway, "local_asr_available", lambda: True)
    monkeypatch.setattr(asr_gateway, "load_local_whisper", offline_loader)
    application = create_app(
        replace(config, local_model_cache_dir=tmp_path / "isolated-hf"),
        secret_store=MemorySecretStore(),
        http_client=outbound.client(),
    )
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=application),
            base_url="http://127.0.0.1:8765",
            headers={"Authorization": f"Bearer {TOKEN}"},
        ) as isolated_client:
            initial = await isolated_client.get(
                "/models/local/status",
                params={"provider": "local-whisper", "model": "small"},
            )
            async with application.state.runtime.local_models.use("local-whisper", "small"):
                status = await isolated_client.get(
                    "/models/local/status",
                    params={"provider": "local-whisper", "model": "small"},
                )
    finally:
        application.state.runtime.close()

    assert initial.json()["state"] == "not_installed"
    assert status.status_code == 409
    assert loader_calls == 1


async def test_status_replaces_stale_absent_report_from_an_existing_cached_engine(
    config: Any,
    outbound: FakeHttp,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cache = tmp_path / "isolated-hf"
    loader_calls = 0

    def offline_loader(*_args: Any, **_kwargs: Any) -> object:
        nonlocal loader_calls
        loader_calls += 1
        raise FileNotFoundError("offline miss")

    monkeypatch.setattr(asr_gateway, "local_asr_available", lambda: True)
    monkeypatch.setattr(asr_gateway, "load_local_whisper", offline_loader)
    monkeypatch.setattr(asr_gateway.LocalWhisperTranscriber, "_models", {})
    application = create_app(
        replace(config, local_model_cache_dir=cache),
        secret_store=MemorySecretStore(),
        http_client=outbound.client(),
    )
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=application),
            base_url="http://127.0.0.1:8765",
            headers={"Authorization": f"Bearer {TOKEN}"},
        ) as isolated_client:
            initial = await isolated_client.get(
                "/models/local/status",
                params={"provider": "local-whisper", "model": "small"},
            )
            asr_gateway.LocalWhisperTranscriber._models[("small", False, str(cache))] = object()
            reused = await isolated_client.get(
                "/models/local/status",
                params={"provider": "local-whisper", "model": "small"},
            )
    finally:
        application.state.runtime.close()

    assert initial.json()["state"] == "not_installed"
    assert reused.json()["state"] == "ready"
    assert loader_calls == 1


async def test_status_reuses_cached_gigachat_engine_without_loading_another_copy(
    config: Any,
    outbound: FakeHttp,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cache = tmp_path / "isolated-hf"
    model_repo = cache / "models--ai-babai--gigachat-audio-mlx"
    model_repo.mkdir(parents=True)
    monkeypatch.setattr(
        asr_gateway,
        "gigachat_host_status",
        lambda: local_models.HostStatus(True, None, 64, 32),
    )
    monkeypatch.setattr(asr_gateway, "gigachat_runtime_available", lambda: True)
    monkeypatch.setattr(
        asr_gateway,
        "load_local_gigachat",
        lambda **_kwargs: (_ for _ in ()).throw(
            AssertionError("status must reuse the already-loaded GigaChat engine")
        ),
    )
    monkeypatch.setattr(asr_gateway.LocalGigaChatTranscriber, "_models", {str(cache): object()})
    application = create_app(
        replace(config, local_model_cache_dir=cache),
        secret_store=MemorySecretStore(),
        http_client=outbound.client(),
    )
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=application),
            base_url="http://127.0.0.1:8765",
            headers={"Authorization": f"Bearer {TOKEN}"},
        ) as isolated_client:
            status = await isolated_client.get(
                "/models/local/status",
                params={"provider": GIGACHAT_PROVIDER, "model": GIGACHAT_MODEL_ID},
            )
    finally:
        application.state.runtime.close()

    assert status.status_code == 200
    assert status.json()["state"] == "ready"
    assert status.json()["cached"] is True


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
