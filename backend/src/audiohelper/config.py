"""Process configuration. Values come from the desktop parent process via env."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_DATA_DIR = Path.home() / ".audiohelper"


@dataclass(frozen=True)
class AppConfig:
    token: str
    data_dir: Path
    host: str = "127.0.0.1"
    port: int = 0
    #: Outbound HTTP timeout for chat/completions style calls.
    request_timeout_s: float = 90.0
    #: Outbound HTTP timeout for transcription calls.
    asr_timeout_s: float = 120.0
    #: How many audio chunks may wait for transcription per session before the API pushes back.
    max_pending_chunks: int = 8
    max_chunk_seconds: float = 30.0
    max_chunk_bytes: int = 16 * 1024 * 1024
    #: Extra browser origins allowed in addition to loopback/file origins.
    extra_allowed_origins: tuple[str, ...] = field(default_factory=tuple)
    #: Upper bound on characters of transcript handed to the agent in one request.
    max_context_chars: int = 12_000
    #: Upper bound on characters per map step when summarising long sessions.
    max_notes_chunk_chars: int = 8_000

    @property
    def audio_dir(self) -> Path:
        return self.data_dir / "audio"

    @property
    def db_path(self) -> Path:
        return self.data_dir / "audiohelper.sqlite3"

    @classmethod
    def from_env(cls, port: int) -> AppConfig:
        token = os.environ.get("AUDIOHELPER_TOKEN", "").strip()
        if not token:
            raise SystemExit(
                "AUDIOHELPER_TOKEN is required; the desktop process must supply a per-run token."
            )
        data_dir = Path(os.environ.get("AUDIOHELPER_DATA_DIR", str(DEFAULT_DATA_DIR))).expanduser()
        origins = tuple(
            o.strip() for o in os.environ.get("AUDIOHELPER_ALLOWED_ORIGINS", "").split(",") if o.strip()
        )
        return cls(token=token, data_dir=data_dir, port=port, extra_allowed_origins=origins)
