"""Process-wide wiring. One instance lives on ``app.state.runtime``."""

from __future__ import annotations

import os

import httpx

from .capabilities import describe
from .catalog import ProviderCatalogs
from .config import AppConfig
from .db import Database
from .ingestion import IngestionService
from .schemas import Settings, Task
from .secrets import KeyringSecretStore, SecretStore
from .settings_store import TASKS, SettingsStore, StoredSettings
from .verifications import note


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
        self.db = Database(config.db_path)
        self.secrets: SecretStore = secret_store or KeyringSecretStore()
        self.http = http_client or httpx.AsyncClient(timeout=config.request_timeout_s)
        self.settings_store = SettingsStore(self.db)
        self.catalogs = ProviderCatalogs(self.http, self.secrets, config.data_dir)
        self.ingestion = IngestionService(self)
        #: Local Whisper weights are fetched only when the user opts in explicitly.
        self.allow_model_download = os.environ.get("AUDIOHELPER_ALLOW_MODEL_DOWNLOAD", "") == "1"

    def api_key(self, provider: str) -> str | None:
        return self.secrets.get(provider)

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
            asr=profiles["asr"],
            agent=profiles["agent"],
            notes=profiles["notes"],
            transcript_language=settings.transcript_language,
            output_language=settings.output_language,
            cloud_consent=settings.cloud_consent,
        )

    def mark_verified(self, task: Task, provider: str, model: str, detail: str) -> None:
        from .verifications import record

        record(self.db, provider, model, task, detail)

    def close(self) -> None:
        self.ingestion.close()
        self.db.close()
