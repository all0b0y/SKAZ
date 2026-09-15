"""Wire models. Field names are the snake_case contract from docs/API.md."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, SecretStr, model_validator

from .languages import SUPPORTED_LANGUAGES, UsedLanguages

Provider = Literal[
    "local-whisper",
    "local-gigachat-mlx",
    "openai",
    "openrouter",
    "anthropic",
    "openai-compatible",
]
LocalProvider = Literal["local-whisper", "local-gigachat-mlx"]
Task = Literal["asr", "agent", "notes"]
SessionStatus = Literal["recording", "paused", "stopped"]
SessionMode = Literal["legacy", "contextual_local"]
NativeRecordingMode = Literal["transcription", "translation", "audio_only"]
Scope = Literal["auto", "recent", "all", "beginning", "search"]
AudioSourceKind = Literal["original_captured_wav"]
#: "dedicated" — a real speech-to-text endpoint. "legacy" — an audio-input chat
#: model kept as an explicit advanced choice; never evidence of ASR capability.
AsrContract = Literal["dedicated", "legacy"]


class Profile(BaseModel):
    """Sanitised model profile. Never carries an API key."""

    provider: Provider
    model: str
    base_url: str | None = None
    has_api_key: bool = False
    #: True only after this installation completed a successful call with this provider+model.
    verified: bool = False
    verification_note: str | None = None


class ProfileUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provider: Provider | None = None
    model: str | None = None
    base_url: str | None = None
    api_key: str | None = None


class Settings(BaseModel):
    used_languages: UsedLanguages | None = None
    supported_languages: list[str] = Field(default_factory=lambda: list(SUPPORTED_LANGUAGES))
    # Preferences for the next native recording, not a running session's config.
    native_recording_mode: NativeRecordingMode = "transcription"
    translation_target_language: str = "ru"
    soniox_has_api_key: bool = False
    asr: Profile
    agent: Profile
    notes: Profile
    transcript_language: str = "auto"
    output_language: str = "ru"
    cloud_consent: bool = False
    #: Explicit opt-in for the experimental contextual local mode; off by default.
    contextual_local_enabled: bool = False


class SettingsUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    used_languages: UsedLanguages | None = None

    native_recording_mode: NativeRecordingMode | None = None
    translation_target_language: str | None = Field(
        default=None, min_length=2, max_length=32,
        pattern=r"^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$",
    )

    # None/omitted preserves the credential; an empty string explicitly deletes.
    soniox_api_key: SecretStr | None = Field(default=None, exclude=True, repr=False)

    asr: ProfileUpdate | None = None
    agent: ProfileUpdate | None = None
    notes: ProfileUpdate | None = None
    transcript_language: str | None = None
    output_language: str | None = None
    cloud_consent: bool | None = None
    #: Omitted keeps the stored value: enabling is always an explicit user action.
    contextual_local_enabled: bool | None = None


PricingUnit = Literal["second", "minute", "request", "token"]


class CatalogPricing(BaseModel):
    """Pricing only when both the amount and billing unit are explicitly known."""

    amount_usd: float
    unit: PricingUnit


class CatalogModel(BaseModel):
    id: str
    name: str
    input_modalities: list[str] = Field(default_factory=list)
    output_modalities: list[str] = Field(default_factory=list)
    max_output_tokens: int | None = None
    pricing: CatalogPricing | None = None
    #: Set for task=asr only. A picker should default to the "dedicated" group.
    asr_contract: AsrContract | None = None
    recommended: bool = False
    #: True only for a provider+model this installation has actually used successfully.
    verified: bool = False
    note: str | None = None


class ModelsResponse(BaseModel):
    models: list[CatalogModel]
    error: str | None = None


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


class LocalModelProgress(BaseModel):
    stage: Literal["downloading", "verifying"]
    downloaded_bytes: int = Field(default=0, ge=0)
    completed_files: int = Field(default=0, ge=0)
    total_bytes: int | None = Field(default=None, ge=0)
    total_files: int | None = Field(default=None, ge=0)


class LocalModelHardware(BaseModel):
    physical_memory_bytes: int = Field(ge=0)
    required_memory_bytes: int | None = Field(default=None, ge=0)


class PrepareLocalModelRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provider: LocalProvider = "local-whisper"
    #: Must be one of the known local checkpoints; arbitrary ids and paths are rejected.
    model: str


class DeleteLocalModelRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provider: LocalProvider
    model: str
    #: The renderer repeats the exact model id only after an explicit confirmation.
    confirmation_model: str


class LocalModelStatus(BaseModel):
    provider: LocalProvider = "local-whisper"
    model: str
    state: LocalModelState
    #: Sanitised UI text for the failing states; never provider or exception text.
    error: str | None = None
    progress: LocalModelProgress | None = None
    hardware: LocalModelHardware | None = None
    #: Cached repository or partial/lock artifacts exist; independent of runtime readiness.
    cached: bool = False
    #: True for the default Hugging Face cache shared with other applications.
    shared_cache: bool = True
    warning: str | None = None


class DeleteLocalModelResponse(LocalModelStatus):
    deleted: bool
    deleted_bytes: int = Field(ge=0)
    deleted_files: int = Field(ge=0)


class Session(BaseModel):
    id: str
    title: str
    created_at: str
    status: SessionStatus
    duration_ms: int
    mode: SessionMode = "legacy"


class SessionsResponse(BaseModel):
    sessions: list[Session]


class CreateSessionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str
    mode: SessionMode = "legacy"


class LiveAsrCapabilityRequirements(BaseModel):
    local_profile_selected: bool
    #: The persisted user opt-in. False means the mode was never enabled in the UI.
    contextual_local_enabled: bool
    #: Effective runtime capabilities: the opt-in above, or a process-level override.
    live_finality_enabled: bool
    local_speech_gate_enabled: bool


class LiveAsrCapabilities(BaseModel):
    mode: Literal["contextual_local"] = "contextual_local"
    capable: bool
    requirements: LiveAsrCapabilityRequirements
    detail: str


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


class Citation(BaseModel):
    segment_id: str
    start_ms: int
    end_ms: int
    text: str


class Message(BaseModel):
    id: str
    role: Literal["user", "assistant"]
    content: str
    created_at: str
    citations: list[Citation] = Field(default_factory=list)


class Note(BaseModel):
    content: str
    created_at: str
    model: str
    citations: list[Citation] = Field(default_factory=list)


class SessionDetail(BaseModel):
    session: Session
    segments: list[Segment]
    messages: list[Message]
    notes: Note | None = None


class DeleteResponse(BaseModel):
    deleted: bool = True


class AudioResponse(BaseModel):
    segments: list[Segment]
    duplicate: bool
    #: Chunks still waiting for transcription in this session (UI shows the pending count).
    pending: int = 0


AudioChunkStatus = Literal["pending", "failed", "done"]
class StoredAudioResponse(BaseModel):
    sequence: int
    start_ms: int
    end_ms: int
    status: AudioChunkStatus
    available: bool
    duplicate: bool
    source_kind: AudioSourceKind = "original_captured_wav"


class AudioManifestChunk(BaseModel):
    sequence: int
    start_ms: int
    end_ms: int
    status: AudioChunkStatus
    available: bool
    segment_ids: list[str] = Field(default_factory=list)
    source_kind: AudioSourceKind = "original_captured_wav"


class AudioManifestResponse(BaseModel):
    chunks: list[AudioManifestChunk]
    next_after_sequence: int | None = None


class AsrPreviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    first_sequence: int = Field(ge=0, strict=True)
    last_sequence: int = Field(ge=0, strict=True)

    @model_validator(mode="after")
    def validate_order(self) -> AsrPreviewRequest:
        if self.first_sequence > self.last_sequence:
            raise ValueError("first_sequence must be less than or equal to last_sequence")
        return self


class AsrPreviewSource(BaseModel):
    sequence: int
    start_ms: int
    end_ms: int
    sample_rate: int
    sample_count: int
    window_sample_start: int
    window_sample_end: int
    sha256: str
    source_kind: AudioSourceKind = "original_captured_wav"


class AsrPreviewWindow(BaseModel):
    start_ms: int
    end_ms: int
    sample_rate: int
    sample_count: int
    model_input_sample_rate: int
    model_input_sample_count: int
    model_input_kind: Literal["assembled_pcm16_mono_resampled_for_local_whisper"] = (
        "assembled_pcm16_mono_resampled_for_local_whisper"
    )


class AsrPreviewResponse(BaseModel):
    state: Literal["draft"] = "draft"
    text: str
    language: str | None
    provider: Literal["local-whisper"] = "local-whisper"
    model: str
    requested_language: str
    speech_gate_enabled: bool
    window: AsrPreviewWindow
    sources: list[AsrPreviewSource]


class LiveAsrUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    first_sequence: int = Field(ge=0, strict=True)
    last_sequence: int = Field(ge=0, strict=True)
    expected_revision: int = Field(ge=0, strict=True)

    @model_validator(mode="after")
    def validate_order(self) -> LiveAsrUpdateRequest:
        if self.first_sequence > self.last_sequence:
            raise ValueError("first_sequence must be less than or equal to last_sequence")
        return self


LiveAsrFinalityStatus = Literal["disabled", "awaiting_agreement", "stable", "advanced", "blocked"]
LiveAsrDraftTextScope = Literal["unstable_tail", "whole_window"]


class LiveAsrFinality(BaseModel):
    enabled: bool = False
    status: LiveAsrFinalityStatus = "disabled"
    blocked_reason: str | None = None
    stable_frontier_ms: int = Field(default=0, ge=0)
    active_anchor_ms: int | None = Field(default=None, ge=0)
    stable_token_offset: int | None = Field(default=None, ge=0)


class LiveAsrDraftSnapshot(AsrPreviewResponse):
    revision: int = Field(gt=0)
    epoch: int = Field(gt=0)
    updated_at: str
    source_fingerprint: str
    config_fingerprint: str
    config_revision: int = Field(ge=0)
    text_scope: LiveAsrDraftTextScope | None = None
    finality: LiveAsrFinality | None = None


LiveAsrSourceIntegrityStatus = Literal["verified", "missing", "corrupt"]
LiveAsrResumeCompatibilityStatus = Literal[
    "compatible", "config_changed", "source_unavailable"
]


class LiveAsrSourceIntegrity(BaseModel):
    status: LiveAsrSourceIntegrityStatus
    trusted: bool
    detail: str | None = None


class LiveAsrResumeCompatibility(BaseModel):
    status: LiveAsrResumeCompatibilityStatus
    can_resume: bool
    requires_redecode: bool
    detail: str | None = None


class LiveAsrDraftResponse(BaseModel):
    draft: LiveAsrDraftSnapshot | None
    finalized_segments: list[Segment] | None = None
    source_integrity: LiveAsrSourceIntegrity | None = None
    resume_compatibility: LiveAsrResumeCompatibility | None = None


class LiveAsrAdvanceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    through_sequence: int = Field(ge=0, strict=True)


LiveAsrSchedulerState = Literal["idle", "scheduled", "running", "stalled", "complete", "stopped"]
LiveAsrSchedulerBlockReason = Literal[
    "source_missing",
    "source_conflict",
    "source_limit",
    "decoder_busy",
    "live_update_busy",
    "config_changed",
    "session_missing",
    "no_safe_anchor",
    "awaiting_source_extension",
    "finality_blocked",
    "cancelled",
    "decoder_failed",
]


class LiveAsrProcessedWindow(BaseModel):
    first_sequence: int = Field(ge=0)
    last_sequence: int = Field(ge=0)
    start_ms: int = Field(ge=0)
    end_ms: int = Field(ge=0)


class LiveAsrSchedulerStatus(BaseModel):
    capable: bool
    accepted_count: int = Field(ge=0)
    status: LiveAsrSchedulerState
    captured_target_sequence: int | None = Field(default=None, ge=0)
    processed_window: LiveAsrProcessedWindow | None = None
    stable_frontier_ms: int = Field(default=0, ge=0)
    lag_ms: int | None = Field(default=None, ge=0)
    block_reason: LiveAsrSchedulerBlockReason | None = None
    source_ended: bool = False
    recovery_required: bool = False
    available_audio_processed: bool = False
    source_continuity_verified: bool = True


class LiveAsrAdvanceResponse(BaseModel):
    accepted: Literal[True] = True
    scheduler: LiveAsrSchedulerStatus


LiveAsrFragmentState = Literal["open", "complete", "error"]
LiveAsrFragmentIntegrity = Literal["verified", "missing", "corrupt"]
LiveAsrFragmentCompletionProvenance = Literal[
    "live_agreement", "source_ended_final_pass", "ordinary_recovery"
]


class LiveAsrFragment(BaseModel):
    fragment_id: str
    ordinal: int = Field(ge=0)
    start_ms: int = Field(ge=0)
    observed_end_ms: int = Field(gt=0)
    protected_through_ms: int = Field(gt=0)
    text: str
    language: str | None = None
    state: LiveAsrFragmentState
    state_reason: str | None = None
    revision: int = Field(gt=0)
    draft_revision: int = Field(gt=0)
    config_revision: int = Field(ge=0)
    range_fingerprint: str
    protected: bool
    completion_provenance: LiveAsrFragmentCompletionProvenance | None = None
    segment_id: str | None = None
    accepted_at: str | None = None
    source_integrity: LiveAsrFragmentIntegrity
    sources: list[SegmentSource] = Field(default_factory=list)
    can_edit: bool
    edit_disabled_reason: str | None = None
    can_accept: bool
    accept_disabled_reason: str | None = None


class LiveAsrFragmentsResponse(BaseModel):
    fragments: list[LiveAsrFragment]


class EditLiveAsrFragmentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str = Field(min_length=1, max_length=100_000)
    expected_revision: int = Field(gt=0, strict=True)
    range_fingerprint: str = Field(min_length=1)

    @model_validator(mode="after")
    def validate_text(self) -> EditLiveAsrFragmentRequest:
        if not self.text.strip():
            raise ValueError("text must not be blank")
        return self


class AcceptLiveAsrFragmentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_revision: int = Field(gt=0, strict=True)
    range_fingerprint: str = Field(min_length=1)
    idempotency_key: str = Field(min_length=1, max_length=200)


class AskRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    question: str
    window_minutes: int = 5
    scope: Scope = "auto"
    language: str | None = None


class AskContext(BaseModel):
    start_ms: int
    end_ms: int
    scope: str
    #: True when the transcript for the resolved scope did not fit the context budget.
    truncated: bool = False


class AskResponse(BaseModel):
    answer: str
    citations: list[Citation]
    context: AskContext
    model: str


class NotesRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    language: str | None = None
