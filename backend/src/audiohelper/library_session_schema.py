"""Versioned session documents; no SQL names or executable objects on the wire."""
from __future__ import annotations

from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, field_validator

from .library_notes import NoteRegistration, _identity
from .schemas import Citation, SessionMode, SessionStatus


def _id(value: str) -> str:
    if not _identity(value):
        raise ValueError("Invalid portable identity")
    return value


Identity = Annotated[str, AfterValidator(_id)]
Counter = Annotated[int, Field(ge=0)]


class DocumentModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)


class SessionMetadata(DocumentModel):
    id: Identity
    title: str
    created_at: str
    status: SessionStatus
    duration_ms: Counter
    mode: SessionMode
    source_revision: Counter


class ArchiveCitation(Citation):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)


class NoteMetadata(DocumentModel):
    id: Identity
    relative_path: str
    content_sha256: str
    created_at: str
    updated_at: str | None
    revision: Annotated[int, Field(ge=1)]
    source_revision: Counter | None
    model: str
    citations: list[ArchiveCitation]

    @field_validator("citations", mode="before")
    @classmethod
    def citations_are_objects(cls, value: object) -> object:
        # Citation is an existing API type with permissive extras. Refuse fields
        # it would silently discard rather than claiming a lossless round trip.
        if isinstance(value, list):
            for citation in value:
                if isinstance(citation, dict) and set(citation) - Citation.model_fields.keys():
                    raise ValueError("Unknown citation fields")
        return value

    def registration(self) -> NoteRegistration:
        return NoteRegistration(self.id, self.relative_path, self.content_sha256)


class StoredMessage(DocumentModel):
    id: Identity
    role: Literal["user", "assistant"]
    content: str
    created_at: str
    citations: list[ArchiveCitation]


class TranscriptRevision(DocumentModel):
    revision: Annotated[int, Field(ge=1)]
    text: str
    origin: Literal["soniox", "user"]


class StoredSegment(DocumentModel):
    id: Identity
    sequence: int
    start_ms: Counter
    end_ms: Counter
    text: str
    language: str | None
    created_at: str
    revisions: list[TranscriptRevision]


class NativeToken(DocumentModel):
    text: str
    confidence: Annotated[float, Field(ge=0, le=1)]
    is_final: bool
    language: str | None
    speaker: str | None = None
    source_language: str | None = None
    start_ms: Counter | None = None
    end_ms: Counter | None = None
    id: str | None = None
    connection_id: Identity | None = None
    segment_id: Identity | None = None
    speaker_number: Annotated[int, Field(ge=1)] | None = None
    start_sample: Counter | None = None
    end_sample: Counter | None = None
    translation_status: Literal["original", "none", "translation"] | None = None


class NativeEvent(DocumentModel):
    ordinal: Counter
    digest: Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
    segment_ids: list[Identity]
    originals: list[NativeToken] | None
    translations: list[NativeToken] | None
    stream: list[NativeToken] | None


class SpeakerMetadata(DocumentModel):
    provider_id: str
    number: Annotated[int, Field(ge=1)]


class NativeConnection(DocumentModel):
    id: Identity
    start_sample: Counter
    end_sample: Counter | None
    model: str
    status: Literal["active", "finished", "incomplete"]
    final_sample: Counter
    processed_sample: Counter
    next_event: Counter
    draft: list[NativeToken]
    translation_draft: list[NativeToken]
    stream_draft: list[NativeToken]
    speakers: list[SpeakerMetadata]
    events: list[NativeEvent]


class TransportReceipt(DocumentModel):
    sequence: Counter
    start_sample: Counter
    end_sample: Counter
    digest: Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]


class NativeRecording(DocumentModel):
    sample_rate: Annotated[int, Field(ge=8000, le=48000)]
    saved_samples: Counter
    next_sequence: Counter
    recording_mode: Literal["transcription", "translation", "audio_only"]
    translation_target_language: str
    used_languages: list[str] | None
    origin: Literal["live"]
    connections: list[NativeConnection]
    receipt: TransportReceipt | None


class SessionDocument(DocumentModel):
    format: Literal["skaz.session"]
    version: Literal[1]
    session: SessionMetadata
    notes: list[NoteMetadata]
    messages: list[StoredMessage]
    segments: list[StoredSegment]
    native: NativeRecording | None

    @field_validator("version", mode="before")
    @classmethod
    def integer_version(cls, value: object) -> object:
        if type(value) is not int:
            raise ValueError("Version must be an integer")
        return value

    @field_validator("notes")
    @classmethod
    def unique_notes(cls, value: list[NoteMetadata]) -> list[NoteMetadata]:
        registrations = [note.registration() for note in value]
        if (len({n.id for n in registrations}) != len(value)
                or len({n.relative_path for n in registrations}) != len(value)):
            raise ValueError("Duplicate note registration")
        return value
