"""Process configuration. Values come from the desktop parent process via env."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_DATA_DIR = Path.home() / ".audiohelper"
_TRUE_ENV_VALUES = frozenset({"1", "true", "yes", "on"})
_FALSE_ENV_VALUES = frozenset({"", "0", "false", "no", "off"})


def _boolean_env(name: str, *, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    value = raw.strip().lower()
    if value in _TRUE_ENV_VALUES:
        return True
    if value in _FALSE_ENV_VALUES:
        return False
    raise SystemExit(f"{name} must be one of: 1/true/yes/on or 0/false/no/off.")


def _positive_int_env(name: str, *, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError as error:
        raise SystemExit(f"{name} must be a positive integer.") from error
    if value <= 0:
        raise SystemExit(f"{name} must be a positive integer.")
    return value


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
    #: Metadata bound for one explicit contextual preview window.
    max_preview_chunks: int = 64
    #: A durable draft is UI state, not an unbounded transcript store.
    max_live_draft_chars: int = 64_000
    #: Experimental stable-prefix finalization is deliberately opt-in.
    live_finality_enabled: bool = False
    #: Words nearer either decoder window edge remain revisable.
    live_finality_guard_ms: int = 750
    #: Extra browser origins allowed in addition to loopback/file origins.
    extra_allowed_origins: tuple[str, ...] = field(default_factory=tuple)
    #: Upper bound on characters of transcript handed to the agent in one request.
    max_context_chars: int = 12_000
    #: In-memory technical attempts retained per backend installation.
    activity_log_capacity: int = 256
    #: Upper bound on characters per map step when summarising long sessions.
    max_notes_chunk_chars: int = 8_000
    #: Optional whole-window speech-presence gate for local Whisper only.
    local_speech_gate: bool = False
    #: Optional application-owned Hugging Face cache. None preserves the existing
    #: shared cache so already-prepared Whisper checkpoints keep working.
    local_model_cache_dir: Path | None = None

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
        return cls(
            token=token,
            data_dir=data_dir,
            port=port,
            extra_allowed_origins=origins,
            local_speech_gate=_boolean_env("AUDIOHELPER_LOCAL_SPEECH_GATE"),
            live_finality_enabled=_boolean_env("AUDIOHELPER_LIVE_FINALITY"),
            live_finality_guard_ms=_positive_int_env(
                "AUDIOHELPER_LIVE_FINALITY_GUARD_MS", default=750
            ),
            local_model_cache_dir=(
                Path(value).expanduser()
                if (value := os.environ.get("AUDIOHELPER_MODEL_CACHE", "").strip())
                else None
            ),
        )
