"""Allowlisted local-model artifacts, host checks, progress, and cache deletion.

This module owns filesystem/network preparation only.  Inference adapters stay in
``gateways.asr``.  Every model identity and repository path is fixed here; API
input is never interpreted as a repository id or filesystem path.
"""

from __future__ import annotations

import importlib.util
import os
import platform
import shutil
import sys
import threading
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

GIGACHAT_PROVIDER = "local-gigachat-mlx"
GIGACHAT_MODEL_ID = "ai-babai/gigachat-audio-mlx"
GIGACHAT_REVISION = "db430193908ea810d4873404b43a148d5cbe9753"
GIGACHAT_RUNTIME_BYTES = 22_539_048_633
GIB = 1024**3
# Mirrors the pinned runtime's conservative whole-model preflight:
# weight bytes * 1.12 plus 4 GiB for mappings, workspaces and macOS.
GIGACHAT_REQUIRED_MEMORY_BYTES = int(GIGACHAT_RUNTIME_BYTES * 1.12 + 4 * GIB)

LOCAL_WHISPER_REPOSITORIES: dict[str, str] = {
    "tiny": "Systran/faster-whisper-tiny",
    "base": "Systran/faster-whisper-base",
    "small": "Systran/faster-whisper-small",
    "medium": "Systran/faster-whisper-medium",
    "large-v2": "Systran/faster-whisper-large-v2",
    "large-v3": "Systran/faster-whisper-large-v3",
    "large-v3-turbo": "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
    "distil-small.en": "Systran/faster-distil-whisper-small.en",
    "distil-large-v3": "Systran/faster-distil-whisper-large-v3",
}

WHISPER_ALLOW_PATTERNS = (
    "config.json",
    "preprocessor_config.json",
    "model.bin",
    "tokenizer.json",
    "vocabulary.*",
)


@dataclass(frozen=True)
class LocalModelSpec:
    provider: str
    model: str
    repo_id: str
    revision: str | None = None


@dataclass(frozen=True)
class DownloadProgress:
    downloaded_bytes: int = 0
    completed_files: int = 0
    total_bytes: int | None = None
    total_files: int | None = None


@dataclass(frozen=True)
class HostStatus:
    supported: bool
    detail: str | None
    physical_memory_bytes: int
    required_memory_bytes: int | None


@dataclass(frozen=True)
class DeleteResult:
    deleted: bool
    deleted_bytes: int
    deleted_files: int


ProgressCallback = Callable[[DownloadProgress], None]


class CacheSafetyError(RuntimeError):
    """The fixed cache location is not safe to recursively remove."""


def local_model_spec(provider: str, model: str) -> LocalModelSpec | None:
    if provider == "local-whisper":
        repo_id = LOCAL_WHISPER_REPOSITORIES.get(model)
        return LocalModelSpec(provider, model, repo_id) if repo_id else None
    if provider == GIGACHAT_PROVIDER and model == GIGACHAT_MODEL_ID:
        return LocalModelSpec(provider, model, GIGACHAT_MODEL_ID, GIGACHAT_REVISION)
    return None


def local_platform() -> tuple[str, str]:
    return sys.platform, platform.machine().lower()


def physical_memory_bytes() -> int:
    try:
        return int(os.sysconf("SC_PAGE_SIZE")) * int(os.sysconf("SC_PHYS_PAGES"))
    except (AttributeError, OSError, TypeError, ValueError):
        return 0


def gigachat_runtime_available() -> bool:
    try:
        return importlib.util.find_spec("gigachat_audio_mlx.runtime") is not None
    except (ImportError, ModuleNotFoundError):
        return False


def hf_cache_dir(configured: Path | None) -> Path:
    if configured is not None:
        return configured.expanduser().resolve()
    if value := os.environ.get("HF_HUB_CACHE"):
        return Path(value).expanduser().resolve()
    if value := os.environ.get("HF_HOME"):
        return (Path(value).expanduser() / "hub").resolve()
    try:
        from huggingface_hub.constants import HF_HUB_CACHE

        return Path(HF_HUB_CACHE).expanduser().resolve()
    except ImportError:
        return (Path.home() / ".cache" / "huggingface" / "hub").resolve()


def _progress_tqdm(callback: ProgressCallback) -> type:
    # Subclass the Hub wrapper (rather than tqdm.auto directly) so installed
    # huggingface-hub versions can pass their semantic progress-group ``name``.
    # snapshot_download 1.30 reports every ordinary HTTP byte through both a
    # reconstruction bar and a transfer bar; only the latter is network download.
    from huggingface_hub.utils.tqdm import tqdm

    aggregate = DownloadProgress()
    lock = threading.Lock()

    class ProgressTqdm(tqdm):
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            self._audiohelper_name = kwargs.get("name")
            self._audiohelper_unit = kwargs.get("unit", "it")
            super().__init__(*args, **kwargs)  # type: ignore[no-untyped-call]

        def update(self, n: int | float = 1) -> bool | None:
            result = super().update(n)
            nonlocal aggregate
            with lock:
                if (
                    self._audiohelper_unit == "B"
                    and self._audiohelper_name != "huggingface_hub.snapshot_download"
                ):
                    aggregate = DownloadProgress(
                        downloaded_bytes=aggregate.downloaded_bytes + max(0, int(n)),
                        completed_files=aggregate.completed_files,
                        total_bytes=None,
                        total_files=aggregate.total_files,
                    )
                elif self._audiohelper_unit in ("it", "file", "files"):
                    total = getattr(self, "total", None)
                    aggregate = DownloadProgress(
                        downloaded_bytes=aggregate.downloaded_bytes,
                        completed_files=max(aggregate.completed_files, int(getattr(self, "n", 0))),
                        total_bytes=None,
                        total_files=int(total) if isinstance(total, (int, float)) else None,
                    )
                callback(aggregate)
            return bool(result) if result is not None else None

    return ProgressTqdm


def download_local_model(
    provider: str,
    model: str,
    *,
    cache_dir: Path | None,
    progress: ProgressCallback,
) -> None:
    """Download one allowlisted repository with public huggingface-hub APIs."""
    spec = local_model_spec(provider, model)
    if spec is None:
        raise ValueError("unknown local model identity")
    from huggingface_hub import snapshot_download

    target_cache = str(hf_cache_dir(cache_dir))
    progress_class = _progress_tqdm(progress)
    if provider == "local-whisper":
        snapshot_download(
            repo_id=spec.repo_id,
            cache_dir=target_cache,
            allow_patterns=list(WHISPER_ALLOW_PATTERNS),
            tqdm_class=progress_class,
        )
        return
    snapshot_download(
        repo_id=spec.repo_id,
        revision=spec.revision,
        cache_dir=target_cache,
        tqdm_class=progress_class,
    )


def _repo_cache_name(repo_id: str) -> str:
    return "models--" + repo_id.replace("/", "--")


def local_model_cache_present(provider: str, model: str, *, cache_dir: Path | None) -> bool:
    """Check only the fixed repository and lock paths without loading or downloading."""
    spec = local_model_spec(provider, model)
    if spec is None:
        raise ValueError("unknown local model identity")
    cache = hf_cache_dir(cache_dir)
    repo_name = _repo_cache_name(spec.repo_id)
    repo = cache / repo_name
    lock_repo = cache / ".locks" / repo_name
    return repo.exists() or repo.is_symlink() or lock_repo.exists() or lock_repo.is_symlink()


def _fixed_child(parent: Path, *parts: str) -> Path:
    candidate = parent.joinpath(*parts)
    if candidate.parent.resolve(strict=False) != parent.resolve(strict=False):
        raise CacheSafetyError("Local model cache path escaped its fixed parent.")
    if candidate.is_symlink():
        raise CacheSafetyError("Refusing to remove a symlink at the local model cache boundary.")
    return candidate


def _validate_tree(root: Path) -> None:
    resolved_root = root.resolve(strict=False)
    if not root.exists():
        return
    for directory, dirnames, filenames in os.walk(root, followlinks=False):
        for name in [*dirnames, *filenames]:
            entry = Path(directory) / name
            if entry.is_symlink():
                try:
                    entry.resolve(strict=True).relative_to(resolved_root)
                except (FileNotFoundError, ValueError) as error:
                    raise CacheSafetyError(
                        "Refusing to remove a local model cache containing an escaping symlink."
                    ) from error


def _tree_size(root: Path) -> tuple[int, int]:
    total_bytes = 0
    files = 0
    if not root.exists():
        return 0, 0
    for directory, _dirnames, filenames in os.walk(root, followlinks=False):
        for name in filenames:
            entry = Path(directory) / name
            files += 1
            if not entry.is_symlink():
                total_bytes += entry.stat().st_size
    return total_bytes, files


def delete_local_model_cache(provider: str, model: str, *, cache_dir: Path | None) -> DeleteResult:
    """Remove only the allowlisted repository cache, including partial blobs and locks."""
    spec = local_model_spec(provider, model)
    if spec is None:
        raise ValueError("unknown local model identity")
    cache = hf_cache_dir(cache_dir)
    repo_name = _repo_cache_name(spec.repo_id)
    repo = _fixed_child(cache, repo_name)
    locks_root = _fixed_child(cache, ".locks")
    lock_repo = _fixed_child(locks_root, repo_name)
    _validate_tree(repo)
    _validate_tree(lock_repo)
    deleted_bytes, deleted_files = _tree_size(repo)
    existed = repo.exists() or lock_repo.exists()
    if repo.exists():
        shutil.rmtree(repo)
    if lock_repo.exists():
        shutil.rmtree(lock_repo)
    return DeleteResult(existed, deleted_bytes, deleted_files)
