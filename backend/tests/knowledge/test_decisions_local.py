"""Local decision layer: pinned downloads (progress, cancel/resume, checksum, space, network) and the server.

Downloads go through a fake HTTP transport; the "llama-server" is a real local
process (``fixtures/decisions/fake_llama_server.py``) packed into a tar.gz like
the release archive. Neither is evidence of a real model's quality.
"""
from __future__ import annotations

import asyncio
import hashlib
import io
import json
import os
import sys
import tarfile
import time
from collections.abc import AsyncIterator, Callable
from pathlib import Path
from typing import Any

import httpx
import pytest
from starlette.testclient import TestClient

from skaz.app import create_app
from skaz.config import AppConfig
from skaz.knowledge.decisions.llama import LlamaClient
from skaz.knowledge.decisions.local import (
    LOCAL_MODEL,
    LlamaServerManager,
    LocalDecider,
    LocalModel,
    PinnedAsset,
    ServerBuild,
)
from skaz.knowledge.decisions.policy import Thresholds
from skaz.knowledge.decisions.protocol import ChoiceAnswer, ChoiceQuestion, Undecided, YesNoQuestion
from skaz.secrets import MemorySecretStore
from tests.conftest import TOKEN

FAKE_SERVER = Path(__file__).parent / "fixtures" / "decisions" / "fake_llama_server.py"
ARCHIVE_URL = "https://downloads.test/llama-test.tar.gz"
MODEL_URL = "https://models.test/decider.gguf"
MB = 1024 * 1024
QUESTION = ChoiceQuestion("<untrusted-data>x</untrusted-data>", "Which page?",
                          ("Ohm's law", "Photosynthesis"))


def server_archive() -> bytes:
    script = (f"#!{sys.executable}\nimport runpy\n"
              f"runpy.run_path({str(FAKE_SERVER)!r}, run_name='__main__')\n").encode()
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as bundle:
        files = (("llama-test/llama-server", script, 0o755), ("llama-test/LICENSE", b"MIT", 0o644))
        for name, data, mode in files:
            info = tarfile.TarInfo(name)
            info.size, info.mode = len(data), mode
            bundle.addfile(info, io.BytesIO(data))
    return buffer.getvalue()


ARCHIVE = server_archive()
MODEL_BYTES = b"GGUF" + bytes(range(256)) * (10 * MB // 256)


def asset(name: str, url: str, data: bytes, *, sha: str | None = None) -> PinnedAsset:
    return PinnedAsset(name=name, url=url, sha256=sha or hashlib.sha256(data).hexdigest(), size=len(data))


SERVER = ServerBuild(build="b-test", archive=asset("llama-test.tar.gz", ARCHIVE_URL, ARCHIVE),
                     executable="llama-test/llama-server", license="MIT")


def model(*, sha: str | None = None) -> LocalModel:
    return LocalModel(id="test-model", title="Test model", license="Apache-2.0", homepage="https://models.test",
                      asset=asset("decider.gguf", MODEL_URL, MODEL_BYTES, sha=sha), mode="labels",
                      thresholds=Thresholds(choice=0.6, noul=0.6, score=0.5), context=512)


class Gate(httpx.AsyncByteStream):
    """Streams ``data`` in 512 KiB pieces; stops before ``pause_at`` bytes until ``release`` is set."""

    def __init__(self, data: bytes, pause_at: int | None, release: asyncio.Event | None) -> None:
        self.data, self.pause_at, self.release = data, pause_at, release

    async def __aiter__(self) -> AsyncIterator[bytes]:
        sent = 0
        step = 512 * 1024
        while sent < len(self.data):
            if self.pause_at is not None and self.release is not None and sent >= self.pause_at:
                await self.release.wait()
            yield self.data[sent:sent + step]
            sent += step


class Downloads:
    """Fake download hosts (Range-aware) in front of the real localhost transport."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.pause_at: int | None = None
        self.release: asyncio.Event | None = None
        self.fail_model = False
        self.ignore_range = False

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        data = {ARCHIVE_URL: ARCHIVE, MODEL_URL: MODEL_BYTES}.get(str(request.url))
        if data is None:
            return httpx.Response(404)
        if data is MODEL_BYTES and self.fail_model:
            raise httpx.ConnectError("offline", request=request)
        start = 0
        header = request.headers.get("Range")
        if header and not self.ignore_range:
            start = int(header.removeprefix("bytes=").rstrip("-"))
        body = data[start:]
        pause = None if self.pause_at is None or data is not MODEL_BYTES else self.pause_at - start
        return httpx.Response(206 if start else 200, stream=Gate(body, pause, self.release))


class Routed(httpx.AsyncBaseTransport):
    def __init__(self, downloads: Downloads) -> None:
        self.real = httpx.AsyncHTTPTransport()
        self.fake = httpx.MockTransport(downloads.handle)

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        if request.url.host == "127.0.0.1":
            return await self.real.handle_async_request(request)
        return await self.fake.handle_async_request(request)


def manager(tmp_path: Path, downloads: Downloads, *, free: int = 10**12, idle_s: float = 300.0,
            local_model: LocalModel | None = None) -> LlamaServerManager:
    http = httpx.AsyncClient(transport=Routed(downloads))
    return LlamaServerManager(tmp_path / "decisions", http, model=local_model or model(), server=SERVER,
                              idle_s=idle_s, start_timeout_s=20.0, disk_free=lambda _path: free)


async def until(predicate: Callable[[], bool], timeout: float = 10.0) -> None:
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() > deadline:
            raise AssertionError("condition not reached")
        await asyncio.sleep(0.01)


async def test_download_progress_cancel_resume_and_checksum(tmp_path: Path) -> None:
    downloads = Downloads()
    downloads.pause_at, downloads.release = 3 * MB, asyncio.Event()
    local = manager(tmp_path, downloads)
    assert local.status().state == "not_downloaded"
    assert local.status().required_bytes > len(MODEL_BYTES)

    assert local.download().state == "downloading"
    await until(lambda: local.status().downloaded_bytes >= len(ARCHIVE) + 2 * MB)
    status = local.status()
    assert status.state == "downloading" and status.progress is not None and 0 < status.progress < 1
    assert status.total_bytes == len(ARCHIVE) + len(MODEL_BYTES)

    cancelled = await local.cancel()
    assert cancelled.state == "not_downloaded" and cancelled.reason is None
    partial = local.downloads_dir / "decider.gguf.part"
    kept = partial.stat().st_size
    assert kept >= 2 * MB and local.executable.is_file()  # the server archive finished and was unpacked
    assert not (local.downloads_dir / "llama-test.tar.gz.part").exists()

    downloads.release.set()
    local.download()
    assert (await local.wait_download()).state == "ready"
    assert downloads.requests[-1].headers["Range"] == f"bytes={kept}-"
    assert local.model_path.read_bytes() == MODEL_BYTES and not partial.exists()
    assert os.access(local.executable, os.X_OK)
    assert [str(r.url) for r in downloads.requests].count(ARCHIVE_URL) == 1


async def test_checksum_mismatch_deletes_the_file(tmp_path: Path) -> None:
    local = manager(tmp_path, Downloads(), local_model=model(sha="0" * 64))
    local.download()
    status = await local.wait_download()
    assert (status.state, status.reason) == ("failed", "checksum")
    assert status.message == "The downloaded file was damaged (checksum mismatch) and was deleted."
    assert not (local.downloads_dir / "decider.gguf.part").exists() and not local.model_path.exists()


async def test_no_space_is_checked_before_downloading(tmp_path: Path) -> None:
    downloads = Downloads()
    local = manager(tmp_path, downloads, free=1_000_000)
    local.download()
    status = await local.wait_download()
    assert (status.state, status.reason) == ("failed", "no_space")
    assert status.message is not None and "GB needed" in status.message
    assert downloads.requests == []


async def test_network_loss_fails_then_retry_resumes(tmp_path: Path) -> None:
    downloads = Downloads()
    downloads.fail_model = True
    local = manager(tmp_path, downloads)
    local.download()
    status = await local.wait_download()
    assert (status.state, status.reason) == ("failed", "no_network")
    downloads.fail_model = False
    local.download()
    assert (await local.wait_download()).state == "ready"


async def test_a_server_that_ignores_range_restarts_the_file(tmp_path: Path) -> None:
    downloads = Downloads()
    local = manager(tmp_path, downloads)
    (local.downloads_dir).mkdir(parents=True)
    (local.downloads_dir / "decider.gguf.part").write_bytes(b"stale bytes")
    downloads.ignore_range = True
    local.download()
    assert (await local.wait_download()).state == "ready"
    assert local.model_path.read_bytes() == MODEL_BYTES


async def installed(tmp_path: Path, **kwargs: Any) -> LlamaServerManager:
    local = manager(tmp_path, Downloads(), **kwargs)
    local.download()
    assert (await local.wait_download()).state == "ready"
    return local


async def test_local_decider_starts_the_server_answers_and_stops_when_idle(tmp_path: Path) -> None:
    local = await installed(tmp_path, idle_s=0.3)
    decider = LocalDecider(local, LlamaClient(local.http))
    try:
        answer = await decider.ask(QUESTION)
        assert isinstance(answer, ChoiceAnswer) and answer.option == "Ohm's law"
        assert answer.probabilities["Ohm's law"] == pytest.approx(0.9 / 0.95)
        assert local.status().state == "running"
        process = local._process
        assert process is not None
        await until(lambda: local.status().state == "ready", timeout=5)
        # ``ready`` flips as soon as the stop begins; the process is reaped a moment later (slow under load).
        await until(lambda: process.returncode is not None, timeout=5)
    finally:
        await local.aclose()


async def test_low_probability_from_the_local_model_is_undecided(tmp_path: Path,
                                                                monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FAKE_LLAMA_TOP", json.dumps([["yes", 0.5], ["no", 0.45], ["The", 0.05]]))
    local = await installed(tmp_path)
    try:
        answer = await LocalDecider(local, LlamaClient(local.http)).ask(YesNoQuestion("s", "Same concept?"))
        assert isinstance(answer, Undecided) and answer.reason.startswith("Not confident enough (53% < 60%)")
    finally:
        await local.aclose()


async def test_missing_download_and_failed_start_are_undecided(tmp_path: Path,
                                                               monkeypatch: pytest.MonkeyPatch) -> None:
    empty = manager(tmp_path / "empty", Downloads())
    answer = await LocalDecider(empty, LlamaClient(empty.http)).ask(QUESTION)
    assert answer == Undecided("The local decision model isn't downloaded. Download it in Settings.")

    monkeypatch.setenv("FAKE_LLAMA_EXIT", "1")
    local = await installed(tmp_path)
    answer = await LocalDecider(local, LlamaClient(local.http)).ask(QUESTION)
    assert answer == Undecided("The local decision model couldn't start.")
    status = local.status()
    assert (status.state, status.reason) == ("failed", "start_failed")
    await local.aclose()


async def test_delete_removes_everything(tmp_path: Path) -> None:
    local = await installed(tmp_path)
    await local.ensure_running()
    status = await local.delete()
    assert status.state == "not_downloaded" and status.downloaded_bytes == 0
    assert not local.root.exists() and not local.running


def test_closing_the_app_stops_the_server(tmp_path: Path) -> None:
    documents = tmp_path / "Documents"
    documents.mkdir()
    config = AppConfig(token=TOKEN, data_dir=tmp_path / "data", documents_dir=documents,
                       documents_sandbox=documents)
    downloads = Downloads()
    app = create_app(config, secret_store=MemorySecretStore(),
                     http_client=httpx.AsyncClient(transport=Routed(downloads)))
    service = app.state.runtime.kb_decisions
    service.manager = LlamaServerManager(config.data_dir / "decisions", service.http, model=model(),
                                         server=SERVER, start_timeout_s=20.0, disk_free=lambda _path: 10**12)
    headers = {"Authorization": f"Bearer {TOKEN}"}
    with TestClient(app, base_url="http://127.0.0.1", headers=headers) as client:
        assert client.put("/kb/decisions/provider", json={"provider": "local"}).status_code == 200
        started = client.post("/kb/decisions/local/download")
        assert started.status_code == 202 and started.json()["local"]["state"] in {"downloading", "ready"}
        deadline = time.monotonic() + 20
        while client.get("/kb/decisions").json()["local"]["state"] != "ready":
            assert time.monotonic() < deadline
            time.sleep(0.05)
        checked = client.post("/kb/decisions/test").json()
        assert checked["provider"] == "local" and checked["decided"] is True
        assert checked["answer"].startswith("Electrical resistance")
        assert client.get("/kb/decisions").json()["local"]["state"] == "running"
        process = service.manager._process
        assert process is not None and process.returncode is None
        pid = process.pid
    # The lifespan stopped and reaped the server: the process is gone.
    assert process.returncode is not None
    with pytest.raises(ProcessLookupError):
        os.kill(pid, 0)


def test_product_thresholds_are_the_user_decision_b9() -> None:
    """B9: Qwen3.5-4B at 0.7 — a doubtful choice goes to the writing model rather than a guess."""
    assert LOCAL_MODEL.id == "qwen3.5-4b-q4_k_m"
    assert (LOCAL_MODEL.thresholds.choice, LOCAL_MODEL.thresholds.noul) == (0.7, 0.7)
