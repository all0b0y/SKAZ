"""Pydantic models of ``/kb/settings/{health,keys,speech,privacy,about}`` (area S3).

Same rules as ``schemas.py``: ``Kb`` prefix, no defaults on response models.
A stored key never appears in any response.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, SecretStr

KbSettingsSectionId = Literal["accounts", "models", "speech", "wiki", "storage", "privacy", "appearance",
                              "about"]
KbHealthState = Literal["ok", "progress", "warning", "error"]
KbProblemSeverity = Literal["warning", "error", "progress"]
KbKeyProvider = Literal["openrouter", "soniox", "openai"]
KbSpeechProvider = Literal["soniox", "local_whisper", "openai"]
KbLocalSpeechState = Literal["missing", "downloading", "ready", "failed"]


class _Request(BaseModel):
    model_config = ConfigDict(extra="forbid")


class KbProblemAction(BaseModel):
    #: ``POST /kb/settings/health/{problem_id}/{id}`` carries it out.
    id: str
    label: str
    primary: bool


class KbProblem(BaseModel):
    #: Stable while the problem lasts, e.g. ``speech-local-model``, ``agent-codex``, ``key-soniox``.
    id: str
    severity: KbProblemSeverity
    title: str
    #: Why, in plain words.
    reason: str
    #: What keeps working meanwhile.
    still_works: str
    #: What doesn't work until it is fixed.
    stopped: str
    #: 0..1 for ``progress`` problems (a download), else ``null``.
    progress: float | None
    actions: list[KbProblemAction]


class KbSettingsSection(BaseModel):
    id: KbSettingsSectionId
    #: The worst problem of the section (error > warning > progress > ok): the dot in the menu.
    state: KbHealthState
    problems: list[KbProblem]


class KbSettingsHealth(BaseModel):
    sections: list[KbSettingsSection]


class KbKeyStatus(BaseModel):
    id: KbKeyProvider
    #: A key is stored (its value is never returned).
    configured: bool
    #: When the stored key was last checked; ``null`` = not checked since it was saved.
    checked_at: str | None
    #: The provider accepted (true) or refused (false) the key at ``checked_at``.
    valid: bool | None


class KbKeys(BaseModel):
    providers: list[KbKeyStatus]


class KbKeyUpdate(_Request):
    #: The new key; an empty string deletes the stored one.
    key: SecretStr = Field(max_length=4096)


class KbLocalSpeechModel(BaseModel):
    #: The Whisper model chosen for this Mac (e.g. ``small``).
    model: str
    state: KbLocalSpeechState
    #: 0..1 while downloading (``null`` when the size is unknown).
    progress: float | None
    #: Why it failed, in plain words.
    reason: str | None


class KbSpeechSettings(BaseModel):
    #: ``openai``: chosen in the previous SKAZ settings; the new settings offer Soniox or this Mac.
    provider: KbSpeechProvider
    #: Spoken languages (hints for recognition); empty = detect any.
    languages: list[str]
    #: New recordings start in "transcription and translation" mode.
    translate_by_default: bool
    translation_language: str
    local_model: KbLocalSpeechModel


class KbSpeechSettingsUpdate(_Request):
    provider: Literal["soniox", "local_whisper"] | None = None
    languages: list[str] | None = Field(default=None, min_length=1, max_length=64)
    translate_by_default: bool | None = None
    translation_language: str | None = Field(default=None, min_length=2, max_length=32)


class KbPrivacyFlow(BaseModel):
    what: str
    where: str
    when: str
    #: True when this flow happens with the current choices.
    enabled: bool


class KbPrivacy(BaseModel):
    flows: list[KbPrivacyFlow]


class KbLicense(BaseModel):
    name: str
    license: str
    url: str


class KbAbout(BaseModel):
    version: str
    build: str
    licenses: list[KbLicense]
