"""Process-wide wiring. One instance lives on ``app.state.runtime``."""

from __future__ import annotations

import asyncio
import os

import httpx

from .activity import ActivityLog
from .agent.api_agent import ApiAgentEngine
from .agent.codex_runtime import CodexRuntime
from .agent.note_rewrite import PendingRewrites
from .agent.retrieval import EmbeddingIndex
from .capabilities import describe
from .catalog import ProviderCatalogs
from .config import AppConfig, adopt_legacy_database
from .db import Database
from .gateways.asr import LocalModelPreparations
from .import_service import ImportService
from .ingestion import IngestionService
from .live_asr import LiveAsrDraftService
from .live_fragments import LiveAsrFragmentService
from .live_scheduler import LiveAsrScheduler
from .live_store import LiveStore
from .managed_storage import ManagedStorage
from .native_stream import NativeStream
from .proactive import ProactiveService
from .schemas import CLOUD_PROVIDERS, Settings, Task
from .secrets import FileSecretStore, SecretStore
from .session_files import SessionFiles
from .settings_store import TASKS, SettingsStore, StoredSettings
from .verifications import note
from .web_search import WebSearch
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
        # Must run before the database is opened, or SQLite creates an empty
        # skaz.sqlite3 beside the pre-rename file and the install looks wiped.
        adopt_legacy_database(config)
        self.config = config
        self.activity_log = ActivityLog(config.activity_log_capacity)
        self.db = Database(config.db_path)
        self.codex = CodexRuntime(self.db, config.data_dir / "codex")
        self.embedding_index = EmbeddingIndex(self.db)
        self.embedding_lock = asyncio.Lock()
        self.session_files = SessionFiles(
            self.db, config.session_files_root, data_dir=config.data_dir,
            suggested_root=config.documents_dir / "SKAZ",
            allowed_root=config.documents_sandbox,
        )
        self.storage = ManagedStorage(self.db, self.session_files, config.audio_dir)
        self.session_files.storage = self.storage
        self.live_store = LiveStore(self.db)
        self.live_store.recover_interrupted()
        # Keys live beside the app's own data, not in the OS keychain: see
        # secrets.py for why a keychain item cannot work in the shipped bundle.
        self.secrets: SecretStore = secret_store or FileSecretStore(config.data_dir / "secrets")
        self.http = http_client or httpx.AsyncClient(timeout=config.request_timeout_s)
        self.web_search = WebSearch(self.db, self.secrets)
        self.codex.web_search = self.web_search
        self.settings_store = SettingsStore(self.db)
        self.catalogs = ProviderCatalogs(self.http, self.secrets, config.data_dir)
        self.codex.api_agents = ApiAgentEngine(
            settings=self.settings_store.load, api_key=self.api_key, http=self.http,
            catalogs=self.catalogs, timeout=config.request_timeout_s,
        )
        self.ingestion = IngestionService(self)
        #: File imports. Resumption is started by the app lifespan, not here: a
        #: constructor must not create tasks on a loop it does not own.
        self.imports = ImportService(self)
        #: Written-but-unapplied note passages, held until the user compares them.
        self.note_rewrites = PendingRewrites()
        self.window_asr = WindowAsrPreview(self)
        self.live_asr = LiveAsrDraftService(self.window_asr, self)
        self.live_fragments = LiveAsrFragmentService(self)
        self.live_scheduler = LiveAsrScheduler(self)
        self._close_started = False
        self.native_tasks: dict[str, tuple[asyncio.Task[None], asyncio.Event]] = {}
        self.native_streams: dict[str, NativeStream] = {}
        self.native_closing: set[str] = set()
        self.session_deletions: dict[str, asyncio.Task[None]] = {}
        self.native_shutdown = False
        self.native_settings_lock = asyncio.Lock()
        #: Cards for questions addressed to the user during a live session.
        self.proactive = ProactiveService(self)
        #: Local Whisper weights are fetched only when the user opts in explicitly.
        self.allow_model_download = os.environ.get("SKAZ_ALLOW_MODEL_DOWNLOAD", "") == "1"
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
        """Sanitised settings for the API: keys reported as presence only, honest verified flags."""
        settings = stored or self.settings_store.load()
        profiles = {
            task: describe(
                task,
                settings.profile(task),
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
            input_device_id=settings.input_device_id,
            capture_system_audio=settings.capture_system_audio,

            provider_has_api_key={
                provider: bool(self.api_key(provider)) for provider in CLOUD_PROVIDERS
            },
            asr=profiles["asr"],
            agent=profiles["agent"],
            notes=profiles["notes"],
            embedding=profiles["embedding"],
            transcript_language=settings.transcript_language,
            output_language=settings.output_language,
            cloud_consent=settings.cloud_consent,
            import_cost_warning_usd=settings.import_cost_warning_usd,
            embedding_budget_usd=settings.embedding_budget_usd,
            contextual_local_enabled=settings.contextual_local_enabled,
            proactive=settings.proactive,
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
        self.proactive.close()
        self.codex.close_storage()
        self.window_asr.close()
        self.local_models.close()
        self.ingestion.close()
        self.db.close()
