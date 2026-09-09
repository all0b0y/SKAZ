"""Wire models. Field names are the snake_case contract from docs/API.md."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

Provider = Literal["local-whisper", "openai", "openrouter", "anthropic", "openai-compatible"]
Task = Literal["asr", "agent", "notes"]
SessionStatus = Literal["recording", "paused", "stopped"]
Scope = Literal["auto", "recent", "all", "beginning", "search"]
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
    asr: Profile
    agent: Profile
    notes: Profile
    transcript_language: str = "auto"
    output_language: str = "ru"
    cloud_consent: bool = False


class SettingsUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    asr: ProfileUpdate | None = None
    agent: ProfileUpdate | None = None
    notes: ProfileUpdate | None = None
    transcript_language: str | None = None
    output_language: str | None = None
    cloud_consent: bool | None = None


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


class Session(BaseModel):
    id: str
    title: str
    created_at: str
    status: SessionStatus
    duration_ms: int


class SessionsResponse(BaseModel):
    sessions: list[Session]


class CreateSessionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str


class PatchSessionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: SessionStatus | None = None
    title: str | None = None


class Segment(BaseModel):
    id: str
    start_ms: int
    end_ms: int
    text: str
    language: str | None = None


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
