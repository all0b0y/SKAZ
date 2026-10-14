"""Pydantic models of the ingest API (area W1). ``Kb`` prefix, no defaults on responses."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

KbJobState = Literal["running", "done", "failed", "cancelled", "interrupted"]
KbJobStep = Literal["reading", "writing_notes", "concepts", "saving", "done"]
KbEngineId = Literal["codex", "claude_code", "hermes"]


class KbJobLogEntry(BaseModel):
    at: str
    #: Code-written, plain English; never source text.
    message: str


class KbJobProgress(BaseModel):
    parts_total: int
    parts_done: int
    concepts_found: int
    blocks_written: int
    #: Statements left out by the source check (layer 4).
    blocks_dropped: int
    #: Statements blocked as instructions to an AI (layer 5).
    blocks_blocked: int
    concepts_created: int
    concepts_updated: int


class KbJob(BaseModel):
    id: str
    kind: Literal["ingest"]
    material_id: str
    state: KbJobState
    step: KbJobStep | None
    #: The status line of the material: "Reading", "Writing notes", "Concepts 3", "Done", "Failed"…
    label: str
    error: str | None
    #: Failed, cancelled or interrupted: "Retry" starts a new job (``POST /kb/materials/{id}/ingest``).
    can_retry: bool
    progress: KbJobProgress
    journal: list[KbJobLogEntry]
    created_at: str
    updated_at: str


class KbWikiSettings(BaseModel):
    wiki_language: str
    #: False while ``wiki_language`` is the built-in default (onboarding hasn't asked yet).
    wiki_language_chosen: bool
    #: ``null`` = the app's default agent.
    wiki_engine: KbEngineId | None
    auto_add_files_links: bool
    auto_add_text: bool


class KbWikiSettingsUpdate(BaseModel):
    """Only the fields present are changed; ``wiki_engine: null`` returns to the default agent."""

    model_config = ConfigDict(extra="forbid")
    wiki_language: str | None = Field(default=None, min_length=2, max_length=35)
    wiki_engine: KbEngineId | None = None
    auto_add_files_links: bool | None = None
    auto_add_text: bool | None = None
