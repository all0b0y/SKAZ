"""Pydantic models of the agent updates routes (U1). Response models have no defaults (exact TS types)."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from .schemas_agents import KbEngineId

KbUpdateChannel = Literal["npm", "brew", "native", "curl", "git", "unknown"]
KbUpdatePhase = Literal["idle", "queued", "updating"]
KbUpdateAction = Literal["upgrade", "rollback"]
KbUpdateRollback = Literal["skaz", "manual", "none"]


class _Request(BaseModel):
    model_config = ConfigDict(extra="forbid")


class KbAgentUpdateFailure(BaseModel):
    reason: str
    #: The exact command to run in Terminal instead.
    command: str
    #: The last lines the update command printed.
    output: list[str]
    #: The version before the update (what "Roll back to X" installs).
    previous: str | None
    #: ``skaz``: Roll back to X; ``manual``: "roll back manually" + ``docs_url``; ``none``: nothing changed.
    rollback: KbUpdateRollback
    docs_url: str


class KbAgentUpdate(BaseModel):
    engine: KbEngineId
    name: str
    #: How the agent was installed; the latest version is read from the same channel.
    channel: KbUpdateChannel
    installed: str | None
    latest: str | None
    #: "Update available · installed → latest" (newer and not skipped).
    available: bool
    #: Available and not seen in Settings yet: the dot on Settings and its Agents section.
    unseen: bool
    skipped: str | None
    #: The agent runs work now: Update reads "Update after current work".
    busy: bool
    #: ``queued``: waits for the agent's current work; ``updating``: the command runs (``task_id``).
    phase: KbUpdatePhase
    action: KbUpdateAction | None
    task_id: str | None
    #: "Updates Codex for this whole Mac, including Terminal."
    note: str
    #: Hermes: "Running Hermes services keep the old version until you restart them."
    services_note: str | None
    failure: KbAgentUpdateFailure | None
    checked_at: str | None


class KbAgentUpdates(BaseModel):
    #: "Check for agent updates automatically" (on by default; off: no background requests).
    auto: bool
    checking: bool
    #: "Last checked: …" (the last check that reached at least one agent's channel).
    checked_at: str | None
    next_check_at: str | None
    unseen: bool
    agents: list[KbAgentUpdate]


class KbAgentUpdateSettings(_Request):
    auto: bool


class KbAgentUpdateSkip(_Request):
    version: str = Field(min_length=1, max_length=40)
