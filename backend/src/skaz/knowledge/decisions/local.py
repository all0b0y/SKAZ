"""The local decision layer: a pinned ``llama-server`` build and a pinned GGUF model, on this Mac only.

Nothing is downloaded until the user asks (``download``). Files go to
``<data_dir>/decisions/``: ``downloads/*.part`` while in flight (kept on cancel
or network loss so the next attempt resumes), ``bin/<build>/`` for the
unpacked server, ``models/<file>.gguf`` for the model. Every file is checked
against its pinned SHA-256 before use; a mismatch is deleted.

The server runs on ``127.0.0.1`` on a random free port with a per-launch API
key, starts on the first question, stops after ``idle_s`` without questions
and when the app closes. States are shown to the user as is:
``not_downloaded | downloading(progress) | failed(no_space|no_network|checksum|start_failed)
| ready | running``. The local layer never hands a question to the cloud.
"""
from __future__ import annotations

import asyncio
import contextlib
import errno
import hashlib
import os
import secrets
import shutil
import socket
import tarfile
import time
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import httpx

from ...native_io import disk_call
from ..processes import CHILDREN
from .llama import LlamaClient, LocalMode
from .policy import Thresholds, apply_thresholds
from .protocol import Answer, DeciderId, Question, Undecided
from .systemone import DecisionObserver, _primitive

LocalState = Literal["not_downloaded", "downloading", "failed", "ready", "running"]
FailReason = Literal["no_space", "no_network", "checksum", "start_failed"]

#: Extra room kept free beyond the downloads themselves (unpacking, logs, the OS).
SPACE_MARGIN_BYTES = 512 * 1024 * 1024
CHUNK_BYTES = 1024 * 1024
DEFAULT_IDLE_S = 300.0
DEFAULT_START_TIMEOUT_S = 120.0


@dataclass(frozen=True)
class PinnedAsset:
    #: File name on disk (and in the download URL).
    name: str
    url: str
    sha256: str
    size: int


@dataclass(frozen=True)
class ServerBuild:
    build: str
    archive: PinnedAsset
    #: Path of the executable inside the archive.
    executable: str
    license: str


@dataclass(frozen=True)
class LocalModel:
    id: str
    title: str
    license: str
    homepage: str
    asset: PinnedAsset
    mode: LocalMode
    thresholds: Thresholds
    context: int


#: llama.cpp release b11624 (2026-10-14), macOS arm64 with Metal. MIT.
LLAMA_SERVER = ServerBuild(
    build="b11624",
    archive=PinnedAsset(
        name="llama-b11624-bin-macos-arm64.tar.gz",
        url="https://github.com/ggml-org/llama.cpp/releases/download/b11624/llama-b11624-bin-macos-arm64.tar.gz",
        sha256="5bd8555c20e5d6d45831c038f484769245e5bcc1c265c4911c6ae15e4d9a35df",
        size=12_166_187,
    ),
    executable="llama-b11624/llama-server",
    license="MIT",
)

#: Chosen by ``scripts/decisions_benchmark.py`` on the authored decision set (D1 spike gate).
#: User decision B9: threshold 0.7 for choice and yes/no. Held-out (80 questions): 100% correct
#: on answered at 91% coverage; at 0.5 it was 96% at 96%, and every wrong answer had p < 0.57.
#: A wrong merge damages the wiki for good, so the doubtful 9% go to the writing model.
#: The score threshold is not measured (no score questions in the set).
LOCAL_MODEL = LocalModel(
    id="qwen3.5-4b-q4_k_m",
    title="Qwen3.5 4B (Q4_K_M)",
    license="Apache-2.0",
    homepage="https://huggingface.co/Qwen/Qwen3.5-4B",
    asset=PinnedAsset(
        name="Qwen3.5-4B-Q4_K_M.gguf",
        url="https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf",
        sha256="00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4",
        size=2_740_937_888,
    ),
    mode="labels",
    thresholds=Thresholds(choice=0.7, noul=0.7, score=0.5),
    context=8192,
)

FAIL_MESSAGES: dict[FailReason, str] = {
    "no_space": "Not enough free disk space for the local decision model.",
    "no_network": "The download stopped: SKAZ couldn't reach the download server.",
    "checksum": "The downloaded file was damaged (checksum mismatch) and was deleted.",
    "start_failed": "The local decision model couldn't start.",
}


class LocalUnavailable(Exception):
    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


@dataclass(frozen=True)
class LocalStatus:
    state: LocalState
    #: 0..1 while downloading (bytes of both files); ``None`` otherwise.
    progress: float | None
    downloaded_bytes: int
    total_bytes: int
    reason: FailReason | None
    message: str | None
    #: Bytes the download still needs on disk (0 when everything is in place).
    required_bytes: int


#: Starts the server process: ``(argv, env, log file) -> process``. Tests substitute a fake server.
Launcher = Callable[[Sequence[str], dict[str, str], Path], Awaitable[asyncio.subprocess.Process]]


async def _default_launch(argv: Sequence[str], env: dict[str, str], log: Path) -> asyncio.subprocess.Process:
    with open(log, "ab") as handle:
        return await asyncio.create_subprocess_exec(
            *argv, stdin=asyncio.subprocess.DEVNULL, stdout=handle, stderr=asyncio.subprocess.STDOUT, env=env,
        )


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(CHUNK_BYTES), b""):
            digest.update(chunk)
    return digest.hexdigest()


class _DownloadFailed(Exception):
    def __init__(self, reason: FailReason, message: str | None = None) -> None:
        super().__init__(reason)
        self.reason: FailReason = reason
        self.message = message or FAIL_MESSAGES[reason]


class LlamaServerManager:
    def __init__(
        self,
        root: Path,
        http: httpx.AsyncClient,
        *,
        model: LocalModel = LOCAL_MODEL,
        server: ServerBuild = LLAMA_SERVER,
        idle_s: float = DEFAULT_IDLE_S,
        start_timeout_s: float = DEFAULT_START_TIMEOUT_S,
        launcher: Launcher | None = None,
        disk_free: Callable[[Path], int] | None = None,
    ) -> None:
        self.root = root
        self.http = http
        self.model = model
        self.server = server
        self.idle_s = idle_s
        self.start_timeout_s = start_timeout_s
        self._launch = launcher or _default_launch
        self._disk_free = disk_free or (lambda path: shutil.disk_usage(path).free)
        self._download_task: asyncio.Task[None] | None = None
        self._downloaded = 0
        self._failure: _DownloadFailed | None = None
        self._process: asyncio.subprocess.Process | None = None
        self._base_url: str | None = None
        self._api_key: str | None = None
        self._idle_task: asyncio.Task[None] | None = None
        self._start_lock = asyncio.Lock()
        self._closed = False

    # -- paths --------------------------------------------------------------

    @property
    def downloads_dir(self) -> Path:
        return self.root / "downloads"

    @property
    def model_path(self) -> Path:
        return self.root / "models" / self.model.asset.name

    @property
    def server_dir(self) -> Path:
        return self.root / "bin" / self.server.build

    @property
    def executable(self) -> Path:
        return self.server_dir / self.server.executable

    def _marker(self, path: Path) -> Path:
        return path.with_name(path.name + ".sha256")

    def _verified(self, path: Path, sha256: str) -> bool:
        marker = self._marker(path)
        try:
            return path.exists() and marker.read_text(encoding="utf-8").strip() == sha256
        except OSError:
            return False

    def _server_installed(self) -> bool:
        return self._verified(self.server_dir, self.server.archive.sha256) and self.executable.is_file()

    def _model_installed(self) -> bool:
        return self._verified(self.model_path, self.model.asset.sha256)

    def installed(self) -> bool:
        return self._server_installed() and self._model_installed()

    def _missing(self) -> list[PinnedAsset]:
        missing: list[PinnedAsset] = []
        if not self._server_installed():
            missing.append(self.server.archive)
        if not self._model_installed():
            missing.append(self.model.asset)
        return missing

    def _partial(self, asset: PinnedAsset) -> Path:
        return self.downloads_dir / f"{asset.name}.part"

    def _partial_size(self, asset: PinnedAsset) -> int:
        try:
            return min(self._partial(asset).stat().st_size, asset.size)
        except OSError:
            return 0

    def _required_bytes(self) -> int:
        missing = self._missing()
        # The archive is unpacked next to itself: count it twice.
        need = sum(asset.size - self._partial_size(asset) for asset in missing)
        if self.server.archive in missing:
            need += self.server.archive.size * 3
        return need

    # -- status -------------------------------------------------------------

    def status(self) -> LocalStatus:
        total = self.server.archive.size + self.model.asset.size
        if self._download_task is not None and not self._download_task.done():
            done = min(self._downloaded, total)
            return LocalStatus("downloading", done / total, done, total, None, None, self._required_bytes())
        if self._failure is not None:
            return LocalStatus("failed", None, self._present_bytes(), total, self._failure.reason,
                               self._failure.message, self._required_bytes())
        if not self.installed():
            return LocalStatus("not_downloaded", None, self._present_bytes(), total, None, None,
                               self._required_bytes())
        if self.running:
            return LocalStatus("running", None, total, total, None, None, 0)
        return LocalStatus("ready", None, total, total, None, None, 0)

    def _present_bytes(self) -> int:
        present = 0
        for asset, installed in ((self.server.archive, self._server_installed()),
                                 (self.model.asset, self._model_installed())):
            present += asset.size if installed else self._partial_size(asset)
        return present

    @property
    def running(self) -> bool:
        return self._process is not None and self._process.returncode is None and self._base_url is not None

    # -- download -----------------------------------------------------------

    def download(self) -> LocalStatus:
        """Start (or resume) the download in the background; a running download is left alone."""
        if self._closed:
            raise LocalUnavailable("SKAZ is shutting down.")
        if self._download_task is not None and not self._download_task.done():
            return self.status()
        if self.installed():
            self._failure = None
            return self.status()
        self._failure = None
        self._downloaded = self._present_bytes()
        self._download_task = asyncio.create_task(self._download_all(), name="decisions-download")
        return self.status()

    async def wait_download(self) -> LocalStatus:
        task = self._download_task
        if task is not None:
            with contextlib.suppress(asyncio.CancelledError):
                await task
        return self.status()

    async def cancel(self) -> LocalStatus:
        """Stop the download; what was fetched stays for the next attempt."""
        task = self._download_task
        if task is not None and not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        self._failure = None
        return self.status()

    async def delete(self) -> LocalStatus:
        """Stop the server, cancel the download and remove every downloaded file."""
        await self.cancel()
        await self.stop()
        await disk_call(shutil.rmtree, self.root, True)
        self._failure = None
        self._downloaded = 0
        return self.status()

    async def _download_all(self) -> None:
        try:
            await disk_call(self.downloads_dir.mkdir, parents=True, exist_ok=True)
            need = self._required_bytes()
            free = await disk_call(self._disk_free, self.root)
            if free < need + SPACE_MARGIN_BYTES:
                raise _DownloadFailed("no_space", (
                    f"Not enough free disk space for the local decision model: "
                    f"{_gigabytes(need + SPACE_MARGIN_BYTES)} needed, {_gigabytes(free)} free."))
            for asset in self._missing():
                await self._fetch(asset)
                if asset is self.server.archive:
                    await disk_call(self._unpack_server)
                else:
                    await disk_call(self._install_model)
        except _DownloadFailed as failure:
            self._failure = failure
        except tarfile.TarError:
            await disk_call(self._partial(self.server.archive).unlink, True)
            self._failure = _DownloadFailed("checksum", "The downloaded llama-server package is unreadable.")
        except OSError as error:
            if error.errno == errno.ENOSPC:
                self._failure = _DownloadFailed("no_space")
            else:
                self._failure = _DownloadFailed(
                    "no_network", f"SKAZ couldn't save the download: {error.strerror or error}.")

    async def _fetch(self, asset: PinnedAsset) -> None:
        partial = self._partial(asset)
        have = self._partial_size(asset)
        if have >= asset.size:
            await self._check(asset, partial)
            return
        headers = {"Range": f"bytes={have}-"} if have else {}
        try:
            async with self.http.stream("GET", asset.url, headers=headers, follow_redirects=True,
                                        timeout=httpx.Timeout(30.0, read=60.0)) as response:
                if response.status_code == 200 and have:
                    # The server ignored the range: start over.
                    have = 0
                    self._downloaded = self._present_bytes() - self._partial_size(asset)
                elif response.status_code not in (200, 206):
                    raise _DownloadFailed("no_network", (
                        f"The download server answered HTTP {response.status_code}. Try again later."))
                mode = "ab" if have else "wb"
                handle = await disk_call(open, partial, mode)
                try:
                    async for chunk in response.aiter_bytes(CHUNK_BYTES):
                        await disk_call(handle.write, chunk)
                        have += len(chunk)
                        self._downloaded += len(chunk)
                        if have > asset.size:
                            break
                finally:
                    await disk_call(handle.close)
        except httpx.HTTPError as error:
            raise _DownloadFailed("no_network") from error
        await self._check(asset, partial)

    async def _check(self, asset: PinnedAsset, partial: Path) -> None:
        digest = await disk_call(sha256_file, partial)
        if digest != asset.sha256:
            await disk_call(partial.unlink, True)
            self._downloaded = self._present_bytes()
            raise _DownloadFailed("checksum")

    def _install_model(self) -> None:
        self.model_path.parent.mkdir(parents=True, exist_ok=True)
        os.replace(self._partial(self.model.asset), self.model_path)
        self._marker(self.model_path).write_text(self.model.asset.sha256, encoding="utf-8")

    def _unpack_server(self) -> None:
        archive = self._partial(self.server.archive)
        target = self.server_dir
        staging = target.with_name(target.name + ".unpacking")
        shutil.rmtree(staging, ignore_errors=True)
        staging.mkdir(parents=True)
        with tarfile.open(archive, "r:gz") as bundle:
            # ``data`` filter: no absolute paths, no escaping links, no device files.
            bundle.extractall(staging, filter="data")
        executable = staging / self.server.executable
        if not executable.is_file():
            shutil.rmtree(staging, ignore_errors=True)
            raise _DownloadFailed("checksum", "The downloaded llama-server package has an unexpected layout.")
        executable.chmod(0o755)
        shutil.rmtree(target, ignore_errors=True)
        os.replace(staging, target)
        self._marker(target).write_text(self.server.archive.sha256, encoding="utf-8")
        archive.unlink(missing_ok=True)

    # -- server -------------------------------------------------------------

    async def ensure_running(self) -> tuple[str, str]:
        """``(base_url, api_key)`` of a healthy server, starting it if needed."""
        if self._closed:
            raise LocalUnavailable("SKAZ is shutting down.")
        async with self._start_lock:
            if self.running and self._base_url and self._api_key:
                return self._base_url, self._api_key
            status = self.status()
            if status.state == "downloading":
                raise LocalUnavailable("The local decision model is still downloading.")
            if not self.installed():
                raise LocalUnavailable("The local decision model isn't downloaded. Download it in Settings.")
            await self._start()
            assert self._base_url is not None and self._api_key is not None
            return self._base_url, self._api_key

    async def _start(self) -> None:
        port = free_port()
        api_key = secrets.token_urlsafe(24)
        argv = [str(self.executable), "-m", str(self.model_path), "--host", "127.0.0.1", "--port", str(port),
                "--no-webui", "-np", "1", "-c", str(self.model.context)]
        env = {key: value for key, value in os.environ.items() if not key.startswith("LLAMA_")}
        env["LLAMA_ARG_API_KEY"] = api_key
        log = self.root / "llama-server.log"
        self._failure = None
        try:
            process = await self._launch(argv, env, log)
        except OSError as error:
            self._failure = _DownloadFailed("start_failed",
                                            f"The local decision model couldn't start: {error}.")
            raise LocalUnavailable(self._failure.message) from error
        # Registered from launch on: quitting while the model still loads must stop it too.
        CHILDREN.add(process, group=False)
        base = f"http://127.0.0.1:{port}"
        deadline = time.monotonic() + self.start_timeout_s
        while True:
            if process.returncode is not None:
                break
            try:
                if (await self.http.get(f"{base}/health", timeout=2.0)).status_code == 200:
                    self._process, self._base_url, self._api_key = process, base, api_key
                    self.touch()
                    return
            except httpx.HTTPError:
                pass
            if time.monotonic() > deadline:
                break
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(process.wait(), timeout=0.25)
        await _terminate(process)
        self._failure = _DownloadFailed("start_failed")
        raise LocalUnavailable(FAIL_MESSAGES["start_failed"])

    def touch(self) -> None:
        """Restart the idle timer after a question."""
        if self._idle_task is not None:
            self._idle_task.cancel()
        if self.running and self.idle_s > 0:
            self._idle_task = asyncio.create_task(self._stop_when_idle(), name="decisions-idle")

    async def _stop_when_idle(self) -> None:
        await asyncio.sleep(self.idle_s)
        self._idle_task = None
        await self.stop()

    async def stop(self) -> None:
        idle, self._idle_task = self._idle_task, None
        if idle is not None and idle is not asyncio.current_task():
            idle.cancel()
        process, self._process, self._base_url, self._api_key = self._process, None, None, None
        if process is not None:
            await _terminate(process)

    async def aclose(self) -> None:
        """App shutdown: cancel the download and stop the server."""
        self._closed = True
        await self.cancel()
        await self.stop()

    def kill_now(self) -> None:
        """Kill a still-running server without awaiting (synchronous shutdown paths)."""
        self._closed = True
        if self._download_task is not None and not self._download_task.done():
            self._download_task.cancel()
        if self._idle_task is not None:
            self._idle_task.cancel()
            self._idle_task = None
        process, self._process, self._base_url, self._api_key = self._process, None, None, None
        if process is not None and process.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                process.kill()


async def _terminate(process: asyncio.subprocess.Process) -> None:
    try:
        if process.returncode is not None:
            return
        with contextlib.suppress(ProcessLookupError):
            process.terminate()
        try:
            await asyncio.wait_for(process.wait(), timeout=5.0)
        except TimeoutError:
            with contextlib.suppress(ProcessLookupError):
                process.kill()
            await process.wait()
    finally:
        CHILDREN.discard(process)


def _gigabytes(value: int) -> str:
    return f"{value / 1_000_000_000:.1f} GB"


class LocalDecider:
    """``DecisionLayer`` over the local server. Undecided when the model isn't there — never the cloud."""

    def __init__(self, manager: LlamaServerManager, client: LlamaClient, *,
                 observer: DecisionObserver | None = None) -> None:
        self.manager = manager
        self.client = client
        self._observer = observer

    @property
    def id(self) -> DeciderId:
        return "local"

    async def ask(self, question: Question) -> Answer:
        return (await self.ask_many([question]))[0]

    async def ask_many(self, questions: Sequence[Question]) -> Sequence[Answer]:
        started = time.monotonic()
        try:
            base_url, api_key = await self.manager.ensure_running()
        except LocalUnavailable as error:
            answers: list[Answer] = [Undecided(error.message) for _ in questions]
        else:
            raw = await self.client.answer(base_url, questions, mode=self.manager.model.mode, api_key=api_key)
            self.manager.touch()
            thresholds = self.manager.model.thresholds
            answers = [apply_thresholds(question, answer, thresholds)
                       for question, answer in zip(questions, raw, strict=True)]
        if self._observer is not None:
            elapsed = int((time.monotonic() - started) * 1000)
            for question, answer in zip(questions, answers, strict=True):
                self._observer(self.id, _primitive(question), answer, elapsed)
        return answers
