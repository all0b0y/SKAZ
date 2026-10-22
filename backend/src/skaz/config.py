"""Process configuration. Values come from the desktop parent process via env."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_DATA_DIR = Path.home() / ".skaz" / "dev" / "data"
LEGACY_DB_NAME = "audiohelper.sqlite3"


@dataclass(frozen=True)
class AppConfig:
    token: str
    data_dir: Path
    host: str = "127.0.0.1"
    port: int = 0
    #: Outbound HTTP timeout for chat/completions style calls.
    request_timeout_s: float = 90.0
    #: Extra browser origins allowed in addition to loopback/file origins.
    extra_allowed_origins: tuple[str, ...] = field(default_factory=tuple)
    #: In-memory technical attempts retained per backend installation.
    activity_log_capacity: int = 256
    #: Optional application-owned Hugging Face cache. None preserves the existing
    #: shared cache so already-prepared Whisper checkpoints keep working.
    local_model_cache_dir: Path | None = None
    documents_dir: Path = field(default_factory=lambda: Path.home() / "Documents")
    documents_sandbox: Path | None = None

    @property
    def audio_dir(self) -> Path:
        return self.data_dir / "audio"

    @property
    def db_path(self) -> Path:
        return self.data_dir / "skaz.sqlite3"

    @classmethod
    def from_env(cls, port: int) -> AppConfig:
        # L3: read once and removed, so ffmpeg, yt-dlp and installers started later never inherit it.
        token = os.environ.pop("SKAZ_TOKEN", "").strip()
        if not token:
            raise SystemExit(
                "SKAZ_TOKEN is required; the desktop process must supply a per-run token."
            )
        data_dir = Path(os.environ.get("SKAZ_DATA_DIR", str(DEFAULT_DATA_DIR))).expanduser()
        origins = tuple(
            o.strip() for o in os.environ.get("SKAZ_ALLOWED_ORIGINS", "").split(",") if o.strip()
        )
        return cls(
            token=token,
            data_dir=data_dir,
            port=port,
            documents_sandbox=(Path(value) if (value := os.environ.get("SKAZ_DOCUMENTS_SANDBOX")) else None),
            documents_dir=Path(os.environ.get(
                "SKAZ_DOCUMENTS_DIR", str(Path.home() / "Documents"),
            )),
            extra_allowed_origins=origins,
            local_model_cache_dir=(
                Path(value).expanduser()
                if (value := os.environ.get("SKAZ_MODEL_CACHE", "").strip())
                else None
            ),
        )


def adopt_legacy_database(config: AppConfig) -> None:
    """Rename a pre-rename database to the product-named file, once.

    A data folder written by an earlier build holds ``audiohelper.sqlite3``.
    Without this the backend would create a second, empty ``skaz.sqlite3``
    beside it and the installation would look wiped. The ``-wal``/``-shm``
    sidecars move too: a WAL left behind holds committed transactions.

    Never overwrites an existing database, so a repeated call cannot replace
    newer data with an older file.
    """
    target = config.db_path
    legacy = config.data_dir / LEGACY_DB_NAME
    if target.exists() or not legacy.exists():
        return
    for suffix in ("", "-wal", "-shm"):
        source = legacy.with_name(legacy.name + suffix)
        if source.exists():
            source.rename(target.with_name(target.name + suffix))
