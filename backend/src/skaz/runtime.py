"""Process-wide wiring. One instance lives on ``app.state.runtime``."""

from __future__ import annotations

import asyncio
import os

import httpx

from .activity import ActivityLog
from .asr_providers import describe_providers
from .capabilities import describe
from .catalog import ProviderCatalogs
from .config import AppConfig, adopt_legacy_database
from .db import Database
from .gateways.asr import LocalModelPreparations
from .gateways.codex_connection import CodexConnection
from .import_service import ImportService
from .knowledge.agents.codex import CodexEngine
from .knowledge.agents.hub import build_agents_hub
from .knowledge.agents.tools import ToolRegistry
from .knowledge.chats import ChatService
from .knowledge.decisions.service import DecisionService
from .knowledge.ingest.service import IngestService
from .knowledge.mcp import McpServer
from .knowledge.permissions.ask_tool import ask_tool
from .knowledge.permissions.broker import PermissionBroker
from .knowledge.permissions.questions import QuestionBroker
from .knowledge.permissions.store import ControlStore
from .knowledge.permissions.waits import RunWaits
from .knowledge.permissions.wiki_tools import WikiEditor
from .knowledge.service import KnowledgeService
from .knowledge.settings.health import SettingsHealth
from .knowledge.settings.keys import KeyChecks
from .knowledge.sources.links import ytdlp_probe
from .knowledge.sources.service import SourceService
from .knowledge.speech import create_speech_service
from .knowledge.speech.dictation import Dictation
from .knowledge.wiki.service import WikiService
from .knowledge.wiring import McpGrants, wire_fixes_offer, wire_speech, wire_wiki
from .knowledge.wiring import wire as wire_knowledge
from .live_store import LiveStore
from .native_stream import NativeStream
from .schemas import CLOUD_PROVIDERS, Settings, Task
from .secrets import FileSecretStore, SecretStore
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
        # Must run before the database is opened, or SQLite creates an empty
        # skaz.sqlite3 beside the pre-rename file and the install looks wiped.
        adopt_legacy_database(config)
        self.config = config
        self.activity_log = ActivityLog(config.activity_log_capacity)
        self.db = Database(config.db_path)
        #: The Codex app-server sign-in/connection the knowledge agents run on (areas A1/A2).
        self.codex_connection = CodexConnection(config.data_dir / "codex" / "account")
        self.live_store = LiveStore(self.db)
        self.live_store.recover_interrupted()
        #: Knowledge wiki: its own knowledge.sqlite3; touches Documents only after an explicit connect.
        self.kb = KnowledgeService(
            config.data_dir, documents_dir=config.documents_dir,
            documents_sandbox=config.documents_sandbox,
        )
        #: Ingest (W1); its detector/decisions/engines are connected by ``wire_knowledge`` below.
        self.kb_ingest = IngestService(self.kb)
        #: Read-only SKAZ agent tools: listed by the MCP server and given to Codex as dynamicTools.
        self.kb_tools = ToolRegistry(self.kb)
        self.kb_mcp = McpServer(self.kb_tools, url=f"http://{config.host}:{config.port}/kb/mcp")
        #: Runs waiting for the user (permission or question): their answer deadline stands still (0.3.1 P).
        self.kb_waits = RunWaits()
        #: Agents' wiki changes wait for Allow / Allow in this chat / Deny here (0.3.1 P).
        self.kb_permissions = PermissionBroker(ControlStore(self.kb.db), self.kb_waits)
        self.kb_codex = CodexEngine(self.codex_connection, self.kb_tools, waits=self.kb_waits)
        #: Adding documents, links and pasted text to the knowledge library (area S1).
        self.kb_sources = SourceService(self.kb, video_probe=ytdlp_probe)
        #: Agent engines (Codex, Claude Code, Hermes): statuses, installs, sign-in; nothing runs until asked.
        self.kb_agents = build_agents_hub(config.data_dir, settings=self.kb.settings,
                                          codex=self.codex_connection, codex_engine=self.kb_codex,
                                          mcp=McpGrants(self.kb_mcp))
        # Keys live beside the app's own data, not in the OS keychain: see
        # secrets.py for why a keychain item cannot work in the shipped bundle.
        self.secrets: SecretStore = secret_store or FileSecretStore(config.data_dir / "secrets")
        self.http = http_client or httpx.AsyncClient(timeout=config.request_timeout_s)
        #: Wiki decision layer (System One): provider choice, local llama-server, journal.
        self.kb_decisions = DecisionService(
            self.kb.db, self.kb.settings, data_dir=config.data_dir, http=self.http,
            api_key=lambda: self.secrets.get("openrouter"), activity=self.activity_log,
        )
        #: Seams between the knowledge areas (detector, decisions, engines, auto-ingest).
        self.kb_auto_ingest = wire_knowledge(
            self.kb, self.kb_ingest, self.kb_sources, self.kb_decisions.layer,
            self.kb_agents.registry.engines, self.kb_agents.registry.default,
            decisions_ready=self.kb_decisions.ready,
        )
        #: The wiki after ingest (W2): corrections, discrepancies, edits, deletion, connections, graph.
        self.kb_wiki = wire_wiki(WikiService(self.kb, self.kb_ingest))
        #: General chats (C1): answers through the engine registry with the SKAZ tools, no queues.
        #: The four wiki tools of chat agents: checked, asked, applied by SKAZ's writer, undoable (0.3.1 P).
        self.kb_wiki_edits = WikiEditor(self.kb, self.kb_wiki, self.kb_permissions,
                                        language=lambda: self.kb_ingest.settings().language,
                                        text_layer=lambda: self.kb_ingest.text_layer)
        self.kb_tools.add(self.kb_wiki_edits.tools())
        #: Agents' questions (Hermes ``clarify``, ``skaz_ask_user``) wait for the user here (0.3.1 P).
        self.kb_questions = QuestionBroker(self.kb_permissions.store, self.kb_waits)
        self.kb_chats = ChatService(self.kb, agents=lambda: self.kb_agents.registry, tools=self.kb_tools,
                                    text_layer=lambda: self.kb_ingest.text_layer,
                                    permissions=self.kb_permissions, questions=self.kb_questions)
        self.kb_wiki_edits.runs = self.kb_chats.run_ref
        #: SKAZ's own question tool for agents whose native one can't work with SKAZ (Q-A1).
        self.kb_tools.add((ask_tool(self.kb_questions, self.kb_chats.run_ref),))
        self.settings_store = SettingsStore(self.db)
        self.catalogs = ProviderCatalogs(self.http, self.secrets, config.data_dir)
        #: File imports. Resumption is started by the app lifespan, not here: a
        #: constructor must not create tasks on a loop it does not own.
        self.imports = ImportService(self)
        #: Speech → materials (area S2): links recordings/imports to library materials.
        self.kb_speech = create_speech_service(self)
        self.kb_speech.on_finished(self.kb_auto_ingest.material_finished)
        #: Decision 15: an import's "to wiki" choice is kept before the import can finish (X5).
        self.kb_speech.keep_wiki_choices(self.kb_auto_ingest.remember)
        #: ``link_failed`` notifications and their actions (area S3).
        self.kb_link_failures = wire_speech(self.kb, self.kb_speech)
        #: One-time "turn on automatic fixes" offer at the first finished speech material (X2-8, X5).
        self.kb_fixes_offer = wire_fixes_offer(self.kb, self.kb_speech, self.kb_decisions)
        self._close_started = False
        self.native_tasks: dict[str, tuple[asyncio.Task[None], asyncio.Event]] = {}
        self.native_streams: dict[str, NativeStream] = {}
        self.native_closing: set[str] = set()
        self.session_deletions: dict[str, asyncio.Task[None]] = {}
        self.native_shutdown = False
        self.native_settings_lock = asyncio.Lock()
        #: Local Whisper weights are fetched only when the user opts in explicitly.
        self.allow_model_download = os.environ.get("SKAZ_ALLOW_MODEL_DOWNLOAD", "") == "1"
        #: The explicit "prepare this checkpoint" path; separate from the toggle above.
        self.local_models = LocalModelPreparations(config.local_model_cache_dir)
        #: Dictation from the composer (area S3): recognised with the chosen service, never stored.
        self.kb_dictation = Dictation(self)
        #: New settings (area S3): key checks and the problem list over the existing stores.
        self.kb_keys = KeyChecks(self.kb.settings, self.api_key, self.http)
        self.kb_settings_health = SettingsHealth(self, self.kb_keys)

    def api_key(self, provider: str) -> str | None:
        return self.secrets.get(provider)

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
            transcription_provider=settings.transcription_provider,
            local_whisper_model=settings.local_whisper_model,
            openai_transcription_model=settings.openai_transcription_model,
            speaker_separation=settings.speaker_separation,
            transcription_providers=describe_providers(self, settings),
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
        self.local_models.close()
        self.kb_decisions.kill_now()
        self.kb.close()
        self.db.close()
