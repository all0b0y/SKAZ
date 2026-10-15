"""Wire models. Field names are the snake_case contract from docs/API.md."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, SecretStr, StrictBool

from .languages import SUPPORTED_LANGUAGES, UsedLanguages

Provider = Literal[
    "local-whisper",
    "local-gigachat-mlx",
    "openai",
    "openrouter",
    "anthropic",
]
#: Who turns live speech (and imported media) into the native transcript. Switching
#: is always an explicit settings change; there is never a fallback between them.
TranscriptionProvider = Literal["soniox", "local-whisper", "openai"]
CloudProvider = Literal["openai", "openrouter", "anthropic", "soniox"]
#: Cloud providers that own an API key. The key belongs to the provider, not to a
#: task profile: two tasks on the same provider share one credential.
CLOUD_PROVIDERS: tuple[str, ...] = ("openai", "openrouter", "anthropic", "soniox")
Task = Literal["asr", "agent", "notes", "embedding"]
SessionStatus = Literal["recording", "paused", "stopped"]
SessionMode = Literal["legacy", "contextual_local"]
NativeRecordingMode = Literal["transcription", "translation"]
AudioSourceKind = Literal["original_captured_wav"]


class Profile(BaseModel):
    """Sanitised model profile. Never carries an API key.

    Key presence is not a profile fact: it lives in ``Settings.provider_has_api_key``,
    keyed by provider, because one credential serves every task on that provider.
    """

    provider: Provider
    model: str
    #: True only after this installation completed a successful call with this provider+model.
    verified: bool = False
    verification_note: str | None = None


class ProfileUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provider: Provider | None = None
    model: str | None = None


class TranscriptionCapabilities(BaseModel):
    """What a transcription provider really does, so the UI can say what is missing."""

    #: "streaming": words while speaking; "near_streaming": provisional text refined
    #: every second or so; "utterance": final text after each pause, no provisional text.
    live: Literal["streaming", "near_streaming", "utterance"]
    provisional_text: bool
    file_transcription: bool
    #: "full": provider diarization; "approximate": local voice clustering; "none".
    speakers: Literal["full", "approximate", "none"]
    translation: Literal["any", "english_only", "none"]
    #: "full": any language; "selected_languages": picked among the spoken languages.
    language_detection: Literal["full", "selected_languages"]
    word_timestamps: Literal["exact", "approximate"]
    offline: bool
    requires_cloud_consent: bool
    #: Provider whose stored API key this one uses, if any.
    api_key_provider: CloudProvider | None = None


class TranscriptionModel(BaseModel):
    id: str
    name: str
    #: Approximate download size for local models.
    size_bytes: int | None = None
    note: str | None = None
    recommended: bool = False


class TranscriptionProviderInfo(BaseModel):
    id: TranscriptionProvider
    label: str
    capabilities: TranscriptionCapabilities
    models: list[TranscriptionModel] = Field(default_factory=list)
    #: The selected model for this provider (None for a provider with one fixed model).
    model: str | None = None
    #: Whether a recording can start with this provider right now, and why not.
    ready: bool
    detail: str | None = None
    #: Honest, user-facing gaps compared with the full-featured provider.
    limitations: list[str] = Field(default_factory=list)


class Settings(BaseModel):
    used_languages: UsedLanguages | None = None
    supported_languages: list[str] = Field(default_factory=lambda: list(SUPPORTED_LANGUAGES))
    # Preferences for the next native recording, not a running session's config.
    native_recording_mode: NativeRecordingMode = "transcription"
    translation_target_language: str = "ru"
    #: Capture sources for the next recording. None = the system default microphone.
    input_device_id: str | None = None
    capture_system_audio: bool = False

    #: Key presence per cloud provider, independent of which task uses it.
    provider_has_api_key: dict[str, bool] = Field(default_factory=dict)
    asr: Profile
    agent: Profile
    notes: Profile
    embedding: Profile
    transcript_language: str = "auto"
    output_language: str = "ru"
    cloud_consent: bool = False
    #: Explicit opt-in for the experimental contextual local mode; off by default.
    contextual_local_enabled: bool = False
    transcription_provider: TranscriptionProvider = "soniox"
    local_whisper_model: str = "small"
    openai_transcription_model: str = "whisper-1"
    #: Local voice clustering for providers without their own diarization.
    speaker_separation: bool = True
    transcription_providers: list[TranscriptionProviderInfo] = Field(default_factory=list)


class SettingsUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    used_languages: UsedLanguages | None = None

    native_recording_mode: NativeRecordingMode | None = None
    translation_target_language: str | None = Field(
        default=None, min_length=2, max_length=32,
        pattern=r"^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$",
    )
    #: Browser deviceId of the preferred microphone; "" resets to the system default.
    input_device_id: str | None = Field(default=None, max_length=512)
    capture_system_audio: StrictBool | None = None


    #: Provider-scoped API keys, the only way to write a model provider credential.
    #: An omitted provider keeps its stored key; an empty string deletes it.
    provider_keys: dict[CloudProvider, SecretStr] | None = Field(
        default=None, exclude=True, repr=False
    )

    asr: ProfileUpdate | None = None
    agent: ProfileUpdate | None = None
    notes: ProfileUpdate | None = None
    embedding: ProfileUpdate | None = None
    transcript_language: str | None = None
    output_language: str | None = None
    cloud_consent: bool | None = None
    #: Omitted keeps the stored value: enabling is always an explicit user action.
    contextual_local_enabled: bool | None = None
    transcription_provider: TranscriptionProvider | None = None
    local_whisper_model: str | None = Field(default=None, max_length=64)
    openai_transcription_model: str | None = Field(default=None, max_length=64)
    speaker_separation: StrictBool | None = None


#: Preparation state of one local checkpoint. "ready" means the engine loaded from
#: local files with the network closed; "dependency_missing" is deliberately its own
#: state because installing the backend extra, not retrying a download, is the fix.
LocalModelState = Literal[
    "not_installed",
    "loading",  # accepted from older backends; new work reports installing/verifying
    "installing",
    "verifying",
    "ready",
    "error",
    "dependency_missing",
    "unsupported",
]


class Session(BaseModel):
    id: str
    title: str
    created_at: str
    status: SessionStatus
    duration_ms: int
    mode: SessionMode = "legacy"
    origin: Literal["live", "import"] = "live"


class PatchSessionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: SessionStatus | None = None
    title: str | None = None
    # Defaults to the original lifecycle contract. Persistence-first clients can
    # opt out after all captured chunks have received durable local ACKs.
    flush_transcription: bool = True


class SegmentSource(BaseModel):
    sequence: int
    sample_start: int = Field(ge=0)
    sample_end: int = Field(gt=0)
    sha256: str
    source_kind: AudioSourceKind = "original_captured_wav"


class Segment(BaseModel):
    id: str
    start_ms: int
    end_ms: int
    text: str
    language: str | None = None
    sources: list[SegmentSource] = Field(default_factory=list)
