"""Persistence of user settings. API keys are deliberately not part of this model."""

from __future__ import annotations

import json

from pydantic import BaseModel, Field

from .db import Database
from .languages import UsedLanguages
from .schemas import (
    NativeRecordingMode,
    ProactiveSettings,
    Provider,
    SettingsUpdate,
    Task,
    TranscriptionProvider,
)


class StoredProfile(BaseModel):
    provider: Provider
    model: str


class StoredSettings(BaseModel):
    used_languages: UsedLanguages | None = None
    native_recording_mode: NativeRecordingMode = "transcription"
    translation_target_language: str = "ru"
    input_device_id: str | None = None
    capture_system_audio: bool = False
    asr: StoredProfile
    agent: StoredProfile
    notes: StoredProfile
    embedding: StoredProfile = Field(default_factory=lambda: StoredProfile(provider="openrouter", model=""))
    transcript_language: str = "auto"
    output_language: str = "ru"
    cloud_consent: bool = False
    embedding_budget_usd: float | None = Field(default=None, gt=0, le=100, allow_inf_nan=False, strict=True)
    #: Estimated import cost, in US dollars, above which the dialog asks a second
    #: time. None disables the warning; 0 warns for every import. The estimate is
    #: our own arithmetic on the file's duration, never a quote from the provider.
    import_cost_warning_usd: float | None = 0.30
    #: Explicit opt-in for the experimental contextual local mode. It is the only
    #: user-facing way to enable local live finality and the local speech gate;
    #: it stays false for settings documents written before this field existed.
    contextual_local_enabled: bool = False
    #: Proactive assistant; documents written before it existed load it switched off.
    proactive: ProactiveSettings = Field(default_factory=ProactiveSettings)
    #: The live and media-import transcription provider. Soniox stays the default so
    #: settings written before this field existed keep behaving exactly as before.
    transcription_provider: TranscriptionProvider = "soniox"
    local_whisper_model: str = "small"
    openai_transcription_model: str = "whisper-1"
    speaker_separation: bool = True

    def profile(self, task: Task) -> StoredProfile:
        return getattr(self, task)  # type: ignore[no-any-return]


DEFAULT_SETTINGS = StoredSettings(
    asr=StoredProfile(provider="local-whisper", model="small"),
    agent=StoredProfile(provider="openrouter", model=""),
    notes=StoredProfile(provider="openrouter", model=""),
)

TASKS: tuple[Task, ...] = ("asr", "agent", "notes", "embedding")

#: Providers removed from the product. A settings document written before their
#: removal must not crash the backend on load: the profile falls back to its
#: default provider with an empty model, so the user is asked to pick one again.
_RETIRED_PROVIDERS = frozenset({"openai-compatible"})


def _normalise(doc: dict[str, object]) -> dict[str, object]:
    """Drop retired providers and fields from a stored settings document."""
    if doc.get("native_recording_mode") == "audio_only":
        doc["native_recording_mode"] = "transcription"
    for task in TASKS:
        profile = doc.get(task)
        if not isinstance(profile, dict):
            continue
        profile.pop("base_url", None)
        if profile.get("provider") in _RETIRED_PROVIDERS:
            profile["provider"] = DEFAULT_SETTINGS.profile(task).provider
            profile["model"] = ""
    return doc


class SettingsStore:
    def __init__(self, db: Database) -> None:
        self._db = db

    def load(self) -> StoredSettings:
        settings, _revision = self.load_asr_snapshot()
        return settings

    def load_asr_snapshot(self) -> tuple[StoredSettings, int]:
        """Read settings and their ASR generation under the same DB lock."""
        with self._db.read() as connection:
            row = connection.execute("SELECT doc FROM app_settings WHERE id = 1").fetchone()
            revision_row = connection.execute(
                "SELECT revision FROM settings_revisions WHERE scope = 'asr'"
            ).fetchone()
        settings = (
            DEFAULT_SETTINGS.model_copy(deep=True)
            if row is None
            else StoredSettings.model_validate(_normalise(json.loads(row["doc"])))
        )
        return settings, int(revision_row["revision"]) if revision_row is not None else 0

    def save(self, settings: StoredSettings) -> None:
        doc = json.dumps(settings.model_dump(), ensure_ascii=False)
        with self._db.write() as connection:
            current_row = connection.execute("SELECT doc FROM app_settings WHERE id = 1").fetchone()
            current = (
                DEFAULT_SETTINGS
                if current_row is None
                else StoredSettings.model_validate(_normalise(json.loads(current_row["doc"])))
            )
            if (
                current.asr != settings.asr
                or current.transcript_language != settings.transcript_language
                # The contextual opt-in changes decoder behaviour (finality and the
                # speech gate), and toggling it off and on again returns the effective
                # booleans to equal values. Only a monotonic generation can keep a
                # decode started under the withdrawn configuration from committing.
                or current.contextual_local_enabled != settings.contextual_local_enabled
            ):
                connection.execute(
                    """
                    INSERT INTO settings_revisions(scope, revision) VALUES ('asr', 1)
                    ON CONFLICT(scope) DO UPDATE SET revision = revision + 1
                    """
                )
            connection.execute(
                "INSERT INTO app_settings(id, doc) VALUES (1, ?)"
                " ON CONFLICT(id) DO UPDATE SET doc = excluded.doc",
                (doc,),
            )


def apply_update(current: StoredSettings, update: SettingsUpdate) -> StoredSettings:
    """Merge a partial update. Unset fields keep their stored value."""
    merged = current.model_copy(deep=True)
    for task in TASKS:
        patch = getattr(update, task)
        if patch is None:
            continue
        profile = merged.profile(task)
        changes = patch.model_dump(exclude_unset=True)
        setattr(merged, task, profile.model_copy(update=changes))
    for field in (
        "used_languages",
        "native_recording_mode",
        "translation_target_language",
        "transcript_language",
        "output_language",
        "cloud_consent",
        "contextual_local_enabled",
        "capture_system_audio",
        "transcription_provider",
        "local_whisper_model",
        "openai_transcription_model",
        "speaker_separation",
    ):
        value = getattr(update, field)
        if value is not None:
            setattr(merged, field, value)
    if update.input_device_id is not None:
        merged.input_device_id = update.input_device_id or None
    # The threshold is nullable, so "clear it" needs its own flag: a bare None
    # means "unchanged" for every other field and must keep meaning that here.
    if update.clear_import_cost_warning:
        merged.import_cost_warning_usd = None
    elif update.import_cost_warning_usd is not None:
        merged.import_cost_warning_usd = update.import_cost_warning_usd
    if "embedding_budget_usd" in update.model_fields_set:
        merged.embedding_budget_usd = update.embedding_budget_usd
    if update.proactive is not None:
        changes = {key: value for key, value in update.proactive.model_dump(exclude_unset=True).items()
                   if value is not None}
        merged.proactive = merged.proactive.model_copy(update=changes)
        if merged.proactive.aliases:
            from .proactive_detect import normalise_aliases

            merged.proactive.aliases = normalise_aliases(merged.proactive.aliases)
    return merged


class ProactiveNotReady(ValueError):
    """Enabling the proactive assistant without names or model consent."""


def check_proactive(settings: StoredSettings) -> None:
    proactive = settings.proactive
    if not proactive.enabled:
        return
    if not proactive.aliases:
        raise ProactiveNotReady(
            "Add at least one name, nickname or code phrase to enable the proactive assistant."
        )
    if not proactive.model_consent:
        raise ProactiveNotReady(
            "Allow sending transcript text to the selected Assistant model to enable the proactive assistant."
        )
