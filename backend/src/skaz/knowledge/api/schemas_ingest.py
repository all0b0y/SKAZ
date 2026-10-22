"""Pydantic models of the ingest API (area W1). ``Kb`` prefix, no defaults on responses."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from ..ingest.settings import MAX_BUDGET_CHARACTERS, MIN_BUDGET_CHARACTERS

KbJobState = Literal["queued", "running", "done", "failed", "cancelled", "interrupted", "paused"]
KbJobStep = Literal["reading", "checking_recognition", "writing_notes", "concepts", "saving", "done",
                    "checking_discrepancies", "finding_connections", "rechecking", "writing_overview",
                    "exporting"]
KbJobKind = Literal["ingest", "refresh", "recheck", "connections", "folder_overview", "corrections", "export"]
KbEngineId = Literal["codex", "claude_code", "hermes", "opencode"]


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
    #: Notes sections written so far, counted while the answer streams (C1-f).
    notes_sections: int = 0


class KbWikiProcessingProfile(BaseModel):
    # Requested configuration, not an assertion about a provider's actual model.
    engine: KbEngineId | None
    model: str | None
    effort: str | None
    language: str


class KbWikiUsage(BaseModel):
    calls: int
    cache_hits: int
    completed_calls: int
    failed_calls: int
    unknown_usage_calls: int
    input_tokens: int | None
    output_tokens: int | None
    instruction_characters: int
    message_characters: int
    output_characters: int
    duration_ms: int


class KbWikiStageUsage(BaseModel):
    stage: str
    usage: KbWikiUsage


class KbWikiExecution(BaseModel):
    profile: KbWikiProcessingProfile
    root_job_id: str
    usage: KbWikiUsage
    stages: list[KbWikiStageUsage]
    observed_model: str | None
    observed_effort: str | None
    #: C1-d: characters in + out this processing may use before it pauses; ``null`` = no budget.
    budget_characters: int | None = None


class KbJob(BaseModel):
    id: str
    kind: KbJobKind
    #: The material of an ingest/refresh/recheck job; ``null`` for wiki-wide work (connections, overviews).
    material_id: str | None
    state: KbJobState
    step: KbJobStep | None
    #: The status line of the material: "Reading", "Writing notes", "Concepts 3", "Done", "Failed"…
    label: str
    error: str | None
    #: ``AGENT_UNAVAILABLE``: the agent can't work until it is fixed in Settings → Accounts & keys
    #: (signed out, outdated, none connected); a retry alone won't help. ``BUDGET_REACHED``: the job
    #: is ``paused`` at the material's wiki budget; Continue is ``POST /kb/materials/{id}/ingest``.
    #: ``null`` otherwise.
    error_code: str | None
    #: Failed, cancelled or interrupted: "Retry" starts a new job (``POST /kb/materials/{id}/ingest``).
    can_retry: bool
    progress: KbJobProgress
    execution: KbWikiExecution | None
    journal: list[KbJobLogEntry]
    created_at: str
    updated_at: str
    #: When the current step began, while the job runs (the live "3:20" on the material, C1-f).
    step_started_at: str | None = None


class KbWikiChoice(BaseModel):
    model: str
    effort: str | None


class KbWikiSettings(BaseModel):
    wiki_language: str
    #: False while ``wiki_language`` is the built-in default (onboarding hasn't asked yet).
    wiki_language_chosen: bool
    #: ``null`` = the app's default agent.
    wiki_engine: KbEngineId | None
    wiki_model: str | None
    wiki_effort: str | None
    #: The last model and reasoning chosen for each agent; choosing that agent again restores them.
    wiki_remembered: dict[KbEngineId, KbWikiChoice]
    auto_add_files_links: bool
    auto_add_text: bool
    #: Look for connections across the whole wiki in the background when SKAZ is idle (user's permission).
    background_connections: bool
    #: Apply confident recognition corrections automatically; doubtful ones are only highlighted.
    auto_corrections: bool
    #: C1-d "Wiki budget per material": characters in + out of the model for one material's
    #: processing (with its connections) before it pauses for Continue.
    wiki_budget_characters: int


class KbWikiSettingsUpdate(BaseModel):
    """Only the fields present are changed; ``wiki_engine: null`` returns to the default agent."""

    model_config = ConfigDict(extra="forbid")
    wiki_language: str | None = Field(default=None, min_length=2, max_length=35)
    wiki_engine: KbEngineId | None = None
    wiki_model: str | None = Field(default=None, min_length=1, max_length=1024)
    wiki_effort: str | None = Field(default=None, min_length=1, max_length=64)
    auto_add_files_links: bool | None = None
    auto_add_text: bool | None = None
    background_connections: bool | None = None
    auto_corrections: bool | None = None
    wiki_budget_characters: int | None = Field(default=None, ge=MIN_BUDGET_CHARACTERS,
                                               le=MAX_BUDGET_CHARACTERS)
