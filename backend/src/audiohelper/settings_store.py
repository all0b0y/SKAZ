"""Persistence of user settings. API keys are deliberately not part of this model."""

from __future__ import annotations

import json

from pydantic import BaseModel

from .db import Database
from .schemas import Provider, SettingsUpdate, Task


class StoredProfile(BaseModel):
    provider: Provider
    model: str
    base_url: str | None = None


class StoredSettings(BaseModel):
    asr: StoredProfile
    agent: StoredProfile
    notes: StoredProfile
    transcript_language: str = "auto"
    output_language: str = "ru"
    cloud_consent: bool = False

    def profile(self, task: Task) -> StoredProfile:
        return getattr(self, task)  # type: ignore[no-any-return]


DEFAULT_SETTINGS = StoredSettings(
    asr=StoredProfile(provider="local-whisper", model="small"),
    agent=StoredProfile(provider="openrouter", model=""),
    notes=StoredProfile(provider="openrouter", model=""),
)

TASKS: tuple[Task, ...] = ("asr", "agent", "notes")


class SettingsStore:
    def __init__(self, db: Database) -> None:
        self._db = db

    def load(self) -> StoredSettings:
        with self._db.read() as connection:
            row = connection.execute("SELECT doc FROM app_settings WHERE id = 1").fetchone()
        if row is None:
            return DEFAULT_SETTINGS.model_copy(deep=True)
        return StoredSettings.model_validate(json.loads(row["doc"]))

    def save(self, settings: StoredSettings) -> None:
        doc = json.dumps(settings.model_dump(), ensure_ascii=False)
        with self._db.write() as connection:
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
        changes = patch.model_dump(exclude_unset=True, exclude={"api_key"})
        setattr(merged, task, profile.model_copy(update=changes))
    for field in ("transcript_language", "output_language", "cloud_consent"):
        value = getattr(update, field)
        if value is not None:
            setattr(merged, field, value)
    return merged
