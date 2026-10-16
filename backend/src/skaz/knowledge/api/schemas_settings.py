"""Pydantic models of ``/kb/settings/{health,keys,speech,privacy,about,skills}`` (area S3, 0.3.1 H).

Same rules as ``schemas.py``: ``Kb`` prefix, no defaults on response models.
A stored key never appears in any response.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, SecretStr

from .schemas_agents import KbEngineId

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
    #: Approximate size of the model's files (its download size); ``null`` when unknown.
    size_bytes: int | None


class KbSpeechSettings(BaseModel):
    #: ``openai``: chosen in the previous SKAZ settings; the new settings offer Soniox or this Mac.
    provider: KbSpeechProvider
    #: Spoken languages (hints for recognition); empty = detect any.
    languages: list[str]
    #: New recordings start in "transcription and translation" mode.
    translate_by_default: bool
    translation_language: str
    local_model: KbLocalSpeechModel
    #: The user allowed sending audio of recordings, imports and dictation to a cloud speech service
    #: (Soniox). The existing settings' ``cloud_consent``; only ever set by the user's own action.
    cloud_consent: bool


class KbLocalModelDeleted(BaseModel):
    """``DELETE /kb/settings/speech/local-model``: what was removed, and the speech settings after it."""

    #: Whether any files of the model were there to remove.
    deleted: bool
    #: Bytes freed on this Mac.
    deleted_bytes: int
    speech: KbSpeechSettings


class KbSpeechSettingsUpdate(_Request):
    provider: Literal["soniox", "local_whisper"] | None = None
    languages: list[str] | None = Field(default=None, min_length=1, max_length=64)
    translate_by_default: bool | None = None
    translation_language: str | None = Field(default=None, min_length=2, max_length=32)
    #: Give (``true``) or take back (``false``) the consent; omitted keeps it. Choosing Soniox never gives it.
    cloud_consent: bool | None = None


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


# -- skills (0.3.1 H3) ------------------------------------------------------------------

KbSkillState = Literal["loaded", "not_loaded", "off"]


class KbSkillEngine(BaseModel):
    engine: KbEngineId
    #: ``loaded``: every turn of this agent carries the skill; ``not_loaded``: see ``reason``;
    #: ``off``: the skill is switched off.
    state: KbSkillState
    reason: str | None


class KbSkill(BaseModel):
    id: str
    name: str
    version: str
    license: str
    source_url: str
    enabled: bool
    engines: list[KbSkillEngine]


class KbSkills(BaseModel):
    """Only the skills of SKAZ's own folder; personal skills of the agents are never listed or used."""

    skills: list[KbSkill]


class KbSkillUpdate(_Request):
    enabled: bool = Field(strict=True)
