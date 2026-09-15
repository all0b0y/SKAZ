"""Process-wide wiring. One instance lives on ``app.state.runtime``."""

from __future__ import annotations

import asyncio
import os

import httpx

from .activity import ActivityLog
from .capabilities import describe
from .catalog import ProviderCatalogs
from .config import AppConfig
from .db import Database
from .gateways.asr import LocalModelPreparations
from .ingestion import IngestionService
from .live_asr import LiveAsrDraftService
from .live_fragments import LiveAsrFragmentService
from .live_scheduler import LiveAsrScheduler
from .live_store import LiveStore
from .native_stream import NativeStream
from .schemas import Settings, Task
from .secrets import KeyringSecretStore, SecretStore
from .settings_store import TASKS, SettingsStore, StoredSettings
from .verifications import note
from .window_asr import WindowAsrPreview


class Runtime:
    def __init__(
        self,
        config: AppConfig,
        *,
        secret_store: SecretStore | None = None,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        config.data_dir.mkdir(parents=True, exist_ok=True)
        config.audio_dir.mkdir(parents=True, exist_ok=True)
        self.config = config
        self.activity_log = ActivityLog(config.activity_log_capacity)
        self.db = Database(config.db_path)
        self.live_store = LiveStore(self.db, config.audio_dir)
        self.live_store.recover_interrupted()
        self.secrets: SecretStore = secret_store or KeyringSecretStore()
        self.http = http_client or httpx.AsyncClient(timeout=config.request_timeout_s)
        self.settings_store = SettingsStore(self.db)
        self.catalogs = ProviderCatalogs(self.http, self.secrets, config.data_dir)
        self.ingestion = IngestionService(self)
        self.window_asr = WindowAsrPreview(self)
        self.live_asr = LiveAsrDraftService(self.window_asr, self)
        self.live_fragments = LiveAsrFragmentService(self)
        self.live_scheduler = LiveAsrScheduler(self)
        self._close_started = False
        self.native_tasks: dict[str, tuple[asyncio.Task[None], asyncio.Event]] = {}
        self.native_streams: dict[str, NativeStream] = {}
        self.native_closing: set[str] = set()
        self.native_shutdown = False
        self.native_settings_lock = asyncio.Lock()
        #: Local Whisper weights are fetched only when the user opts in explicitly.
        self.allow_model_download = os.environ.get("AUDIOHELPER_ALLOW_MODEL_DOWNLOAD", "") == "1"
        #: The explicit "prepare this checkpoint" path; separate from the toggle above.
        self.local_models = LocalModelPreparations(config.local_model_cache_dir)

    def api_key(self, provider: str) -> str | None:
        return self.secrets.get(provider)

    @property
    def contextual_local_enabled(self) -> bool:
        """The persisted explicit opt-in for the experimental contextual local mode.

        Reading it never enables anything: the value is written only by an explicit
        settings update, so it also survives a restart without re-enabling itself.
        """
        return self.settings_store.load().contextual_local_enabled

    @property
    def live_finality_enabled(self) -> bool:
        """Effective stable-prefix finalization for the contextual local path."""
        return self.config.live_finality_enabled or self.contextual_local_enabled

    @property
    def local_speech_gate(self) -> bool:
        """Effective speech-presence gate for the contextual local window decoder.

        The legacy per-chunk path deliberately keeps reading
        ``config.local_speech_gate`` so the opt-in never changes legacy/cloud
        transcription behaviour.
        """
        return self.config.local_speech_gate or self.contextual_local_enabled

    def settings_view(self, stored: StoredSettings | None = None) -> Settings:
        """Sanitised settings for the API: keys replaced by has_api_key, honest verified flags."""
        settings = stored or self.settings_store.load()
        profiles = {
            task: describe(
                task,
                settings.profile(task),
                has_api_key=bool(self.api_key(settings.profile(task).provider)),
                verification=note(
                    self.db, settings.profile(task).provider, settings.profile(task).model, task
                ),
                asr_kind=(
                    self.catalogs.cached_openrouter_asr_kind(settings.profile(task).model)
                    if task == "asr" and settings.profile(task).provider == "openrouter"
                    else None
                ),
            )
            for task in TASKS
        }
        return Settings(
            used_languages=settings.used_languages,
            native_recording_mode=settings.native_recording_mode,
            translation_target_language=settings.translation_target_language,
            soniox_has_api_key=bool(self.secrets.get("soniox")),
            asr=profiles["asr"],
            agent=profiles["agent"],
            notes=profiles["notes"],
            transcript_language=settings.transcript_language,
            output_language=settings.output_language,
            cloud_consent=settings.cloud_consent,
            contextual_local_enabled=settings.contextual_local_enabled,
        )

    def mark_verified(self, task: Task, provider: str, model: str, detail: str) -> None:
        from .verifications import record

        record(self.db, provider, model, task, detail)

    async def stop_native(self, session_id: str | None = None) -> None:
        if session_id is None:
            self.native_shutdown = True
            tasks = list(self.native_tasks.values())
        else:
            self.native_closing.add(session_id)
            owner = self.native_tasks.get(session_id)
            tasks = [owner] if owner is not None else []
        for task, _done in tasks:
            task.cancel()
        await asyncio.gather(*(done.wait() for _task, done in tasks))

    def close(self) -> None:
        if self._close_started:
            return
        self._close_started = True
        pending = self.live_scheduler.close()
        if pending is not None:
            pending.add_done_callback(lambda _task: self._finish_close())
            return
        self._finish_close()

    def _finish_close(self) -> None:
        self.window_asr.close()
        self.local_models.close()
        self.ingestion.close()
        self.db.close()
