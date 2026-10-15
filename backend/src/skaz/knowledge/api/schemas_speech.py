"""Pydantic models of the speech routes (``/kb/recordings``, ``/kb/imports``)."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from ..markdown.source import MaterialStatus

KbSpeechKind = Literal["recording", "audio", "video", "video_link"]
KbRecordingState = Literal["recording", "processing", "paused", "stopped"]
KbImportState = Literal["running", "completed", "failed", "interrupted", "cancelled"]


class _Request(BaseModel):
    model_config = ConfigDict(extra="forbid")


class KbRecordingCreate(_Request):
    #: ``null`` = the last used folder, else Inbox.
    folder_id: str | None = Field(default=None, max_length=64)
    #: ``null`` = ``Recording <Mon D, YYYY HH.MM>``.
    title: str | None = Field(default=None, min_length=1, max_length=200)


class KbImportCreate(_Request):
    #: An absolute path the user picked in the file dialog (audio or video). Exactly one of path/url.
    path: str | None = Field(default=None, min_length=1, max_length=4096)
    #: A single public video link.
    url: str | None = Field(default=None, min_length=1, max_length=4096)
    folder_id: str | None = Field(default=None, max_length=64)
    #: ``null`` = the file name / the video's title.
    title: str | None = Field(default=None, min_length=1, max_length=200)
    translate: bool = False
    #: Spoken language hint for this import (``null`` = the saved setting).
    language: str | None = Field(default=None, min_length=2, max_length=8)
    #: The same video was imported before: import it again anyway.
    allow_duplicate: bool = False


class KbSpeechMaterial(BaseModel):
    """A speech material and the recording/import that feeds it."""

    material_id: str
    #: The technical session the recorder streams to (``/sessions/{id}/live/stream``).
    session_id: str
    kind: KbSpeechKind
    title: str
    folder_id: str
    status: MaterialStatus
    fragment_count: int
    created_at: str
    #: Recordings: what the recorder does now; ``null`` for imports.
    recording_state: KbRecordingState | None
    #: Imports: ``null`` for recordings.
    import_state: KbImportState | None
    #: The import's current step (``queued``, ``downloading``, ``processing``, …).
    import_stage: str | None
    #: The last attempt's problem in plain English; text received before it is kept.
    error: str | None


class KbSpeechDefaults(BaseModel):
    #: Where a new recording/import goes when no folder is chosen (last used, else Inbox).
    folder_id: str


class KbDictation(BaseModel):
    """``POST /kb/dictation``: the recognised text; nothing was stored."""

    text: str
    #: The language recognised (or asked for); ``null`` when unknown.
    language: str | None
    provider: Literal["soniox", "local_whisper"]
