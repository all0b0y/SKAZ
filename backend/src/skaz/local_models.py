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

#: Approximate download sizes, shown before the user confirms a download.
LOCAL_MODEL_SIZES: dict[str, int] = {
    "tiny": 75_000_000,
    "base": 145_000_000,
    "small": 484_000_000,
    "medium": 1_530_000_000,
    "large-v2": 3_090_000_000,
    "large-v3": 3_090_000_000,
    "large-v3-turbo": 1_620_000_000,
    "distil-small.en": 336_000_000,
    "distil-large-v3": 1_510_000_000,
}

#: Local voice-embedding model used for approximate speaker separation.
SPEAKER_PROVIDER = "local-speaker"
SPEAKER_MODEL_ID = "wespeaker-voxceleb-resnet34-LM"
#: WeSpeaker ResNet34-LM exported to ONNX (the export pyannote.audio 3.0 used).
SPEAKER_REPOSITORY = "hbredin/wespeaker-voxceleb-resnet34-LM"
SPEAKER_MODEL_BYTES = 26_600_000
SPEAKER_ALLOW_PATTERNS = ("*.onnx",)

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
    if provider == SPEAKER_PROVIDER and model == SPEAKER_MODEL_ID:
        return LocalModelSpec(provider, model, SPEAKER_REPOSITORY)
    return None


def local_model_size(provider: str, model: str) -> int | None:
    """Approximate download size in bytes, or None when unknown."""
    if provider == "local-whisper":
        return LOCAL_MODEL_SIZES.get(model)
    if provider == GIGACHAT_PROVIDER and model == GIGACHAT_MODEL_ID:
        return GIGACHAT_RUNTIME_BYTES
    if provider == SPEAKER_PROVIDER and model == SPEAKER_MODEL_ID:
        return SPEAKER_MODEL_BYTES
    return None


def speaker_runtime_available() -> bool:
    """ONNX Runtime and NumPy arrive with the 'local-asr' extra (faster-whisper)."""
    try:
        return (importlib.util.find_spec("onnxruntime") is not None
                and importlib.util.find_spec("numpy") is not None)
    except (ImportError, ModuleNotFoundError):
        return False


def speaker_model_path(*, cache_dir: Path | None) -> Path:
    """The cached ONNX file, strictly offline. Raises FileNotFoundError when absent."""
    try:
        from huggingface_hub import snapshot_download
    except ImportError as error:
        raise FileNotFoundError("huggingface-hub is not installed") from error
    snapshot = Path(snapshot_download(
        repo_id=SPEAKER_REPOSITORY, cache_dir=str(hf_cache_dir(cache_dir)),
        allow_patterns=list(SPEAKER_ALLOW_PATTERNS), local_files_only=True,
    ))
    candidates = sorted(path for path in snapshot.glob("*.onnx") if path.is_file())
    if not candidates:
        raise FileNotFoundError("the speaker model file is missing from the local cache")
    return candidates[0]


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
            self._skaz_name = kwargs.get("name")
            self._skaz_unit = kwargs.get("unit", "it")
            super().__init__(*args, **kwargs)  # type: ignore[no-untyped-call]

        def update(self, n: int | float = 1) -> bool | None:
            result = super().update(n)
            nonlocal aggregate
            with lock:
                if (
                    self._skaz_unit == "B"
                    and self._skaz_name != "huggingface_hub.snapshot_download"
                ):
                    aggregate = DownloadProgress(
                        downloaded_bytes=aggregate.downloaded_bytes + max(0, int(n)),
                        completed_files=aggregate.completed_files,
                        total_bytes=None,
                        total_files=aggregate.total_files,
                    )
                elif self._skaz_unit in ("it", "file", "files"):
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
    if provider in ("local-whisper", SPEAKER_PROVIDER):
        patterns = WHISPER_ALLOW_PATTERNS if provider == "local-whisper" else SPEAKER_ALLOW_PATTERNS
        snapshot_download(
            repo_id=spec.repo_id,
            cache_dir=target_cache,
            allow_patterns=list(patterns),
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
