"""QA E18: ``SKAZ_ALLOW_MODEL_DOWNLOAD=0`` refuses every model download, the decision model's too.

The isolated smokes and QA harness set it so a run never pulls gigabytes; the 2.7 GB
decision model used to start downloading anyway.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

import httpx
import pytest

from skaz.gateways.asr import LocalModelPreparations
from skaz.knowledge.decisions.local import LlamaServerManager, LocalUnavailable
from skaz.local_models import MODEL_DOWNLOADS_OFF, model_downloads_refused


def refuse_everything(request: httpx.Request) -> httpx.Response:
    raise AssertionError(f"no network expected: {request.url}")


def test_env_switch(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("SKAZ_ALLOW_MODEL_DOWNLOAD", raising=False)
    assert not model_downloads_refused()
    monkeypatch.setenv("SKAZ_ALLOW_MODEL_DOWNLOAD", "1")
    assert not model_downloads_refused()
    monkeypatch.setenv("SKAZ_ALLOW_MODEL_DOWNLOAD", "0")
    assert model_downloads_refused()


async def test_decision_model_download_is_refused(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("SKAZ_ALLOW_MODEL_DOWNLOAD", "0")
    async with httpx.AsyncClient(transport=httpx.MockTransport(refuse_everything)) as http:
        manager = LlamaServerManager(tmp_path / "decisions", http)
        with pytest.raises(LocalUnavailable, match="SKAZ_ALLOW_MODEL_DOWNLOAD=0"):
            manager.download()
        assert manager.status().state == "not_downloaded"
        assert not manager.downloads_dir.exists() or not any(manager.downloads_dir.iterdir())


async def test_api_answers_503_and_starts_nothing(monkeypatch: pytest.MonkeyPatch,
                                                  kb_client: httpx.AsyncClient) -> None:
    monkeypatch.setenv("SKAZ_ALLOW_MODEL_DOWNLOAD", "0")
    response = await kb_client.post("/kb/decisions/local/download")
    assert response.status_code == 503
    assert response.json()["detail"] == MODEL_DOWNLOADS_OFF
    state: Any = (await kb_client.get("/kb/decisions")).json()
    assert "downloading" not in str(state)


async def test_whisper_preparation_is_refused_too(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("SKAZ_ALLOW_MODEL_DOWNLOAD", "0")
    preparations = LocalModelPreparations(tmp_path)
    try:
        report = await preparations.start("small", "local-whisper")
        assert report == ("error", MODEL_DOWNLOADS_OFF)
        assert preparations.progress("local-whisper", "small") is None
    finally:
        preparations.close()
