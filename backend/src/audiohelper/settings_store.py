"""Persistence of user settings. API keys are deliberately not part of this model."""

from __future__ import annotations

import json

from pydantic import BaseModel

from .db import Database
from .languages import UsedLanguages
from .schemas import NativeRecordingMode, Provider, SettingsUpdate, Task


class StoredProfile(BaseModel):
    provider: Provider
    model: str


class StoredSettings(BaseModel):
    used_languages: UsedLanguages | None = None
    native_recording_mode: NativeRecordingMode = "transcription"
    translation_target_language: str = "ru"
    asr: StoredProfile
    agent: StoredProfile
    notes: StoredProfile
    transcript_language: str = "auto"
    output_language: str = "ru"
    cloud_consent: bool = False
    #: Explicit opt-in for the experimental contextual local mode. It is the only
    #: user-facing way to enable local live finality and the local speech gate;
    #: it stays false for settings documents written before this field existed.
    contextual_local_enabled: bool = False

    def profile(self, task: Task) -> StoredProfile:
        return getattr(self, task)  # type: ignore[no-any-return]


DEFAULT_SETTINGS = StoredSettings(
    asr=StoredProfile(provider="local-whisper", model="small"),
    agent=StoredProfile(provider="openrouter", model=""),
    notes=StoredProfile(provider="openrouter", model=""),
)

TASKS: tuple[Task, ...] = ("asr", "agent", "notes")

#: Providers removed from the product. A settings document written before their
#: removal must not crash the backend on load: the profile falls back to its
#: default provider with an empty model, so the user is asked to pick one again.
_RETIRED_PROVIDERS = frozenset({"openai-compatible"})


def _normalise(doc: dict[str, object]) -> dict[str, object]:
    """Drop retired providers and fields from a stored settings document."""
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
    ):
        value = getattr(update, field)
        if value is not None:
            setattr(merged, field, value)
    return merged
